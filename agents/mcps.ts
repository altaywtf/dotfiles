#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import {
  type Harness,
  HARNESS_INFO,
  HARNESSES,
  harnessPresent,
  isSafeName,
  parseSyncArgs,
  readHarnesses,
  reportSyncFailures,
  type SyncFailure,
} from "./harness.ts";
import { type Mcp, readLayeredMcps } from "./mcps/catalog.ts";
import { planOwnership } from "./ownership.ts";
import {
  guardOverlay,
  managedLockLocation,
  withManagedLock,
  readLockFile,
  readOverlayOwnership,
  writeLockFile,
  type OverlayOwnership,
} from "./lock.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

type McpFailure = SyncFailure;

type LockedMcp = {
  name: string;
  harnesses: readonly Harness[];
};

type McpLock = {
  version: 1;
  mcps: LockedMcp[];
  overlays?: OverlayOwnership;
};

function readMcpLock(lockPath: string): LockedMcp[] | undefined {
  const parsed = readLockFile(lockPath, "MCP");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1
  ) {
    throw new Error(
      `Invalid managed MCP lock at ${lockPath}: expected version 1 and an mcps array`,
    );
  }
  // Locks written before the rename keep their entries under `servers`; the
  // next write stores them as `mcps`.
  const entries = "mcps" in parsed ? parsed.mcps : "servers" in parsed ? parsed.servers : undefined;
  if (!Array.isArray(entries)) {
    throw new Error(
      `Invalid managed MCP lock at ${lockPath}: expected version 1 and an mcps array`,
    );
  }

  const mcps = entries.map((mcp: unknown, index) => {
    if (
      typeof mcp !== "object" ||
      mcp === null ||
      !("name" in mcp) ||
      typeof mcp.name !== "string" ||
      !isSafeName(mcp.name)
    ) {
      throw new Error(
        `Invalid managed MCP lock at ${lockPath}: mcps[${index}] must have a safe name`,
      );
    }
    return {
      name: mcp.name,
      harnesses: readHarnesses(
        "harnesses" in mcp ? mcp.harnesses : undefined,
        `Invalid managed MCP lock at ${lockPath}: ${mcp.name} harnesses must be an explicit unique non-empty subset of ${HARNESSES.join(", ")}`,
      ),
    };
  });
  const names = mcps.map((mcp) => mcp.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed MCP lock at ${lockPath}: MCP names must be unique`);
  }
  return mcps;
}

function writeMcpLock(
  lockPath: string,
  mcps: readonly LockedMcp[],
  overlays?: OverlayOwnership,
): void {
  const lock: McpLock = { version: 1, mcps: [...mcps], ...(overlays ? { overlays } : {}) };
  writeLockFile(lockPath, lock);
}

const mcpName = (mcp: { name: string; harnesses: readonly Harness[] }) => mcp.name;

// Another checkout's overlay keeps its harnesses even when this checkout selects the same name.
function withKept(next: readonly LockedMcp[], kept: readonly LockedMcp[]): LockedMcp[] {
  const merged = new Map(next.map((mcp) => [mcp.name, mcp]));
  for (const mcp of kept) {
    const current = merged.get(mcp.name);
    merged.set(mcp.name, {
      name: mcp.name,
      harnesses: HARNESSES.filter(
        (harness) => mcp.harnesses.includes(harness) || current?.harnesses.includes(harness),
      ),
    });
  }
  return [...merged.values()];
}

function mcpRemoveArgs(harness: Harness, name: string): string[] {
  switch (harness) {
    case "claude":
      return ["mcp", "remove", "-s", "user", name];
    case "codex":
      return ["mcp", "remove", name];
  }
}

function runPlanned(
  runtime: Runtime,
  label: string,
  binary: string,
  args: readonly string[],
  failures: McpFailure[],
): boolean {
  writeLine(runtime.stdout, `${label}: ${binary} ${args.join(" ")}`);
  const result = runtime.run(binary, args, { stdout: "capture", stderr: "capture" });
  if (result.status !== 0) {
    failures.push({
      diagnostic: sanitizeDiagnostic(`${result.stdout}\n${result.stderr}`),
      summary: `${label}: ${args.join(" ")} (exit ${result.status})`,
    });
    return false;
  }
  return true;
}

// `codex mcp add` upserts the config but then probes the mcp and can start an
// interactive OAuth login, so converge through get: a matching URL is a no-op,
// and an add whose config landed before the login step failed is a warning.
function applyCodex(runtime: Runtime, mcps: readonly Mcp[], failures: McpFailure[]): void {
  const label = "Codex";
  const selected = mcps.filter((mcp) => mcp.harnesses.includes("codex"));

  if (!runtime.commandExists("codex")) {
    writeLine(runtime.stdout, `Skipping ${label} MCPs: 'codex' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCPs are selected for this profile`);
    return;
  }

  for (const mcp of selected) {
    const configuredUrl = `url: ${mcp.url}\n`;
    const existing = runtime.run("codex", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0 && existing.stdout.includes(configuredUrl)) {
      writeLine(runtime.stdout, `${label}: ${mcp.name} is already configured`);
      continue;
    }

    const addArgs = ["mcp", "add", mcp.name, "--url", mcp.url];
    writeLine(runtime.stdout, `${label}: codex ${addArgs.join(" ")}`);
    const added = runtime.run("codex", addArgs, { stdout: "capture", stderr: "capture" });
    if (added.status === 0) {
      continue;
    }

    const converged = runtime.run("codex", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (converged.status === 0 && converged.stdout.includes(configuredUrl)) {
      writeLine(
        runtime.stdout,
        `${label}: ${mcp.name} is configured, but its login did not finish; run 'codex mcp login ${mcp.name}' if the mcp needs one`,
      );
      continue;
    }
    failures.push({
      diagnostic: sanitizeDiagnostic(`${added.stdout}\n${added.stderr}`),
      summary: `${label}: ${addArgs.join(" ")} (exit ${added.status})`,
    });
  }
}

// `claude mcp add` refuses an existing name instead of updating it, so converge
// through get: matching URL is a no-op, anything else is removed and re-added.
function applyClaude(runtime: Runtime, mcps: readonly Mcp[], failures: McpFailure[]): void {
  const label = "Claude Code";
  const selected = mcps.filter((mcp) => mcp.harnesses.includes("claude"));

  if (!runtime.commandExists("claude")) {
    writeLine(runtime.stdout, `Skipping ${label} MCPs: 'claude' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCPs are selected for this profile`);
    return;
  }

  for (const mcp of selected) {
    const existing = runtime.run("claude", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0) {
      if (existing.stdout.includes(`URL: ${mcp.url}\n`)) {
        writeLine(runtime.stdout, `${label}: ${mcp.name} is already configured`);
        continue;
      }
      const removed = runPlanned(
        runtime,
        label,
        "claude",
        ["mcp", "remove", "-s", "user", mcp.name],
        failures,
      );
      if (!removed) {
        continue;
      }
    }
    runPlanned(
      runtime,
      label,
      "claude",
      ["mcp", "add", "-t", "http", "-s", "user", mcp.name, mcp.url],
      failures,
    );
  }
}

function removeStaleMcps(
  runtime: Runtime,
  stale: readonly LockedMcp[],
  failures: McpFailure[],
): LockedMcp[] {
  const leftover: LockedMcp[] = [];

  for (const mcp of stale) {
    const leftoverHarnesses: Harness[] = [];
    for (const harness of mcp.harnesses) {
      const { binary, label } = HARNESS_INFO[harness];
      if (!runtime.commandExists(binary)) {
        leftoverHarnesses.push(harness);
        writeLine(runtime.stdout, `Skipping ${label} MCP removal: '${binary}' is not installed`);
        continue;
      }

      const args = mcpRemoveArgs(harness, mcp.name);
      writeLine(runtime.stdout, `Removing stale managed MCP: ${mcp.name} from ${label}`);
      const removed = runPlanned(runtime, label, binary, args, failures);
      if (!removed) {
        leftoverHarnesses.push(harness);
      }
    }

    if (leftoverHarnesses.length > 0) {
      leftover.push({ name: mcp.name, harnesses: leftoverHarnesses });
    }
  }

  return leftover;
}

type McpOptions = {
  profile?: string;
};

const USAGE = "Usage: ./agents/mcps.ts [--profile PROFILE]";

function apply(runtime: Runtime, options: McpOptions): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, options.profile);

  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { layers, mcps, localPath, localNames } = readLayeredMcps(
    repoDir,
    profileName,
    profile.agentLayers,
  );

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `MCP layers: ${layers.join(", ")}`);
  if (localPath) writeLine(runtime.stdout, `Local overlay: ${localPath}`);

  const mcpLockPath = managedLockLocation(runtime.env, "mcps");
  const previouslyManaged = readMcpLock(mcpLockPath);
  const overlay = guardOverlay(readOverlayOwnership(mcpLockPath), repoDir, localNames);
  const keptOverlay = (previouslyManaged ?? []).filter((mcp) => overlay.kept.has(mcp.name));
  const ownership = planOwnership({
    previous: (previouslyManaged ?? []).filter((mcp) => !keptOverlay.includes(mcp)),
    selected: mcps.map((mcp) => ({ name: mcp.name, harnesses: mcp.harnesses })),
    available: HARNESSES.filter((harness) => runtime.commandExists(HARNESS_INFO[harness].binary)),
    keyOf: mcpName,
  });

  const failures: McpFailure[] = [];
  for (const harness of HARNESSES) {
    if (harness === "claude") {
      applyClaude(runtime, mcps, failures);
    } else {
      applyCodex(runtime, mcps, failures);
    }
  }

  if (failures.length > 0) {
    return reportMcpFailures(runtime, failures);
  }

  if (previouslyManaged === undefined) {
    if (!harnessPresent(runtime)) {
      writeLine(runtime.stdout, "No managed MCP lock found; skipping ownership initialization");
      writeLine(runtime.stdout, "Done.");
      return 0;
    }
    writeLine(runtime.stdout, "Initializing managed MCP lock without removing existing MCPs");
    writeMcpLock(mcpLockPath, withKept(ownership.nextLock([]), keptOverlay), overlay.next);
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const deferred = removeStaleMcps(runtime, ownership.removals, failures);
  if (failures.length > 0) {
    return reportMcpFailures(runtime, failures);
  }

  writeMcpLock(mcpLockPath, withKept(ownership.nextLock(deferred), keptOverlay), overlay.next);
  writeLine(runtime.stdout, "Done.");
  return 0;
}

function reportMcpFailures(runtime: Runtime, failures: readonly McpFailure[]): 1 {
  return reportSyncFailures(runtime, failures, "MCP sync", ["command", "commands"], "MCP");
}

export function main(args: readonly string[], runtime: Runtime = createRuntime()): number {
  const parsed = parseSyncArgs(args, USAGE, false);
  if (parsed.kind === "help") {
    writeLine(runtime.stdout, USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    writeLine(runtime.stderr, parsed.message);
    return 2;
  }

  try {
    return withManagedLock(runtime.env, "mcps", () => apply(runtime, { profile: parsed.profile }));
  } catch (error) {
    writeLine(runtime.stderr, `MCP sync failed: ${errorMessage(error)}`);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  runMain(
    Effect.sync(() => {
      process.exitCode = main(process.argv.slice(2));
    }),
  );
}
