#!/usr/bin/env node

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";

import { parseHostArgs, runHostAudit } from "./host.ts";
import { type CommandOptions, type CommandRunner, runCommand } from "./runtime.ts";
import { mscpPlatformVersion, parseRepoArgs, runRepoAudit } from "./repo.ts";

test("host adapter summarizes Lynis without exposing its report", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-host-audit-test-"));
  const output: string[] = [];
  const command: CommandRunner = (_command, args) => {
    writeFileSync(
      args[args.indexOf("--report-file") + 1],
      [
        "lynis_version=3.1.4",
        "hardening_index=72",
        "lynis_tests_done=191",
        "warning[]=AUTH-9262|Password policy is weak|",
        "suggestion[]=BOOT-5122|Protect startup mode|",
      ].join("\n"),
    );
    writeFileSync(args[args.indexOf("--log-file") + 1], "private host data");
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const result = runHostAudit(
      { format: "json", allowSudoPrompt: false, minHardeningIndex: 70 },
      {
        command,
        env: { TMPDIR: root },
        uid: 501,
        stdout: (value) => output.push(value),
      },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(result.summary, {
      audit: "host-security",
      status: "warn",
      failed: 0,
      warnings: 2,
      lynis_version: "3.1.4",
      hardening_index: 72,
      tests_performed: 191,
      lynis_warnings: 1,
      lynis_suggestions: 1,
      privileged: false,
    });
    assert.deepEqual(JSON.parse(output.join("")), result.summary);
    assert.throws(
      () => parseHostArgs(["--min-hardening-index", "nope"]),
      /invalid --min-hardening-index/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privileged host adapter checks Lynis before invoking sudo", () => {
  const calls: string[] = [];
  const result = runHostAudit(
    { format: "json", allowSudoPrompt: true },
    {
      uid: 501,
      command: (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        return { status: null, stdout: "", stderr: "", error: new Error("spawn lynis ENOENT") };
      },
      stdout: () => {},
    },
  );
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.privileged, false);
  assert.deepEqual(calls, ["lynis --version"]);
});

test("host adapter rejects an empty Lynis report", () => {
  const result = runHostAudit(
    { format: "json", allowSudoPrompt: false },
    {
      command: () => ({ status: 0, stdout: "", stderr: "" }),
      stdout: () => {},
    },
  );
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.warnings, 1);
});

test("repository adapter selects the mSCP 2.0 artifact and only checks it", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-repo-audit-test-"));
  const repo = join(root, "repo");
  const mscp = join(root, "macos_security");
  const artifact = "800-53r5_moderate_macos_26.0";
  const compliance = join(mscp, "build", artifact, `${artifact}_compliance.sh`);
  const calls: Array<[string, readonly string[], CommandOptions | undefined]> = [];
  const command: CommandRunner = (name, args, options) => {
    calls.push([name, args, options]);
    return { status: 0, stdout: name === "sw_vers" ? "26.6\n" : "", stderr: "" };
  };
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(mscp, ".git"), { recursive: true });
  mkdirSync(dirname(compliance), { recursive: true });
  writeFileSync(compliance, "#!/bin/zsh\n");
  chmodSync(compliance, 0o755);
  try {
    const result = runRepoAudit(
      {
        format: "json",
        mscp: true,
        mscpDir: mscp,
        mscpBaseline: "800-53r5_moderate",
        allowSudoPrompt: false,
      },
      { command, repoRoot: repo, uid: 0, stdout: () => {} },
    );
    assert.deepEqual(result.summary, {
      audit: "repo-security",
      status: "pass",
      failed: 0,
      warnings: 0,
      mscp: "enabled",
    });
    assert.ok(
      calls.some(
        ([name, args, options]) =>
          name === "zsh" &&
          args[0] === compliance &&
          args[1] === "--check" &&
          options?.output === "discard",
      ),
    );
    assert.ok(
      calls.some(
        ([name, args]) =>
          name === "gitleaks" && args.includes("--log-opts=HEAD --branches --remotes --tags"),
      ),
    );
    assert.ok(calls.every(([, args]) => !args.includes("--fix")));
    assert.ok(
      calls
        .filter(([name]) => name === "gitleaks" || name === "trufflehog")
        .every(([, , options]) => options?.output === "discard"),
    );
    assert.equal(mscpPlatformVersion("14.7.7"), "14.0");
    assert.equal(mscpPlatformVersion("unknown"), undefined);
    assert.deepEqual(parseRepoArgs(["--skip-mscp"], { HOME: "/tmp/home" }), {
      format: "text",
      mscp: false,
      mscpDir: "/tmp/home/projects/security/macos_security",
      mscpBaseline: "800-53r5_moderate",
      mscpScript: undefined,
      allowSudoPrompt: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktree scan covers unignored files and skips dependency trees", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-worktree-audit-test-"));
  const main = join(root, "main");
  const linked = join(root, "linked");
  const git = (cwd: string, ...args: string[]) => {
    const result = runCommand("git", ["-C", cwd, ...args]);
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    mkdirSync(main);
    git(main, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(main, ".gitignore"), "node_modules/\n");
    writeFileSync(join(main, "tracked.ts"), "export {};\n");
    writeFileSync(join(main, "removed.ts"), "export {};\n");
    git(main, "add", ".");
    git(
      main,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "init",
    );
    git(main, "worktree", "add", "--quiet", linked);
    rmSync(join(linked, "removed.ts"));
    writeFileSync(join(linked, "untracked.ts"), "export {};\n");
    mkdirSync(join(linked, "node_modules/dependency/tests"), { recursive: true });
    writeFileSync(join(linked, "node_modules/dependency/tests/fixture.ts"), "dependency fixture\n");

    const scans: Array<readonly string[]> = [];
    const command: CommandRunner = (name, args, options) => {
      if (name === "git") return runCommand(name, args, options);
      if (name === "trufflehog" && args[0] === "filesystem") scans.push(args);
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = runRepoAudit(
      {
        format: "json",
        mscp: false,
        mscpDir: join(root, "mscp"),
        mscpBaseline: "800-53r5_moderate",
        allowSudoPrompt: false,
      },
      { command, repoRoot: linked, uid: 0, stdout: () => {} },
    );
    assert.equal(result.summary.failed, 0);
    assert.equal(scans.length, 1);
    const paths = (scans[0] ?? []).filter((arg) => !arg.startsWith("--")).slice(1);
    assert.deepEqual(paths.toSorted(), [
      join(linked, ".gitignore"),
      join(linked, "tracked.ts"),
      join(linked, "untracked.ts"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktree scan fails closed on paths that do not decode", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-worktree-decode-test-"));
  const scans: Array<readonly string[]> = [];
  const command: CommandRunner = (name, args, options) => {
    if (name === "git" && args.includes("worktree"))
      return { status: 0, stdout: `worktree ${root}\n`, stderr: "" };
    if (name === "git" && options?.strictUtf8)
      return {
        status: 0,
        stdout: "",
        stderr: "",
        error: new Error("git output is not valid UTF-8"),
      };
    if (name === "trufflehog" && args[0] === "filesystem") scans.push(args);
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    mkdirSync(join(root, ".git"));
    const result = runRepoAudit(
      {
        format: "json",
        mscp: false,
        mscpDir: join(root, "mscp"),
        mscpBaseline: "800-53r5_moderate",
        allowSudoPrompt: false,
      },
      { command, repoRoot: join(root, "linked"), uid: 0, stdout: () => {} },
    );
    assert.equal(result.summary.failed, 1);
    assert.deepEqual(scans, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict UTF-8 output keeps a literal U+FFFD and rejects invalid bytes", () => {
  const valid = runCommand("printf", ["report-�.txt"], { strictUtf8: true });
  assert.equal(valid.error, undefined);
  assert.equal(valid.stdout, "report-�.txt");
  const invalid = runCommand("printf", ["report-\\377.txt"], { strictUtf8: true });
  assert.match(invalid.error?.message ?? "", /not valid UTF-8/);
});
