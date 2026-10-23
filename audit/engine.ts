import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AuditReport, type AuditFormat, type FindingSeverity } from "./report.ts";
import {
  type AuditDependencies as BaseDependencies,
  type CommandResult,
  type CommandRunner,
  runPolicyCommand,
} from "./runtime.ts";
import { homePath, type PathSource, resolveSources, walkFiles } from "./paths.ts";
import { checkCodexStorage } from "./codex-storage.ts";
import { scanSecrets, type SecretScanCounts } from "./secrets/scan.ts";

export type { AuditFormat } from "./report.ts";

type AuditCheck =
  | {
      kind: "file-mode";
      path: string;
      modes: readonly number[];
      missing: Exclude<FindingSeverity, "ok">;
      mismatch: Exclude<FindingSeverity, "ok">;
    }
  | {
      kind: "pattern-absent";
      sources: readonly PathSource[];
      pattern: RegExp;
      label: string;
      severity: Exclude<FindingSeverity, "ok">;
      countAsSecretScan?: boolean;
    }
  | { kind: "npm-auth-boundary"; path: string }
  | { kind: "secret-scan"; sources: readonly PathSource[] }
  | {
      kind: "private-mode";
      sources: readonly PathSource[];
      mode?: number;
      mismatch: Exclude<FindingSeverity, "ok">;
    }
  | {
      kind: "paths-absent";
      paths: readonly string[];
      severity: Exclude<FindingSeverity, "ok">;
      label: string;
    }
  | {
      kind: "value-match";
      actual: string;
      expected: string;
      match: string;
      mismatch: string;
      severity: Exclude<FindingSeverity, "ok">;
    }
  | {
      kind: "git-identity";
      config: string;
      missing: Exclude<FindingSeverity, "ok">;
      identity: "combined" | "separate";
    }
  | { kind: "github-auth" }
  | { kind: "github-ssh-auth" }
  | { kind: "ssh-private-key-modes"; path: string }
  | { kind: "codex-trust"; path: string }
  | { kind: "codex-log-size"; path: string }
  | { kind: "tailscale-magicdns" }
  | {
      kind: "command-status";
      command: string;
      args: readonly string[];
      missing: Exclude<FindingSeverity, "ok">;
      failure: Exclude<FindingSeverity, "ok">;
      label: string;
      expect?: { pattern: RegExp; match: string; mismatch: string };
    };

export type AuditPolicy = {
  name: string;
  summary: string;
  fields?: { user: string; devbox_user: string };
  sections: readonly { title: string; checks: readonly AuditCheck[] }[];
};

export type AuditDependencies = BaseDependencies & {
  home?: string;
};

export type AuditSummary = {
  audit: string;
  status: "pass" | "warn" | "fail";
  failed: number;
  warnings: number;
  secret_scan_count: number;
  secret_scan_finding_count: number;
  secret_scan_rules: Record<string, number>;
  secret_scan_severities: Record<string, number>;
  user?: string;
  devbox_user?: string;
};

const privateKeyPattern =
  /^(-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----|---- BEGIN SSH2 (ENCRYPTED )?PRIVATE KEY ----|PuTTY-User-Key-File-[23]:)/m;

class AuditRun extends AuditReport {
  readonly secret: SecretScanCounts = {
    scanned: 0,
    findings: 0,
    rules: {},
    severities: {},
  };
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly command: CommandRunner;
  settings: Record<string, string> = {};

  constructor(
    format: AuditFormat,
    home: string,
    env: NodeJS.ProcessEnv,
    command: CommandRunner,
    stdout: (value: string) => void,
    stderr: (value: string) => void,
  ) {
    super(format, stdout, stderr);
    this.home = home;
    this.env = env;
    this.command = command;
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function checkFileMode(run: AuditRun, check: Extract<AuditCheck, { kind: "file-mode" }>): void {
  const path = homePath(run.home, check.path);
  if (!existsSync(path)) return run.finding(check.missing, `missing ${path}`);
  let mode: number;
  try {
    mode = modeOf(path);
  } catch {
    return run.finding(check.mismatch, `cannot inspect mode for ${path}`);
  }
  if (check.modes.includes(mode)) run.finding("ok", `${path} mode ${mode.toString(8)}`);
  else
    run.finding(
      check.mismatch,
      `${path} mode is ${mode.toString(8)}, expected one of: ${check.modes.map((value) => value.toString(8)).join(" ")}`,
    );
}

function checkPatterns(
  run: AuditRun,
  check: Extract<AuditCheck, { kind: "pattern-absent" }>,
): void {
  for (const path of resolveSources(run.home, check.sources, (path) =>
    run.warn(`audit coverage skipped: ${path}`),
  )) {
    try {
      if (check.countAsSecretScan) run.secret.scanned += 1;
      if (check.pattern.test(readFileSync(path, "utf8")))
        run.finding(check.severity, `${path} contains ${check.label}`);
      else run.finding("ok", `${path} does not contain ${check.label}`);
    } catch {
      run.finding("warn", `cannot read ${path} for ${check.label}`);
    }
  }
}

function checkNpmAuth(run: AuditRun, pathValue: string): void {
  const path = homePath(run.home, pathValue);
  if (!existsSync(path)) return;
  checkFileMode(run, {
    kind: "file-mode",
    path,
    modes: [0o600],
    missing: "fail",
    mismatch: "fail",
  });
  const unscoped = /^\s*(_auth|_authToken|username|_password|certfile|keyfile)\s*=/m;
  try {
    if (unscoped.test(readFileSync(path, "utf8")))
      run.finding("fail", `${path} contains auth settings without a registry scope`);
    else run.finding("ok", `${path} does not contain auth settings without a registry scope`);
  } catch {
    run.finding("fail", `cannot read ${path} for npm auth settings`);
  }
}

function checkPrivateModes(
  run: AuditRun,
  check: Extract<AuditCheck, { kind: "private-mode" }>,
): void {
  for (const path of resolveSources(run.home, check.sources, (path) =>
    run.warn(`audit coverage skipped: ${path}`),
  )) {
    let mode: number;
    try {
      mode = modeOf(path);
    } catch {
      run.finding(check.mismatch, `cannot inspect mode for ${path}`);
      continue;
    }
    const matches = check.mode === undefined ? (mode & 0o077) === 0 : mode === check.mode;
    if (matches) run.finding("ok", `${path} mode ${mode.toString(8)}`);
    else
      run.finding(
        check.mismatch,
        check.mode === undefined
          ? `${path} mode ${mode.toString(8)} is readable by group or other users`
          : `${path} mode is ${mode.toString(8)}, expected ${check.mode.toString(8)}`,
      );
  }
}

function checkAbsentPaths(
  run: AuditRun,
  check: Extract<AuditCheck, { kind: "paths-absent" }>,
): void {
  for (const value of check.paths) {
    const path = homePath(run.home, value);
    if (existsSync(path)) run.finding(check.severity, `${check.label}: ${path}`);
  }
}

function gitValue(run: AuditRun, config: string, key: string): string {
  return run
    .command("git", ["config", "--file", homePath(run.home, config), "--includes", "--get", key])
    .stdout.trim();
}

function checkGitIdentity(
  run: AuditRun,
  check: Extract<AuditCheck, { kind: "git-identity" }>,
): void {
  const config = check.config;
  const name = gitValue(run, config, "user.name");
  const email = gitValue(run, config, "user.email");
  const signingKey = gitValue(run, config, "user.signingkey");
  const signingEnabled = gitValue(run, config, "commit.gpgsign") === "true";
  if (check.identity === "combined") {
    run.finding(
      name && email ? "ok" : check.missing,
      name && email ? "git identity is configured" : "git identity is incomplete",
    );
  } else {
    if (!name) run.finding(check.missing, "missing git user.name");
    if (!email) run.finding(check.missing, "missing git user.email");
    if (name && email) run.finding("ok", "git identity is configured");
  }
  run.finding(
    signingKey ? "ok" : check.missing,
    signingKey ? "git signing key configured" : "git signing key is not configured",
  );
  run.finding(
    signingEnabled ? "ok" : check.missing,
    signingEnabled ? "git commit signing enabled" : "git commit signing is not enabled",
  );
}

export function readSettingsFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const settings: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^#\s]*))\s*$/);
    if (match) settings[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return settings;
}

function loadAuditSettings(run: AuditRun): Record<string, string> {
  const path = run.env.AUDIT_POLICY_FILE || join(run.home, ".config/dotfiles/audit.env");
  if (!existsSync(path)) return {};
  run.finding("ok", `loaded audit policy from ${path}`);
  return readSettingsFile(path);
}

function checkGithubAuth(run: AuditRun): void {
  const status = run.command("gh", ["auth", "status", "-h", "github.com"]);
  if (status.error?.message.includes("ENOENT")) return run.finding("fail", "gh is missing");
  if (status.status !== 0) return run.finding("fail", "gh auth is not working for github.com");
  run.finding("ok", "gh auth works for github.com");
  const sensitive = (
    run.settings.GH_SENSITIVE_SCOPES ||
    "delete_repo workflow admin:org admin:public_key admin:repo_hook write:packages"
  ).split(/\s+/);
  const accepted = new Set((run.settings.GH_ACCEPTED_SCOPES || "").split(/\s+/));
  const scopes = new Set(
    status.stderr
      .match(/Token scopes:\s*(.*)/)?.[1]
      .replace(/[',]/g, "")
      .split(/\s+/) ?? [],
  );
  for (const scope of sensitive) {
    if (!scopes.has(scope)) continue;
    run.finding(
      accepted.has(scope) ? "ok" : "warn",
      accepted.has(scope)
        ? `gh token broad scope accepted by policy: ${scope}`
        : `gh token has broad scope outside policy: ${scope}`,
    );
  }
}

function checkGithubSshAuth(run: AuditRun): void {
  const result = run.command("ssh", ["-o", "BatchMode=yes", "-T", "git@github.com"]);
  if (result.error?.message.includes("ENOENT")) return run.finding("fail", "ssh is missing");
  const output = `${result.stdout}\n${result.stderr}`;
  run.finding(
    output.includes("successfully authenticated") ? "ok" : "fail",
    output.includes("successfully authenticated")
      ? "git@github.com SSH auth works"
      : "git@github.com SSH auth failed",
  );
}

function checkCodexTrust(run: AuditRun, pathValue: string): void {
  const path = homePath(run.home, pathValue);
  if (!existsSync(path)) return run.finding("warn", `missing ${path}`);
  const projects = [...readFileSync(path, "utf8").matchAll(/^\[projects\."([^"]+)"\]$/gm)].map(
    (match) => match[1],
  );
  const homeParent = dirname(run.home);
  for (const project of projects) {
    if (!existsSync(project)) run.finding("warn", `Codex trusts missing project path: ${project}`);
    if (project === run.home || project === join(run.home, "projects"))
      run.finding("warn", `Codex trusts broad home path: ${project}`);
    else if (project.startsWith(`${run.home}/`))
      run.finding("ok", `Codex trusted path stays under this user: ${project}`);
    else if (project.startsWith(`${homeParent}/`))
      run.finding("fail", `Codex trusts another user's path: ${project}`);
    else run.finding("warn", `Codex trusts path outside this home: ${project}`);
  }
  if (projects.length === 0) run.finding("warn", "Codex has no trusted project entries");
}

function commandWorked(result: CommandResult): boolean {
  return result.error === undefined && result.status === 0;
}

function systemResolves(run: AuditRun, name: string): boolean {
  const commands: Array<[string, string[]]> = [
    ["dscacheutil", ["-q", "host", "-a", "name", name]],
    ["getent", ["hosts", name]],
    ["host", [name]],
  ];
  for (const [command, args] of commands) {
    const result = run.command(command, args);
    if (result.error?.message.includes("ENOENT")) continue;
    return (
      commandWorked(result) && (command !== "dscacheutil" || result.stdout.includes("ip_address:"))
    );
  }
  return false;
}

function checkTailscaleMagicDns(run: AuditRun): void {
  const status = run.command("tailscale", ["status", "--peers=false"]);
  if (status.error?.message.includes("ENOENT")) return run.finding("fail", "tailscale is missing");
  if (!commandWorked(status)) return run.finding("fail", "tailscale status failed");
  run.finding("ok", "tailscale status works");

  const json = run.command("tailscale", ["status", "--json"]);
  if (!commandWorked(json)) return run.finding("fail", "tailscale JSON status failed");
  let dnsName = "";
  try {
    const parsed: unknown = JSON.parse(json.stdout);
    if (typeof parsed === "object" && parsed !== null && "Self" in parsed) {
      const self = parsed.Self;
      if (
        typeof self === "object" &&
        self !== null &&
        "DNSName" in self &&
        typeof self.DNSName === "string"
      )
        dnsName = self.DNSName.replace(/\.$/, "");
    }
  } catch {}
  const shortName = dnsName.split(".")[0];
  if (!dnsName || shortName === dnsName)
    return run.finding("fail", "tailscale self DNS name is unavailable");

  const direct = run.command("dig", [
    "+time=2",
    "+tries=1",
    "+short",
    "@100.100.100.100",
    dnsName,
    "A",
  ]);
  if (!commandWorked(direct) || !/^\d+[.]\d+[.]\d+[.]\d+$/m.test(direct.stdout))
    return run.finding("fail", "direct MagicDNS lookup failed through 100.100.100.100");
  run.finding("ok", "direct MagicDNS lookup works through 100.100.100.100");
  if (systemResolves(run, shortName))
    run.finding("ok", "system resolver handles MagicDNS short hostnames");
  else if (systemResolves(run, dnsName))
    run.finding("fail", "system resolver handles MagicDNS FQDNs but not short hostnames");
  else
    run.finding(
      "fail",
      "system resolver is not using Tailscale MagicDNS; repair Tailscale resolver wiring",
    );
}

function checkSshModes(run: AuditRun, pathValue: string): void {
  const root = homePath(run.home, pathValue);
  if (!existsSync(root)) return run.finding("warn", `missing ${root}`);
  for (const path of walkFiles(root, Number.POSITIVE_INFINITY, (path) =>
    run.warn(`audit coverage skipped: ${path}`),
  )) {
    try {
      if (!privateKeyPattern.test(readFileSync(path, "utf8"))) continue;
      const mode = modeOf(path);
      run.finding(
        (mode & 0o077) === 0 ? "ok" : "fail",
        (mode & 0o077) === 0
          ? `${path} mode ${mode.toString(8)}`
          : `${path} mode ${mode.toString(8)} is group/world accessible`,
      );
    } catch {
      run.finding("warn", `cannot inspect SSH file ${path}`);
    }
  }
}

function runCheck(run: AuditRun, check: AuditCheck): void {
  switch (check.kind) {
    case "file-mode":
      return checkFileMode(run, check);
    case "pattern-absent":
      return checkPatterns(run, check);
    case "npm-auth-boundary":
      return checkNpmAuth(run, check.path);
    case "secret-scan":
      return scanSecrets(
        { home: run.home, env: run.env, command: run.command, sources: check.sources, report: run },
        run.secret,
      );
    case "private-mode":
      return checkPrivateModes(run, check);
    case "paths-absent":
      return checkAbsentPaths(run, check);
    case "value-match":
      return run.finding(
        check.actual === check.expected ? "ok" : check.severity,
        check.actual === check.expected ? check.match : check.mismatch,
      );
    case "git-identity":
      return checkGitIdentity(run, check);
    case "github-auth":
      return checkGithubAuth(run);
    case "github-ssh-auth":
      return checkGithubSshAuth(run);
    case "ssh-private-key-modes":
      return checkSshModes(run, check.path);
    case "codex-trust":
      return checkCodexTrust(run, check.path);
    case "codex-log-size":
      return checkCodexStorage(
        homePath(run.home, check.path),
        { ...run.env, ...run.settings },
        run,
      );
    case "tailscale-magicdns":
      return checkTailscaleMagicDns(run);
    case "command-status": {
      const result = run.command(check.command, check.args);
      if (result.error?.message.includes("ENOENT"))
        run.finding(check.missing, `${check.command} CLI is missing`);
      else if (result.status !== 0) run.finding(check.failure, `${check.label} failed`);
      else if (check.expect === undefined) run.finding("ok", `${check.label} works`);
      else if (check.expect.pattern.test(result.stdout)) run.finding("ok", check.expect.match);
      else run.finding(check.failure, check.expect.mismatch);
    }
  }
}

export function runPolicy(
  policy: AuditPolicy,
  format: AuditFormat,
  dependencies: AuditDependencies = {},
): { status: number; summary: AuditSummary } {
  const run = new AuditRun(
    format,
    dependencies.home || dependencies.env?.HOME || process.env.HOME || "",
    { ...process.env, ...dependencies.env },
    dependencies.command || runPolicyCommand,
    dependencies.stdout || ((value) => process.stdout.write(value)),
    dependencies.stderr || ((value) => process.stderr.write(value)),
  );
  run.settings = loadAuditSettings(run);
  for (const section of policy.sections) {
    run.section(section.title);
    for (const check of section.checks) runCheck(run, check);
  }
  return run.finish(policy.name, policy.summary, {
    secret_scan_count: run.secret.scanned,
    secret_scan_finding_count: run.secret.findings,
    secret_scan_rules: run.secret.rules,
    secret_scan_severities: run.secret.severities,
    ...policy.fields,
  });
}
