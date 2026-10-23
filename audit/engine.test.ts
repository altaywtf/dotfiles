#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { type AuditPolicy, runPolicy } from "./engine.ts";
import { workstationPolicy } from "./workstation.ts";

function fixture(): { home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-engine-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  for (const path of [".gitconfig.local", ".ssh/config.local", ".codex/config.toml"]) {
    writeFileSync(join(home, path), "fixture\n", { mode: 0o600 });
  }
  writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
  writeFileSync(join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=fixture\n", {
    mode: 0o600,
  });
  return { home, root };
}

function cleanCommand(command: string, args: readonly string[]) {
  if (command === "git") {
    const key = args.at(-1);
    const values: Record<string, string> = {
      "user.name": "Fixture",
      "user.email": "fixture@example.invalid",
      "user.signingkey": "fixture-key",
      "commit.gpgsign": "true",
    };
    return { status: values[key ?? ""] ? 0 : 1, stdout: values[key ?? ""] ?? "", stderr: "" };
  }
  if (command === "gh") return { status: 0, stdout: "", stderr: "Token scopes: 'repo'\n" };
  if (command.endsWith("/socketfilterfw"))
    return { status: 0, stdout: "Firewall is enabled. (State = 1)\n", stderr: "" };
  if (command === "gitleaks" && args[0] === "dir")
    writeFileSync(args[args.indexOf("--report-path") + 1], "[]");
  return { status: 0, stdout: "", stderr: "" };
}

test("workstation policy is declarative and passes a clean fixture", () => {
  const { home, root } = fixture();
  const output: string[] = [];
  try {
    const result = runPolicy(workstationPolicy(root), "json", {
      home,
      env: { HOME: home, TMPDIR: join(root, "tmp") },
      command: cleanCommand,
      stdout: (value) => output.push(value),
      stderr: (value) => output.push(value),
    });
    assert.equal(result.status, 0);
    assert.equal(result.summary.status, "pass");
    assert.equal(result.summary.secret_scan_count, 3);
    const parsed = JSON.parse(output.join(""));
    assert.deepEqual(parsed, result.summary);
    assert.equal("user" in parsed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit symlink roots stay in the secret scan", () => {
  const { home, root } = fixture();
  const external = join(root, "external-aws");
  mkdirSync(external);
  writeFileSync(join(external, "credentials"), "fixture\n");
  symlinkSync(external, join(external, "cycle"));
  symlinkSync(join(root, "missing"), join(external, "broken"));
  symlinkSync(external, join(home, ".aws"));
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [
      {
        title: "scan",
        checks: [{ kind: "secret-scan", sources: [{ kind: "path", path: ".aws" }] }],
      },
    ],
  } satisfies AuditPolicy;
  try {
    const result = runPolicy(policy, "json", {
      home,
      command: (command, args) => {
        if (command === "gitleaks" && args[0] === "dir") {
          const staged = join(args.at(-1)!, "home/.aws/credentials");
          assert.equal(statSync(staged).isFile(), true);
          assert.equal(readlinkSync(staged), realpathSync(join(external, "credentials")));
          assert.deepEqual(readdirSync(join(args.at(-1)!, "home/.aws")), ["credentials"]);
        }
        return cleanCommand(command, args);
      },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.summary.secret_scan_count, 1);
    assert.equal(result.summary.warnings, 2);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit policy file sets Codex log thresholds", () => {
  const { home, root } = fixture();
  const config = join(root, "audit.env");
  writeFileSync(config, "CODEX_LOG_WARN_BYTES=5\nCODEX_LOG_FAIL_BYTES=1000\n");
  writeFileSync(join(home, ".codex/logs-fixture.sqlite-wal"), "larger than five bytes\n");
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [{ title: "logs", checks: [{ kind: "codex-log-size", path: ".codex" }] }],
  } satisfies AuditPolicy;
  try {
    const result = runPolicy(policy, "json", {
      home,
      env: { HOME: home, AUDIT_POLICY_FILE: config },
      command: cleanCommand,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.summary.warnings, 1);
    assert.equal(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("typed checks reject unsafe npm auth and SSH key modes", () => {
  const { home, root } = fixture();
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [
      {
        title: "boundaries",
        checks: [
          { kind: "npm-auth-boundary", path: ".npmrc" },
          { kind: "ssh-private-key-modes", path: ".ssh" },
        ],
      },
    ],
  } satisfies AuditPolicy;
  try {
    writeFileSync(join(home, ".npmrc"), "_authToken=fixture\n", { mode: 0o600 });
    writeFileSync(join(home, ".ssh/id_fixture"), "-----BEGIN OPENSSH PRIVATE KEY-----\n", {
      mode: 0o644,
    });
    chmodSync(join(home, ".ssh/id_fixture"), 0o644);
    const result = runPolicy(policy, "json", {
      home,
      command: cleanCommand,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.summary.failed, 2);
    assert.equal(result.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workstation flags readable env files, compromised roots, and a disabled firewall", () => {
  const { home, root } = fixture();
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, 0o644);
  };
  write(join(home, "projects/app/.env"), "TOKEN=fixture\n");
  write(join(home, "projects/app/.env.example"), "TOKEN=\n");
  write(join(home, "projects/app/.env.scripts.example"), "TOKEN=\n");
  symlinkSync(join(home, ".ssh"), join(home, "projects/app/linked"));
  write(join(home, "projects/app/node_modules/dep/.env"), "TOKEN=fixture\n");
  write(
    join(root, "etc/ssl/cert.pem"),
    "=== /C=IN/OU=emSign PKI/O=eMudhra Technologies Limited/CN=emSign ECC Root CA - G3\n",
  );
  const errors: string[] = [];
  try {
    const result = runPolicy(workstationPolicy(root), "text", {
      home,
      env: { HOME: home, TMPDIR: join(root, "tmp") },
      command: (command, args) =>
        command.endsWith("/socketfilterfw")
          ? { status: 0, stdout: "Firewall is disabled. (State = 0)\n", stderr: "" }
          : cleanCommand(command, args),
      stdout: () => {},
      stderr: (value) => errors.push(value),
    });
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.warnings, 2);
    assert.deepEqual(errors.sort(), [
      `FAILED: ${join(root, "etc/ssl/cert.pem")} contains roots of the compromised eMudhra intermediates\n`,
      `warn ${join(home, "projects/app/.env")} mode 644 is readable by group or other users\n`,
      "warn application firewall is disabled\n",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-mode mismatch severity comes from policy", () => {
  const { home, root } = fixture();
  chmodSync(join(home, ".zshrc"), 0o644);
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [
      {
        title: "mode",
        checks: [
          { kind: "file-mode", path: ".zshrc", modes: [0o600], missing: "fail", mismatch: "warn" },
        ],
      },
    ],
  } satisfies AuditPolicy;
  try {
    const result = runPolicy(policy, "json", {
      home,
      command: cleanCommand,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.status, 0);
    assert.equal(result.summary.warnings, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret scan reports only sanitized locators and removes staging data", () => {
  const { home, root } = fixture();
  const scratch = join(root, "tmp");
  mkdirSync(scratch);
  const output: string[] = [];
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [
      {
        title: "scan",
        checks: [{ kind: "secret-scan", sources: [{ kind: "path", path: ".zshrc" }] }],
      },
    ],
  } satisfies AuditPolicy;
  try {
    const result = runPolicy(policy, "text", {
      home,
      env: { HOME: home, TMPDIR: scratch },
      command: (command, args) => {
        if (command === "gitleaks" && args[0] === "dir") {
          const report = args[args.indexOf("--report-path") + 1];
          writeFileSync(
            report,
            JSON.stringify([
              {
                RuleID: "generic-api-key",
                File: join(args.at(-1)!, "home/.zshrc"),
                Secret: "never print this",
              },
            ]),
          );
          return { status: 183, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      stdout: (value) => output.push(value),
      stderr: (value) => output.push(value),
    });
    assert.equal(result.status, 0);
    assert.equal(result.summary.warnings, 1);
    assert.equal(result.summary.secret_scan_rules["generic-api-key"], 1);
    assert.match(output.join(""), /finding rule=generic-api-key path=home\/\.zshrc/);
    assert.doesNotMatch(output.join(""), /never print this/);
    assert.equal(readdirSync(scratch).length, 0);
    assert.equal(existsSync(join(scratch, "dotfiles-secret-scan")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret scan reports an unusable temporary root", () => {
  const { home, root } = fixture();
  const invalidTemporaryRoot = join(root, "not-a-directory");
  writeFileSync(invalidTemporaryRoot, "fixture\n");
  const policy = {
    name: "fixture",
    summary: "fixture summary",
    sections: [
      {
        title: "scan",
        checks: [{ kind: "secret-scan", sources: [{ kind: "path", path: ".zshrc" }] }],
      },
    ],
  } satisfies AuditPolicy;
  try {
    const result = runPolicy(policy, "json", {
      home,
      env: { HOME: home, TMPDIR: invalidTemporaryRoot },
      command: cleanCommand,
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.status, 1);
    assert.equal(result.summary.failed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret scans fail closed on invalid reports and incomplete execution", () => {
  const { home, root } = fixture();
  const policy = {
    name: "fixture",
    summary: "fixture",
    sections: [
      {
        title: "scan",
        checks: [{ kind: "secret-scan", sources: [{ kind: "path", path: ".zshrc" }] }],
      },
    ],
  } satisfies AuditPolicy;
  try {
    for (const [contents, status, error] of [
      ["not json", 0, undefined],
      ["", 0, undefined],
      ["{}", 0, undefined],
      ["[null]", 0, undefined],
      ["[]", 183, undefined],
      [JSON.stringify([{ RuleID: "generic-api-key" }]), 1, undefined],
      [
        JSON.stringify([{ RuleID: "generic-api-key" }]),
        183,
        new Error("private scanner diagnostic"),
      ],
      [JSON.stringify([{ RuleID: "generic-api-key" }]), 0, undefined],
    ] as const) {
      const output: string[] = [];
      const result = runPolicy(policy, "json", {
        home,
        env: { HOME: home, TMPDIR: join(root, "tmp") },
        command: (command, args) => {
          if (command === "gitleaks" && args[0] === "dir") {
            writeFileSync(args[args.indexOf("--report-path") + 1], contents);
            return { status, stdout: "", stderr: "", error };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
        stdout: (value) => output.push(value),
        stderr: (value) => output.push(value),
      });
      assert.equal(result.status, 1, `report ${contents} with status ${status}`);
      assert.doesNotMatch(output.join(""), /private scanner diagnostic/);
      assert.deepEqual(readdirSync(join(root, "tmp")), []);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit follows file symlinks and reports broken links and directory cycles", () => {
  const { home, root } = fixture();
  try {
    const key = join(root, "key-fixture");
    writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n", { mode: 0o644 });
    chmodSync(key, 0o644);
    symlinkSync(key, join(home, ".ssh/id_fixture"));
    symlinkSync(join(root, "missing"), join(home, ".ssh/broken"));
    symlinkSync(join(home, ".ssh"), join(home, ".ssh/cycle"));
    const output: string[] = [];
    const result = runPolicy(
      {
        name: "fixture",
        summary: "fixture",
        sections: [{ title: "SSH", checks: [{ kind: "ssh-private-key-modes", path: ".ssh" }] }],
      },
      "text",
      { home, stdout: (value) => output.push(value), stderr: (value) => output.push(value) },
    );
    assert.equal(result.status, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.warnings, 2);
    assert.match(output.join(""), /id_fixture.*group\/world accessible/);
    assert.match(output.join(""), /coverage skipped: .*broken/);
    assert.match(output.join(""), /coverage skipped: .*cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
