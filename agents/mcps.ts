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
  onlyRetiredHarnesses,
  readHarnesses,
  reportSyncFailures,
  type SyncFailure,
  withoutRetiredHarnesses,
} from "./harness.ts";
import { type McpServer, readLayeredServers } from "./mcps/catalog.ts";
import { planOwnership } from "./ownership.ts";
import {
  guardOverlay,
  managedLockPath,
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

type LockedServer = {
  name: string;
  harnesses: readonly Harness[];
};

type McpLock = {
  version: 1;
  servers: LockedServer[];
  overlays?: OverlayOwnership;
};

function readServerLock(lockPath: string): LockedServer[] | undefined {
  const parsed = readLockFile(lockPath, "MCP");
  if (parsed === undefined) {
    return undefined;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("servers" in parsed) ||
    !Array.isArray(parsed.servers)
  ) {
    throw new Error(
      `Invalid managed MCP lock at ${lockPath}: expected version 1 and a servers array`,
    );
  }

  const servers = parsed.servers.flatMap((server, index) => {
    if (
      typeof server !== "object" ||
      server === null ||
      !("name" in server) ||
      typeof server.name !== "string" ||
      !isSafeName(server.name)
    ) {
      throw new Error(
        `Invalid managed MCP lock at ${lockPath}: servers[${index}] must have a safe name`,
      );
    }
    const harnesses = "harnesses" in server ? server.harnesses : undefined;
    if (onlyRetiredHarnesses(harnesses)) {
      return [];
    }
    return {
      name: server.name,
      harnesses: readHarnesses(
        withoutRetiredHarnesses(harnesses),
        `Invalid managed MCP lock at ${lockPath}: ${server.name} harnesses must be an explicit unique non-empty subset of ${HARNESSES.join(", ")}`,
      ),
    };
  });
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`Invalid managed MCP lock at ${lockPath}: server names must be unique`);
  }
  return servers;
}

function writeServerLock(
  lockPath: string,
  servers: readonly LockedServer[],
  overlays?: OverlayOwnership,
): void {
  const lock: McpLock = { version: 1, servers: [...servers], ...(overlays ? { overlays } : {}) };
  writeLockFile(lockPath, lock);
}

const serverName = (server: { name: string; harnesses: readonly Harness[] }) => server.name;

function mcpRemoveArgs(harness: Harness, name: string): string[] {
  switch (harness) {
    case "claude":
      return ["mcp", "remove", "-s", "user", name];
    case "codex":
      return ["mcp", "remove", name];
    case "grok":
      return ["mcp", "remove", "-s", "user", name];
  }
}

type CommandHarness = Exclude<Harness, "claude" | "codex">;

type CommandSpec = {
  binary: string;
  label: string;
  addArgs(server: McpServer): string[];
};

// grok `mcp add` is a plain config upsert: re-adding a name updates it.
const COMMAND_SPECS: Record<CommandHarness, CommandSpec> = {
  grok: {
    binary: "grok",
    label: "Grok",
    addArgs: (server) => ["mcp", "add", "-t", "http", "-s", "user", server.name, server.url],
  },
};

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

function applyCommandHarness(
  runtime: Runtime,
  harness: CommandHarness,
  servers: readonly McpServer[],
  failures: McpFailure[],
): void {
  const spec = COMMAND_SPECS[harness];
  const selected = servers.filter((server) => server.harnesses.includes(harness));

  if (!runtime.commandExists(spec.binary)) {
    writeLine(
      runtime.stdout,
      `Skipping ${spec.label} MCP servers: '${spec.binary}' is not installed`,
    );
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${spec.label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    runPlanned(runtime, spec.label, spec.binary, spec.addArgs(server), failures);
  }
}

// `codex mcp add` upserts the config but then probes the server and can start an
// interactive OAuth login, so converge through get: a matching URL is a no-op,
// and an add whose config landed before the login step failed is a warning.
function applyCodex(runtime: Runtime, servers: readonly McpServer[], failures: McpFailure[]): void {
  const label = "Codex";
  const selected = servers.filter((server) => server.harnesses.includes("codex"));

  if (!runtime.commandExists("codex")) {
    writeLine(runtime.stdout, `Skipping ${label} MCP servers: 'codex' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    const configuredUrl = `url: ${server.url}\n`;
    const existing = runtime.run("codex", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0 && existing.stdout.includes(configuredUrl)) {
      writeLine(runtime.stdout, `${label}: ${server.name} is already configured`);
      continue;
    }

    const addArgs = ["mcp", "add", server.name, "--url", server.url];
    writeLine(runtime.stdout, `${label}: codex ${addArgs.join(" ")}`);
    const added = runtime.run("codex", addArgs, { stdout: "capture", stderr: "capture" });
    if (added.status === 0) {
      continue;
    }

    const converged = runtime.run("codex", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (converged.status === 0 && converged.stdout.includes(configuredUrl)) {
      writeLine(
        runtime.stdout,
        `${label}: ${server.name} is configured, but its login did not finish; run 'codex mcp login ${server.name}' if the server needs one`,
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
function applyClaude(
  runtime: Runtime,
  servers: readonly McpServer[],
  failures: McpFailure[],
): void {
  const label = "Claude Code";
  const selected = servers.filter((server) => server.harnesses.includes("claude"));

  if (!runtime.commandExists("claude")) {
    writeLine(runtime.stdout, `Skipping ${label} MCP servers: 'claude' is not installed`);
    return;
  }
  if (selected.length === 0) {
    writeLine(runtime.stdout, `No ${label} MCP servers are selected for this profile`);
    return;
  }

  for (const server of selected) {
    const existing = runtime.run("claude", ["mcp", "get", server.name], {
      stdout: "capture",
      stderr: "capture",
    });
    if (existing.status === 0) {
      if (existing.stdout.includes(`URL: ${server.url}\n`)) {
        writeLine(runtime.stdout, `${label}: ${server.name} is already configured`);
        continue;
      }
      const removed = runPlanned(
        runtime,
        label,
        "claude",
        ["mcp", "remove", "-s", "user", server.name],
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
      ["mcp", "add", "-t", "http", "-s", "user", server.name, server.url],
      failures,
    );
  }
}

function removeStaleServers(
  runtime: Runtime,
  stale: readonly LockedServer[],
  failures: McpFailure[],
): LockedServer[] {
  const leftover: LockedServer[] = [];

  for (const server of stale) {
    const leftoverHarnesses: Harness[] = [];
    for (const harness of server.harnesses) {
      const { binary, label } = HARNESS_INFO[harness];
      if (!runtime.commandExists(binary)) {
        leftoverHarnesses.push(harness);
        writeLine(runtime.stdout, `Skipping ${label} MCP removal: '${binary}' is not installed`);
        continue;
      }

      const args = mcpRemoveArgs(harness, server.name);
      writeLine(runtime.stdout, `Removing stale managed MCP server: ${server.name} from ${label}`);
      const removed = runPlanned(runtime, label, binary, args, failures);
      if (!removed) {
        leftoverHarnesses.push(harness);
      }
    }

    if (leftoverHarnesses.length > 0) {
      leftover.push({ name: server.name, harnesses: leftoverHarnesses });
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
  const { layers, servers, localPath, localNames } = readLayeredServers(
    repoDir,
    profileName,
    profile.agentLayers,
  );

  writeLine(runtime.stdout, `Profile: ${profileName}`);
  writeLine(runtime.stdout, `MCP layers: ${layers.join(", ")}`);
  if (localPath) writeLine(runtime.stdout, `Local overlay: ${localPath}`);

  const mcpLockPath = managedLockPath(runtime.env, repoDir, "mcps");
  const previouslyManaged = readServerLock(mcpLockPath);
  const overlay = guardOverlay(readOverlayOwnership(mcpLockPath), repoDir, localNames);
  const selectedNames = new Set(servers.map((server) => server.name));
  const keptOverlay = (previouslyManaged ?? []).filter(
    (server) => !selectedNames.has(server.name) && overlay.kept.has(server.name),
  );
  const ownership = planOwnership({
    previous: (previouslyManaged ?? []).filter((server) => !keptOverlay.includes(server)),
    selected: servers.map((server) => ({ name: server.name, harnesses: server.harnesses })),
    available: HARNESSES.filter((harness) => runtime.commandExists(HARNESS_INFO[harness].binary)),
    keyOf: serverName,
  });

  const failures: McpFailure[] = [];
  for (const harness of HARNESSES) {
    if (harness === "claude") {
      applyClaude(runtime, servers, failures);
    } else if (harness === "codex") {
      applyCodex(runtime, servers, failures);
    } else {
      applyCommandHarness(runtime, harness, servers, failures);
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
    writeLine(runtime.stdout, "Initializing managed MCP lock without removing existing servers");
    writeServerLock(mcpLockPath, ownership.nextLock([]), overlay.next);
    writeLine(runtime.stdout, "Done.");
    return 0;
  }

  const deferred = removeStaleServers(runtime, ownership.removals, failures);
  if (failures.length > 0) {
    return reportMcpFailures(runtime, failures);
  }

  writeServerLock(mcpLockPath, [...ownership.nextLock(deferred), ...keptOverlay], overlay.next);
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
