#!/usr/bin/env node

import { constants, existsSync, statSync } from "node:fs";
import { Effect } from "effect";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runMain } from "../lib/program.ts";
import { AuditReport, type AuditFormat } from "./report.ts";
import {
  type AuditDependencies,
  canAccess,
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "./runtime.ts";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type RepoAuditOptions = {
  format: AuditFormat;
  mscp: boolean;
  mscpDir: string;
  mscpBaseline: string;
  mscpScript?: string;
  allowSudoPrompt: boolean;
};

const usage = `Usage:
  node audit/repo.ts [options]

Runs repository secret scans and an optional check-only mSCP audit.

Options:
  --mscp-dir PATH          macOS Security Compliance Project checkout
  --mscp-baseline NAME     mSCP baseline name, default: 800-53r5_moderate
  --mscp-script PATH       explicit generated mSCP compliance script
  --skip-mscp              skip mSCP audit
  --allow-sudo-prompt      allow mSCP to prompt for sudo; default uses sudo -n
  --json                   print a machine-readable summary instead of prose
  -h, --help

This command never runs mSCP remediation. It only runs --check.
`;

export function parseRepoArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RepoAuditOptions | "help" {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      "mscp-dir": { type: "string" },
      "mscp-baseline": { type: "string" },
      "mscp-script": { type: "string" },
      "skip-mscp": { type: "boolean" },
      "allow-sudo-prompt": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  return {
    format: values.json ? "json" : "text",
    mscp: !(values["skip-mscp"] ?? false),
    mscpDir:
      values["mscp-dir"] ||
      env.MSCP_DIR ||
      join(env.HOME || homedir(), "projects/security/macos_security"),
    mscpBaseline: values["mscp-baseline"] || env.MSCP_BASELINE || "800-53r5_moderate",
    mscpScript: values["mscp-script"] || env.MSCP_SCRIPT || undefined,
    allowSudoPrompt: values["allow-sudo-prompt"] ?? false,
  };
}

export function mscpPlatformVersion(version: string): string | undefined {
  const major = version.split(".", 1)[0];
  return /^\d+$/.test(major) ? `${major}.0` : undefined;
}

function scannerResult(
  report: AuditReport,
  result: CommandResult,
  success: string,
  failure: string,
  missing: string,
): boolean {
  if (result.error?.message.includes("ENOENT")) {
    report.warn(missing);
    return false;
  } else if (result.error) report.fail(`${failure}: ${result.error.message}`);
  else {
    report.output(result);
    if (result.status === 0) report.ok(success);
    else report.fail(failure);
  }
  return true;
}

function trufflehogSource(repoRoot: string, command: CommandRunner): string {
  try {
    if (statSync(join(repoRoot, ".git")).isDirectory()) return repoRoot;
  } catch {}
  const worktrees = command("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const source = worktrees.stdout
    .split("\n")
    .find((line) => line.startsWith("worktree "))
    ?.slice(9);
  return source && existsSync(join(source, ".git")) ? source : repoRoot;
}

// The filesystem pass covers what Git would commit: tracked and unignored
// files. Ignored dependency trees such as node_modules carry third-party
// test fixtures that look like credentials. A path that does not decode as
// UTF-8 fails the listing instead of dropping out of the scan.
function worktreeFiles(repoRoot: string, command: CommandRunner): string[] | undefined {
  const listed = command(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { strictUtf8: true },
  );
  if (listed.error || listed.status !== 0) return undefined;
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => join(repoRoot, path))
    .filter((path) => existsSync(path));
}

export function runRepoAudit(
  options: RepoAuditOptions,
  dependencies: AuditDependencies & { repoRoot?: string } = {},
) {
  const command = dependencies.command ?? runCommand;
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot;
  const uid = dependencies.uid ?? process.getuid?.() ?? 1;
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const report = new AuditReport(options.format, stdout, stderr);
  const output = {
    output: options.format === "json" ? ("discard" as const) : ("capture" as const),
    timeoutMs: 600_000,
  };

  report.section("repository secret scan");
  scannerResult(
    report,
    command(
      "gitleaks",
      [
        "detect",
        "--source",
        repoRoot,
        "--log-opts=HEAD --branches --remotes --tags",
        "--redact",
        "--verbose",
      ],
      output,
    ),
    "gitleaks found no leaks",
    "gitleaks reported possible leaks",
    "gitleaks is not installed",
  );

  const source = trufflehogSource(repoRoot, command);
  const trufflehogAvailable = scannerResult(
    report,
    command(
      "trufflehog",
      ["git", `file://${source}`, "--no-update", "--results=verified,unknown", "--fail"],
      output,
    ),
    "trufflehog found no verified or unknown leaks",
    "trufflehog reported verified/unknown leaks or failed",
    "trufflehog is not installed",
  );
  if (source !== repoRoot && trufflehogAvailable) {
    const files = worktreeFiles(repoRoot, command);
    if (files === undefined) report.fail("cannot list linked worktree files");
    else if (files.length > 0) {
      scannerResult(
        report,
        command(
          "trufflehog",
          [
            "filesystem",
            ...files,
            "--no-update",
            "--results=verified,unknown",
            "--fail",
            "--force-skip-binaries",
            "--force-skip-archives",
          ],
          output,
        ),
        "trufflehog found no verified or unknown leaks in linked worktree files",
        "trufflehog reported verified/unknown leaks or failed in linked worktree files",
        "trufflehog is not installed",
      );
    }
  }

  report.section("macOS compliance baseline");
  if (!options.mscp) report.ok("mSCP audit skipped");
  else if (!existsSync(join(options.mscpDir, ".git"))) {
    report.warn(`mSCP checkout missing at ${options.mscpDir}`);
    report.warn(
      "clone https://github.com/usnistgov/macos_security.git and generate a compliance script before running this audit",
    );
  } else {
    const version = command("sw_vers", ["-productVersion"]);
    const platform =
      version.status === 0 && !version.error
        ? mscpPlatformVersion(version.stdout.trim())
        : undefined;
    if (version.status !== 0 || version.error)
      report.warn("cannot determine the macOS version for the generated mSCP script");
    else if (!platform)
      report.warn(`cannot map macOS ${version.stdout.trim()} to an mSCP platform version`);
    const artifact = platform ? `${options.mscpBaseline}_macos_${platform}` : "";
    const script =
      options.mscpScript ||
      (artifact ? join(options.mscpDir, "build", artifact, `${artifact}_compliance.sh`) : "");
    if (!script)
      report.warn("pass --mscp-script because the default generated path could not be determined");
    else if (!existsSync(script)) {
      report.warn(`generated mSCP compliance script missing: ${script}`);
      report.warn(
        "generate it with the mSCP 2.0 baseline and guidance commands in docs/security-audits.md",
      );
    } else if (!canAccess(script, constants.X_OK))
      report.warn(`generated mSCP compliance script is not executable: ${script}`);
    else {
      let result: CommandResult | undefined;
      if (uid === 0) result = command("zsh", [script, "--check"], output);
      else if (options.allowSudoPrompt)
        result = command("sudo", ["zsh", script, "--check"], output);
      else {
        const sudo = command("sudo", ["-n", "true"], { output: "discard" });
        if (sudo.status === 0 && !sudo.error)
          result = command("sudo", ["-n", "zsh", script, "--check"], output);
        else
          report.warn(
            `mSCP check needs sudo; rerun with --allow-sudo-prompt or run sudo zsh ${script} --check`,
          );
      }
      if (result) {
        report.output(result);
        if (result.status === 0 && !result.error) report.ok("mSCP check passed");
        else report.fail("mSCP check reported non-compliance");
      }
    }
  }

  return report.finish("repo-security", "security audit summary", {
    mscp: options.mscp ? ("enabled" as const) : ("skipped" as const),
  });
}

function main(args: readonly string[]): number {
  try {
    const options = parseRepoArgs(args);
    if (options === "help") {
      process.stdout.write(usage);
      return 0;
    }
    return runRepoAudit(options).status;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain(
    Effect.try({ try: () => main(process.argv.slice(2)), catch: (error) => error }).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          process.exitCode = status;
        }),
      ),
      Effect.asVoid,
    ),
  );
}
