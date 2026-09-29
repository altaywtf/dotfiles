#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "configure-codex.ts");
const codexInstalled = spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function run(home: string, profile = "workstation", userHome = process.env.HOME) {
  return spawnSync(script, ["--profile", profile], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home, HOME: userHome },
  });
}

function assertDefaults(contents: string): void {
  const root = contents.split(/^\[/m)[0];
  const features = contents.split(/^\[features\][ \t]*$/m)[1]?.split(/^\[/m)[0];
  assert.ok(features, "native config writer must create the features table");
  assert.match(root, /^model = "gpt-6\.1-sol"$/m);
  assert.match(root, /^model_reasoning_effort = "medium"$/m);
  assert.doesNotMatch(root, /^forced_login_method\s*=/m);
  assert.match(root, /^approval_policy = "on-request"$/m);
  assert.match(root, /^approvals_reviewer = "auto_review"$/m);
  assert.match(root, /^default_permissions = ":workspace"$/m);
  assert.doesNotMatch(root, /^sandbox_mode\s*=/m);
  for (const [table, line] of [
    ["analytics", "enabled = false"],
    ["feedback", "enabled = false"],
    ["otel", 'metrics_exporter = "none"'],
  ]) {
    const section = contents.split(new RegExp(`^\\[${table}\\][ \\t]*$`, "m"))[1]?.split(/^\[/m)[0];
    assert.ok(section?.split("\n").includes(line), `${table} must contain ${line}`);
  }
  assert.match(features, /^goals = true$/m);
  assert.match(features, /^memories = false$/m);
  assert.doesNotMatch(root, /^service_tier\s*=/m);
  assert.doesNotMatch(features, /^fast_mode\s*=/m);
  assert.match(contents, /^\[features\.context_management\]$/m);
  assert.match(
    contents.split(/^\[features\.context_management\][ \t]*$/m)[1].split(/^\[/m)[0],
    /^experimental_mode = true$/m,
  );
  const multiAgent = contents.split(/^\[features\.multi_agent_v2\][ \t]*$/m)[1]?.split(/^\[/m)[0];
  assert.ok(multiAgent, "native config writer must create the multi_agent_v2 table");
  assert.match(multiAgent, /^min_wait_timeout_ms = 120000$/m);
  assert.match(multiAgent, /^default_wait_timeout_ms = 120000$/m);
}

test(
  "installed Codex replaces full access with auto review, preserves unrelated config, and is idempotent",
  { skip: !codexInstalled },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-"));
    const home = join(root, "codex");
    const config = join(home, "config.toml");
    try {
      mkdirSync(home);
      writeFileSync(
        config,
        'forced_login_method = "chatgpt"\nservice_tier = "default"\n# keep this comment\napproval_policy = "never"\napprovals_reviewer = "user"\ndefault_permissions = ":danger-full-access"\nsandbox_mode = "danger-full-access"\n\n[features]\nfast_mode = false\n\n[mcp_servers.fixture]\ncommand = "example"\n',
      );
      chmodSync(config, 0o644);

      const first = run(home);
      assert.equal(first.status, 0, first.stderr);
      const contents = readFileSync(config, "utf8");
      assert.ok(contents.includes("# keep this comment"));
      assert.ok(contents.includes('[mcp_servers.fixture]\ncommand = "example"'));
      assertDefaults(contents);
      assert.equal(statSync(config).mode & 0o777, 0o600);

      const second = run(home);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(config, "utf8"), contents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("installed Codex clears Fast mode on personal profiles too", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-personal-config-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, 'service_tier = "fast"\n\n[features]\nfast_mode = true\n');
    const result = run(home, "personal-workstation");
    assert.equal(result.status, 0, result.stderr);
    assertDefaults(readFileSync(config, "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed Codex does not overwrite malformed input", { skip: !codexInstalled }, () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-codex-config-invalid-"));
  const home = join(root, "codex");
  const config = join(home, "config.toml");
  try {
    mkdirSync(home);
    writeFileSync(config, "model = [\n");
    const result = run(home);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(config, "utf8"), "model = [\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "installed Codex trusts project checkouts on personal and devbox profiles only",
  { skip: !codexInstalled },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dotfiles-codex-trust-")));
    const home = join(root, ".codex");
    const config = join(home, "config.toml");
    const repo = join(root, "projects/owner/repo");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(home, "sessions"), { recursive: true });
      chmodSync(home, 0o755);
      chmodSync(join(home, "sessions"), 0o755);
      const kept = `[projects."${root}"]\ntrust_level = "trusted"\n`;
      const gone = `[projects."${root}/projects/owner/gone"]\ntrust_level = "trusted"\n`;
      writeFileSync(config, `${kept}\n${gone}`);

      const skipped = run(home, "workstation", root);
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.ok(!readFileSync(config, "utf8").includes(repo));

      const first = run(home, "personal-devbox", root);
      assert.equal(first.status, 0, first.stderr);
      const contents = readFileSync(config, "utf8");
      assert.ok(contents.includes(kept));
      assert.ok(contents.includes(`[projects."${repo}"]\ntrust_level = "trusted"\n`));
      assert.ok(!contents.includes("owner/gone"));
      assert.equal(statSync(join(home, "sessions")).mode & 0o777, 0o700);

      const second = run(home, "personal-devbox", root);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(config, "utf8"), contents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
