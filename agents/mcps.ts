#!/usr/bin/env node

import { sanitizeDiagnostic } from "../lib/diagnostics.ts";

import { resolve } from "node:path";
import { Effect, Schema } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import { decodeOr, decodeOrThrow } from "./decode.ts";
import {
  HARNESS_INFO,
  HARNESSES,
  harnessPresent,
  LockedHarnesses,
  parseSyncArgs,
  reportSyncFailures,
  SafeName,
} from "./harness.ts";
import type { Harness, SyncFailure } from "./harness.ts";
import { expandHeadersHelper, readLayeredMcps } from "./mcps/catalog.ts";
import type { Mcp } from "./mcps/catalog.ts";
import { claudeAuthMatches } from "./mcps/claude-config.ts";
import { codexCallbackUrl, codexOAuthMatches } from "./mcps/codex-config.ts";
import { planOwnership } from "./ownership.ts";
import {
  guardOverlay,
  managedLockLocation,
  withManagedLock,
  readLockFile,
  readOverlayOwnership,
  writeLockFile,
} from "./lock.ts";
import type { OverlayOwnership } from "./lock.ts";
import { createRuntime, errorMessage, resolveProfileName, writeLine } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";

type McpFailure = SyncFailure;

const LockedMcpIdentity = Schema.Struct({ name: SafeName });

const LockedMcp = Schema.Struct({ name: SafeName, harnesses: LockedHarnesses });

type LockedMcp = typeof LockedMcp.Type;

const McpLockDocument = Schema.Struct({
  version: Schema.Literal(1),
  mcps: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  servers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

type McpLock = {
  version: 1;
  mcps: Array<LockedMcp>;
  overlays?: OverlayOwnership;
};

function readMcpLock(lockPath: string): Array<LockedMcp> | undefined {
  const parsed = readLockFile(lockPath, "MCP");

  if (parsed === undefined) {
    return undefined;
  }

  const label = `Invalid managed MCP lock at ${lockPath}`;
  const shapeMessage = `${label}: expected version 1 and an mcps array`;
  const lock = decodeOr(McpLockDocument, parsed, shapeMessage);
  const entries = lock.mcps ?? lock.servers;

  if (entries === undefined) {
    throw new Error(shapeMessage);
  }

  const mcps = entries.map((mcp, index) => {
    const { name } = decodeOr(
      LockedMcpIdentity,
      mcp,
      `${label}: mcps[${index}] must have a safe name`,
    );

    return decodeOrThrow(LockedMcp, mcp, (detail) => `${label}: ${name} ${detail}`);
  });

  const names = mcps.map((mcp) => mcp.name);

  if (new Set(names).size !== names.length) {
    throw new Error(`${label}: MCP names must be unique`);
  }

  return mcps;
}

function writeMcpLock(
  lockPath: string,
  mcps: ReadonlyArray<LockedMcp>,
  overlays?: OverlayOwnership,
): void {
  const lock: McpLock = { version: 1, mcps: [...mcps], overlays };
  writeLockFile(lockPath, lock);
}

const mcpName = (mcp: { name: string; harnesses: ReadonlyArray<Harness> }) => mcp.name;

function withKept(
  next: ReadonlyArray<LockedMcp>,
  kept: ReadonlyArray<LockedMcp>,
): Array<LockedMcp> {
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

function mcpRemoveArgs(harness: Harness, name: string): Array<string> {
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
  args: ReadonlyArray<string>,
  failures: Array<McpFailure>,
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

function applyCodex(runtime: Runtime, mcps: ReadonlyArray<Mcp>, failures: Array<McpFailure>): void {
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

    const matches = (result: { status: number; stdout: string }) =>
      result.status === 0 &&
      result.stdout.includes(configuredUrl) &&
      codexOAuthMatches(runtime.env, mcp.name, mcp.oauth);

    const existing = runtime.run("codex", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });

    if (matches(existing)) {
      writeLine(runtime.stdout, `${label}: ${mcp.name} is already configured`);
      continue;
    }

    const addArgs = codexAddArgs(mcp);
    writeLine(runtime.stdout, `${label}: codex ${addArgs.join(" ")}`);
    const added = runtime.run("codex", addArgs, { stdout: "capture", stderr: "capture" });

    if (added.status === 0) {
      continue;
    }

    const converged = runtime.run("codex", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });

    if (matches(converged)) {
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

function codexAddArgs(mcp: Mcp): Array<string> {
  if (mcp.oauth === undefined) {
    return ["mcp", "add", mcp.name, "--url", mcp.url];
  }

  return [
    "mcp",
    "add",
    "-c",
    `mcp_oauth_callback_url=${JSON.stringify(codexCallbackUrl(mcp.oauth))}`,
    mcp.name,
    "--url",
    mcp.url,
    "--oauth-client-id",
    mcp.oauth.clientId,
  ];
}

function claudeAddArgs(mcp: Mcp, headersHelper: string | undefined): Array<string> {
  if (headersHelper === undefined && mcp.oauth === undefined) {
    return ["mcp", "add", "-t", "http", "-s", "user", mcp.name, mcp.url];
  }

  const config = JSON.stringify({
    type: "http",
    url: mcp.url,
    headersHelper,
    oauth: mcp.oauth,
  });

  return ["mcp", "add-json", "-s", "user", mcp.name, config];
}

function applyClaude(
  runtime: Runtime,
  mcps: ReadonlyArray<Mcp>,
  failures: Array<McpFailure>,
): void {
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
    const headersHelper =
      mcp.headersHelper === undefined
        ? undefined
        : expandHeadersHelper(mcp.headersHelper, runtime.env.HOME);

    const existing = runtime.run("claude", ["mcp", "get", mcp.name], {
      stdout: "capture",
      stderr: "capture",
    });

    if (existing.status === 0) {
      if (
        existing.stdout.includes(`URL: ${mcp.url}\n`) &&
        claudeAuthMatches(runtime.env, mcp.name, headersHelper, mcp.oauth)
      ) {
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

    runPlanned(runtime, label, "claude", claudeAddArgs(mcp, headersHelper), failures);
  }
}

function removeStaleMcps(
  runtime: Runtime,
  stale: ReadonlyArray<LockedMcp>,
  failures: Array<McpFailure>,
): Array<LockedMcp> {
  const leftover: Array<LockedMcp> = [];

  for (const mcp of stale) {
    const leftoverHarnesses: Array<Harness> = [];

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
  const scriptDir = import.meta.dirname;
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

  if (localPath) {
    writeLine(runtime.stdout, `Local overlay: ${localPath}`);
  }

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

  const failures: Array<McpFailure> = [];

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

function reportMcpFailures(runtime: Runtime, failures: ReadonlyArray<McpFailure>): 1 {
  return reportSyncFailures(runtime, failures, "MCP sync", ["command", "commands"], "MCP");
}

export function main(args: ReadonlyArray<string>, runtime: Runtime = createRuntime()): number {
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

if (entrypoint !== undefined && resolve(entrypoint) === import.meta.filename) {
  runMain(
    Effect.sync(() => {
      process.exitCode = main(process.argv.slice(2));
    }),
  );
}
