#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

import { runMain } from "../lib/program.ts";
import { readProfileModel, requireProfile } from "../profiles/model.ts";
import { HARNESS_INFO, HARNESSES, type Harness, parseSyncArgs } from "./harness.ts";
import { type Mcp, readLayeredMcps } from "./mcps/catalog.ts";
import {
  createRuntime,
  errorMessage,
  resolveProfileName,
  type Runtime,
  writeLine,
} from "./runtime.ts";

const USAGE = `Usage: ./agents/doctor.ts [--profile PROFILE]

Reports the MCP authentication state of every managed MCP in each installed
harness and the command that repairs it. Exits 1 when an MCP needs a login.`;

type Status = "ok" | "needs_login" | "unknown" | "failed";

type Finding = {
  harness: Harness;
  mcp: string;
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

function claudeFinding(runtime: Runtime, mcp: Mcp): Finding {
  const result = capture(runtime, "claude", ["mcp", "get", mcp.name]);
  const statusLine =
    result.text
      .split("\n")
      .find((line) => line.trim().startsWith("Status:"))
      ?.trim() ?? "";
  const repair = `claude mcp login ${mcp.name}`;
  if (result.status !== 0) {
    return {
      harness: "claude",
      mcp: mcp.name,
      status: "failed",
      detail: result.text.trim().split("\n").at(-1) ?? "mcp get failed",
      repair: "mise run agents:sync",
    };
  }
  if (statusLine.includes("Connected")) {
    return { harness: "claude", mcp: mcp.name, status: "ok", detail: "connected" };
  }
  if (/auth/i.test(statusLine)) {
    return {
      harness: "claude",
      mcp: mcp.name,
      status: "needs_login",
      detail: statusLine.replace("Status:", "").trim(),
      repair,
    };
  }
  return {
    harness: "claude",
    mcp: mcp.name,
    status: "unknown",
    detail: statusLine || "no status reported",
    repair,
  };
}

// `codex mcp list --json` reports the auth mode, not whether the stored OAuth
// session is still valid; Codex only reveals that when a session starts.
function codexFinding(runtime: Runtime, mcp: Mcp): Finding {
  const result = capture(runtime, "codex", ["mcp", "list", "--json"]);
  const repair = `codex mcp login ${mcp.name}`;
  if (result.status !== 0) {
    return {
      harness: "codex",
      mcp: mcp.name,
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
      mcp: mcp.name,
      status: "failed",
      detail: `unparseable mcp list: ${errorMessage(error)}`,
      repair,
    };
  }
  const entry = Array.isArray(entries)
    ? entries.find(
        (item) =>
          typeof item === "object" && item !== null && "name" in item && item.name === mcp.name,
      )
    : undefined;
  if (entry === undefined) {
    return {
      harness: "codex",
      mcp: mcp.name,
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
    mcp: mcp.name,
    status: "unknown",
    detail: `${auth}; session validity is only reported at startup`,
    repair,
  };
}

function collect(runtime: Runtime, mcps: readonly Mcp[]): Finding[] {
  const findings: Finding[] = [];
  const selected = (harness: Harness) => mcps.filter((mcp) => mcp.harnesses.includes(harness));
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
        findings.push(...chosen.map((mcp) => claudeFinding(runtime, mcp)));
        break;
      case "codex":
        findings.push(...chosen.map((mcp) => codexFinding(runtime, mcp)));
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
      `${MARK[finding.status].padEnd(5)} ${label}: ${finding.mcp} - ${finding.detail}`,
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
      ? "All managed MCPs are usable."
      : `${broken.length} MCP state(s) need attention.`,
  );
  return broken.length === 0 ? 0 : 1;
}

function run(runtime: Runtime, profileOverride: string | undefined): number {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoDir = runtime.repoDir ?? resolve(scriptDir, "..");
  const profileName = resolveProfileName(runtime, scriptDir, profileOverride);
  const model = readProfileModel(resolve(repoDir, "chezmoi/.chezmoidata/profiles.json"));
  const profile = requireProfile(model, profileName);
  const { mcps } = readLayeredMcps(repoDir, profileName, profile.agentLayers);
  writeLine(runtime.stdout, `Profile: ${profileName}`);
  return report(runtime, collect(runtime, mcps));
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
