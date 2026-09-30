#!/usr/bin/env node

import { basename, dirname, resolve } from "node:path";
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
harness and the command that repairs it. Exits 1 when a server needs a login
or the Grok installation drifted from the profile.`;

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

type GrokDoctor = {
  servers: Array<{
    name: string;
    healthy: boolean;
    checks: Array<{ label: string; passed: boolean; detail?: string }>;
  }>;
};

function parseGrokDoctor(stdout: string): GrokDoctor | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("servers" in parsed) ||
      !Array.isArray(parsed.servers)
    ) {
      return undefined;
    }
    return parsed as GrokDoctor;
  } catch {
    return undefined;
  }
}

function grokFinding(server: McpServer, doctor: GrokDoctor | undefined, text: string): Finding {
  const repair = `./agents/grok-mcp-login.ts ${server.name}  # or: grok, /mcps, select it, press i`;
  if (doctor === undefined) {
    const syntax = text.split("\n").find((line) => line.includes("syntax errors"));
    return {
      harness: "grok",
      server: server.name,
      status: "failed",
      detail: syntax
        ? "~/.grok/config.toml does not parse: " + syntax.replace(/^.*syntax errors: /, "")
        : "mcp doctor produced no JSON",
      repair: syntax
        ? "fix ~/.grok/config.toml (duplicate Hindsight block?), then mise run agents:sync"
        : "grok mcp doctor",
    };
  }
  const entry = doctor.servers.find((item) => item.name === server.name);
  if (entry === undefined) {
    return {
      harness: "grok",
      server: server.name,
      status: "failed",
      detail: "not configured",
      repair: "mise run agents:sync",
    };
  }
  if (entry.healthy) {
    const tools =
      entry.checks.find((check) => /tools discovered/.test(check.label))?.label ?? "handshake OK";
    return { harness: "grok", server: server.name, status: "ok", detail: tools };
  }
  const failing = entry.checks.find((check) => !check.passed);
  const detail = `${failing?.label ?? "unhealthy"}${failing?.detail ? `: ${failing.detail}` : ""}`;
  return {
    harness: "grok",
    server: server.name,
    status: /auth/i.test(detail) ? "needs_login" : "failed",
    detail: detail.slice(0, 160),
    repair,
  };
}

type Drift = { detail: string; repair: string };

const reinstallGrok = "mise install npm:@xai-official/grok; mise reshim";

// Every host installs Grok from the mise pin. Any other grok on PATH (a
// global npm install, including one under a mise-managed Node, or the
// Homebrew cask) can shadow it in a shell or job whose PATH order differs,
// and a mise shim can dispatch to any provider of grok. A global npm install
// also shadows the pin through the shim without appearing on PATH. Grok setup
// aligns ~/.grok/bin/grok with the pin, so that path is managed while it links
// to the pinned version (mise names install directories by version).
function grokInstallDrift(runtime: Runtime): Drift[] {
  const home = runtime.env.HOME;
  const drift: Drift[] = [];
  const reported: string[] = [];
  const foreign = (path: string) => {
    if (reported.includes(path)) return;
    reported.push(path);
    drift.push({
      detail: `grok resolves to ${path}, not the mise pin`,
      repair: `remove ${path} with its installer (npm uninstall -g @xai-official/grok under that Node, or brew uninstall --cask grok-build); ${reinstallGrok}`,
    });
  };
  const listed = capture(runtime, "which", ["-a", "grok"]);
  if (listed.status !== 0 && listed.status !== 1) {
    drift.push({
      detail: `cannot list grok on PATH: which -a grok exited ${listed.status}`,
      repair: "command -v grok, then compare it with mise where npm:@xai-official/grok",
    });
  }
  const paths = [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  const where = capture(runtime, "mise", ["where", "npm:@xai-official/grok"]);
  const pin = where.status === 0 ? where.stdout.trim() : "";
  const pinned = (path: string) => pin.length > 0 && path.startsWith(`${pin}/`);
  const shims = home === undefined ? undefined : `${home}/.local/share/mise/shims/`;
  const staged = home === undefined ? undefined : `${home}/.grok/bin/grok`;
  for (const path of paths) {
    if (pinned(path)) continue;
    if (path === staged) {
      const target = capture(runtime, "readlink", [path]).stdout.trim();
      const expected = pin.length > 0 ? `grok-${basename(pin)}` : undefined;
      if (expected !== undefined && target === expected) continue;
      drift.push({
        detail: `${path} links to ${target || "no staged version"}, not ${expected ?? "the mise pin"}`,
        repair: "./dotfiles apply",
      });
      continue;
    }
    if (shims === undefined || !path.startsWith(shims)) {
      foreign(path);
      continue;
    }
    const which = capture(runtime, "mise", ["which", "grok"]);
    const resolved = which.stdout.trim();
    if (which.status !== 0 || resolved.length === 0) {
      drift.push({
        detail: `grok resolves to ${path}, which mise cannot resolve`,
        repair: reinstallGrok,
      });
    } else if (!pinned(resolved)) {
      foreign(resolved);
    }
  }
  const npm = capture(runtime, "npm", [
    "ls",
    "--global",
    "--json",
    "--depth=0",
    "@xai-official/grok",
  ]);
  const version = globalNpmGrokVersion(npm.stdout);
  if (version !== undefined) {
    const prefix = capture(runtime, "npm", ["prefix", "--global"]).stdout.trim();
    if (prefix.length === 0 || !reported.some((path) => path.startsWith(`${prefix}/`))) {
      drift.push({
        detail: `npm has a global @xai-official/grok ${version} install`,
        repair: "npm uninstall -g @xai-official/grok; mise reshim",
      });
    }
  }
  return drift;
}

function globalNpmGrokVersion(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const dependencies = (parsed as { dependencies?: unknown }).dependencies;
    if (typeof dependencies !== "object" || dependencies === null) return undefined;
    const grok = (dependencies as Record<string, unknown>)["@xai-official/grok"];
    if (typeof grok !== "object" || grok === null) return undefined;
    const version = (grok as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown-version";
  } catch {
    return undefined;
  }
}

function grokDriftFindings(runtime: Runtime): Finding[] {
  return grokInstallDrift(runtime).map(({ detail, repair }) => ({
    harness: "grok",
    server: "install",
    status: "failed",
    detail,
    repair,
  }));
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
    // Every profile installs Grok, so its drift is checked without MCP servers.
    if (harness === "grok") findings.push(...grokDriftFindings(runtime));
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
      case "grok": {
        const result = capture(runtime, "grok", ["mcp", "doctor", "--json"]);
        const doctor = parseGrokDoctor(result.stdout);
        findings.push(...chosen.map((server) => grokFinding(server, doctor, result.text)));
        break;
      }
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
