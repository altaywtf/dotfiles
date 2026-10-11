#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import { HARNESS_INFO, HARNESSES, type Harness, parseSyncArgs } from "./harness.ts";
import { type McpServer, readLayeredServers } from "./mcps/catalog.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

const USAGE = `Usage: ./agents/doctor.ts [--profile PROFILE]

Reports the MCP authentication state of every managed server in each installed
harness and the command that repairs it. Exits 1 when a server needs a login.`;

type Status = "ok" | "needs_login" | "unknown" | "failed";

type Finding = {
  harness: Harness;
  server: string;
  status: Status;
  detail: string;
  repair?: string;
};

// oxlint-disable-next-line no-control-regex -- Strip ANSI escape sequences from CLI output.
const stripAnsi = (text: string) => text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

function capture(runtime: Runtime, command: string, args: readonly string[]) {
  const result = runtime.run(command, args, { stdout: "capture", stderr: "capture" });
  return { ...result, text: stripAnsi(`${result.stdout}\n${result.stderr}`) };
}

function claudeFinding(runtime: Runtime, server: McpServer): Finding {
  const result = capture(runtime, "claude", ["mcp", "get", server.name]);
  const statusLine =
    result.text
      .split("\n")
      .find((line) => line.trim().startsWith("Status:"))
      ?.trim() ?? "";
  const repair = `claude mcp login ${server.name}`;
  if (result.status !== 0) {
    return {
      harness: "claude",
      server: server.name,
      status: "failed",
      detail: result.text.trim().split("\n").at(-1) ?? "mcp get failed",
      repair: "mise run agents:sync",
    };
  }
  if (statusLine.includes("Connected")) {
    return { harness: "claude", server: server.name, status: "ok", detail: "connected" };
  }
  if (/auth/i.test(statusLine)) {
    return {
      harness: "claude",
      server: server.name,
      status: "needs_login",
      detail: statusLine.replace("Status:", "").trim(),
      repair,
    };
  }
  return {
    harness: "claude",
    server: server.name,
    status: "unknown",
    detail: statusLine || "no status reported",
    repair,
  };
}

// `codex mcp list --json` reports the auth mode, not whether the stored OAuth
// session is still valid; Codex only reveals that when a session starts.
function codexFinding(runtime: Runtime, server: McpServer): Finding {
  const result = capture(runtime, "codex", ["mcp", "list", "--json"]);
  const repair = `codex mcp login ${server.name}`;
  if (result.status !== 0) {
    return {
      harness: "codex",
      server: server.name,
      status: "failed",
      detail: result.text.trim().split("\n").at(-1) ?? "mcp list failed",
      repair: "mise run agents:sync",
    };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(result.stdout);
  } catch (error) {
    return {
      harness: "codex",
      server: server.name,
      status: "failed",
      detail: `unparseable mcp list: ${errorMessage(error)}`,
      repair,
    };
  }
  const entry = Array.isArray(entries)
    ? entries.find(
        (item) =>
          typeof item === "object" && item !== null && "name" in item && item.name === server.name,
      )
    : undefined;
  if (entry === undefined) {
    return {
      harness: "codex",
      server: server.name,
      status: "failed",
      detail: "not configured",
      repair: "mise run agents:sync",
    };
  }
  const auth =
    typeof entry === "object" && entry !== null && "auth_status" in entry
      ? String(entry.auth_status)
      : "unknown";
  return {
    harness: "codex",
    server: server.name,
    status: "unknown",
    detail: `${auth}; session validity is only reported at startup`,
    repair,
  };
}

function collect(runtime: Runtime, servers: readonly McpServer[]): Finding[] {
  const findings: Finding[] = [];
  const selected = (harness: Harness) =>
    servers.filter((server) => server.harnesses.includes(harness));
  for (const harness of HARNESSES) {
    const { binary, label } = HARNESS_INFO[harness];
    if (!runtime.commandExists(binary)) {
      writeLine(runtime.stdout, `Skipping ${label}: '${binary}' is not installed`);
      continue;
    }
    const chosen = selected(harness);
    if (chosen.length === 0) {
      continue;
    }
    switch (harness) {
      case "claude":
        findings.push(...chosen.map((server) => claudeFinding(runtime, server)));
        break;
      case "codex":
        findings.push(...chosen.map((server) => codexFinding(runtime, server)));
        break;
    }
  }
  return findings;
}

const MARK: Record<Status, string> = {
  ok: "ok",
  needs_login: "LOGIN",
  unknown: "?",
  failed: "FAIL",
};

function report(runtime: Runtime, findings: readonly Finding[]): number {
  for (const finding of findings) {
    const label = HARNESS_INFO[finding.harness].label;
    writeLine(
      runtime.stdout,
      `${MARK[finding.status].padEnd(5)} ${label}: ${finding.server} - ${finding.detail}`,
    );
    if (
      (finding.status === "needs_login" || finding.status === "failed") &&
      finding.repair !== undefined
    ) {
      writeLine(runtime.stdout, `      repair: ${finding.repair}`);
    }
  }
  const broken = findings.filter(
    (finding) => finding.status === "needs_login" || finding.status === "failed",
  );
  writeLine(
    runtime.stdout,
    broken.length === 0
      ? "All managed MCP servers are usable."
      : `${broken.length} MCP server state(s) need attention.`,
  );
  return broken.length === 0 ? 0 : 1;
}

function run(runtime: Runtime, profileOverride: string | undefined): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, profileOverride);
  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { servers } = readLayeredServers(repoDir, profileName, profile.agentLayers);
  writeLine(runtime.stdout, `Profile: ${profileName}`);
  return report(runtime, collect(runtime, servers));
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
    return run(runtime, parsed.profile);
  } catch (error) {
    writeLine(runtime.stderr, `MCP doctor failed: ${errorMessage(error)}`);
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
