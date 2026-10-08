#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";

import {
  claudeGatewayBaseUrl,
  claudeGatewaySettings,
  grokGatewaySettings,
} from "../agents/gateway/enrollment.ts";
import {
  codexGatewaiOverrides,
  gatewayEdits,
  parseGatewayConfig,
} from "../agents/gateway/gateway-config.ts";
import { codexInstalled, fixturePath, script, validConfig } from "./llm-gateway-fixture.ts";

for (const configExisted of [false, true]) {
  test(
    `Grok maintenance preserves new preferences with ${configExisted ? "existing" : "absent"} initial config`,
    { skip: !codexInstalled },
    () => {
      const root = mkdtempSync(join(tmpdir(), "dotfiles-grok-maintenance-"));
      try {
        const home = join(root, "home");
        const bin = join(root, "bin");
        const codexHome = join(home, ".codex");
        const configDir = join(home, ".config/dotfiles");
        const gatewayConfig = join(configDir, "llm-gateway.json");
        const grokConfig = join(home, ".grok/config.toml");
        const backup = `${grokConfig}.llm-gateway.backup`;
        const grokBin = join(bin, "grok");
        const original = '[ui]\ntheme = "dark"\n';
        for (const directory of [bin, codexHome, configDir, dirname(grokConfig)])
          mkdirSync(directory, { recursive: true });
        writeFileSync(join(codexHome, "config.toml"), "# fixture\n", { mode: 0o600 });
        if (configExisted) writeFileSync(grokConfig, original, { mode: 0o600 });
        writeFileSync(
          gatewayConfig,
          JSON.stringify({
            version: validConfig.version,
            credentials: validConfig.credentials,
            gatewaiBaseUrl: validConfig.gatewaiBaseUrl,
            grokBin,
          }),
          { mode: 0o600 },
        );
        writeFileSync(
          grokBin,
          `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] !== "login") process.exit(2);
process.exit(99);
`,
          { mode: 0o700 },
        );
        const env = {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          LLM_GATEWAY_CONFIG: gatewayConfig,
          PATH: fixturePath(bin),
        };
        const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });
        const apply = run();
        assert.equal(apply.status, 0, apply.stderr);
        assert.match(readFileSync(grokConfig, "utf8"), /# BEGIN dotfiles LLM gateway/);
        assert.equal(existsSync(join(home, ".grok/auth.json")), false);
        if (configExisted) assert.equal(readFileSync(backup, "utf8"), original);
        else assert.equal(existsSync(backup), false);
        const edited =
          readFileSync(grokConfig, "utf8").replace('theme = "dark"', 'theme = "light"') +
          "\n[editor]\nline_numbers = true\n";
        writeFileSync(grokConfig, edited, { mode: 0o600 });
        const editedCheck = run("--check");
        assert.equal(editedCheck.status, 0, editedCheck.stderr);
        const maintenance = run("--maintenance");
        assert.equal(maintenance.status, 0, maintenance.stderr);
        const maintained = readFileSync(grokConfig, "utf8");
        assert.match(maintained, /\[editor\]\nline_numbers = true/);
        if (configExisted) assert.match(maintained, /theme = "light"/);
        const check = run("--check");
        assert.equal(check.status, 0, check.stderr);
        assert.equal(readFileSync(grokConfig, "utf8"), maintained);
        if (configExisted) assert.equal(readFileSync(backup, "utf8"), original);
        else assert.equal(existsSync(backup), false);
        writeFileSync(
          grokConfig,
          maintained.replace('auth_provider_label = "Gatewai"', 'auth_provider_label = "Other"'),
        );
        assert.notEqual(run("--check").status, 0);
        writeFileSync(grokConfig, maintained);
        const rollback = run("--rollback");
        assert.equal(rollback.status, 0, rollback.stderr);
        if (configExisted) assert.equal(readFileSync(grokConfig, "utf8"), original);
        else assert.equal(existsSync(grokConfig), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("gateway config is strict and provider edits use command-backed Responses auth", () => {
  const config = parseGatewayConfig(JSON.stringify(validConfig));
  assert.throws(
    () => parseGatewayConfig(JSON.stringify({ ...validConfig, token: "secret" })),
    /unknown field/,
  );
  assert.throws(
    () =>
      parseGatewayConfig(
        JSON.stringify({ ...validConfig, gatewaiBaseUrl: "http://gatewai.example/v1" }),
      ),
    /HTTPS \/v1 URL/,
  );
  const edits = gatewayEdits(
    config,
    "/Users/example/.local/libexec/dotfiles/llm-gateway-credential",
  );
  assert.equal(
    edits.some((edit) => edit.keyPath === "forced_login_method"),
    false,
  );
  assert.ok(edits.some((edit) => edit.keyPath === "features.apps" && edit.value === false));
  assert.ok(
    edits.some(
      (edit) => edit.keyPath === "model_providers.gatewai.name" && edit.value === "Gatewai",
    ),
  );
  assert.ok(
    edits.some(
      (edit) =>
        edit.keyPath === "model_providers.gatewai.supports_websockets" && edit.value === true,
    ),
  );
  assert.ok(
    edits.some(
      (edit) =>
        edit.keyPath === "model_providers.gatewai.http_headers" &&
        JSON.stringify(edit.value) ===
          JSON.stringify({ "X-OpenAI-Actor-Authorization": "local-proxy" }),
    ),
  );
  const overrides = codexGatewaiOverrides(
    config,
    "/Users/example/.local/libexec/dotfiles/llm-gateway-credential",
  );
  assert.ok(
    overrides.includes(
      'model_providers.gatewai.http_headers={"X-OpenAI-Actor-Authorization" = "local-proxy"}',
    ),
  );
  assert.ok(
    edits.some(
      (edit) =>
        edit.keyPath === "model_providers.gatewai.auth.args" &&
        Array.isArray(edit.value) &&
        edit.value[0] === "gatewai",
    ),
  );
  assert.equal(
    edits.some((edit) => edit.keyPath.includes("env_key") || edit.keyPath.includes("bearer_token")),
    false,
  );

  assert.equal(claudeGatewayBaseUrl(config.gatewaiBaseUrl), "https://gatewai.example");
  assert.deepEqual(
    claudeGatewaySettings(
      '{"theme":"dark","env":{"KEEP":"yes"}}',
      config.gatewaiBaseUrl,
      "/Users/example/.local/libexec/dotfiles/llm-gateway-credential",
    ),
    {
      theme: "dark",
      apiKeyHelper: "/Users/example/.local/libexec/dotfiles/llm-gateway-credential gatewai",
      env: { KEEP: "yes", ANTHROPIC_BASE_URL: "https://gatewai.example" },
    },
  );
  assert.throws(
    () =>
      claudeGatewaySettings(
        '{"env":{"ANTHROPIC_API_KEY":"conflict"}}',
        validConfig.gatewaiBaseUrl,
        "/helper",
      ),
    /conflicts with the gateway/,
  );

  assert.match(
    grokGatewaySettings('[ui]\ntheme = "dark"\n', config.gatewaiBaseUrl, "/helper"),
    /models_base_url = "https:\/\/gatewai\.example\/v1"/,
  );
  assert.match(
    grokGatewaySettings("", config.gatewaiBaseUrl, "/helper"),
    /auth_provider_command = "\/helper gatewai"/,
  );
  const unmarked = grokGatewaySettings("", config.gatewaiBaseUrl, "/helper")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const nativeRewrite = unmarked.replace("auth_token_ttl = 3600", "auth_token_ttl = 3_600");
  assert.equal(
    grokGatewaySettings(nativeRewrite, config.gatewaiBaseUrl, "/helper"),
    grokGatewaySettings("", config.gatewaiBaseUrl, "/helper"),
  );
  assert.throws(
    () => grokGatewaySettings(`${unmarked}extra = true\n`, config.gatewaiBaseUrl, "/helper"),
    /conflicts with gateway section/,
  );
  assert.throws(
    () =>
      grokGatewaySettings(
        '[auth]\nauth_provider_command = "/other"\n',
        config.gatewaiBaseUrl,
        "/helper",
      ),
    /conflicts with gateway section: auth/,
  );
});

test(
  "setup and maintenance preserve login state and rollback restores configuration",
  { skip: !codexInstalled },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const codexHome = join(home, ".codex");
    const configDir = join(home, ".config/dotfiles");
    const gatewayConfig = join(configDir, "llm-gateway.json");
    const claudeSettingsPath = join(home, ".claude/settings.json");
    const originalCodex =
      '# retained\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "high"\nforced_login_method = "chatgpt"\n';
    const originalAuth = '{"tokens":"saved-login-state"}\n';
    const originalClaudeAuth = '{"oauth":"saved-login-state"}\n';
    const originalClaudeSettings =
      '{"permissions":{"defaultMode":"auto"},"env":{"KEEP":"yes"},"theme":"dark"}\n';
    try {
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(dirname(claudeSettingsPath), { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), originalCodex, { mode: 0o600 });
      writeFileSync(join(codexHome, "auth.json"), originalAuth, { mode: 0o600 });
      writeFileSync(join(home, ".claude/.credentials.json"), originalClaudeAuth, { mode: 0o600 });
      writeFileSync(claudeSettingsPath, originalClaudeSettings, { mode: 0o600 });
      writeFileSync(gatewayConfig, `${JSON.stringify(validConfig)}\n`, { mode: 0o600 });
      writeFileSync(
        join(bin, "claude"),
        `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = auth ] && [ "\${2:-}" = logout ] || exit 2
rm -f "$HOME/.claude/.credentials.json"
`,
        { mode: 0o700 },
      );

      const env = {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        LLM_GATEWAY_CONFIG: gatewayConfig,
        PATH: fixturePath(bin),
      };
      const run = (...args: string[]) => spawnSync(script, args, { encoding: "utf8", env });

      const apply = run();
      assert.equal(apply.status, 0, apply.stderr);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
      assert.equal(statSync(join(codexHome, "config.toml")).mode & 0o777, 0o600);
      const appliedCodex = readFileSync(join(codexHome, "config.toml"), "utf8");
      assert.match(appliedCodex, /^model = "gpt-6-astra"$/m);
      assert.match(appliedCodex, /^model_reasoning_effort = "high"$/m);
      assert.match(appliedCodex, /model_provider = "gatewai"/);
      assert.match(appliedCodex, /supports_websockets = true/);
      assert.match(appliedCodex, /X-OpenAI-Actor-Authorization = "local-proxy"/);
      assert.match(appliedCodex, /forced_login_method = "chatgpt"/);
      const appliedClaude = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
        apiKeyHelper: string;
        env: Record<string, string>;
        permissions: Record<string, string>;
        theme: string;
      };
      assert.equal(
        appliedClaude.apiKeyHelper,
        `${join(home, ".local/libexec/dotfiles/llm-gateway-credential")} gatewai`,
      );
      assert.equal(appliedClaude.env.ANTHROPIC_BASE_URL, "https://gatewai.example");
      assert.equal(appliedClaude.env.KEEP, "yes");
      assert.equal(appliedClaude.permissions.defaultMode, "auto");
      assert.equal(appliedClaude.theme, "dark");
      assert.equal(statSync(claudeSettingsPath).mode & 0o777, 0o600);

      const second = run("--maintenance");
      assert.equal(second.status, 0, second.stderr);
      const maintainedCodex = readFileSync(join(codexHome, "config.toml"), "utf8");
      assert.match(maintainedCodex, /^model = "gpt-6-astra"$/m);
      assert.match(maintainedCodex, /^model_reasoning_effort = "high"$/m);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
      assert.equal(
        readFileSync(join(home, ".claude/.credentials.json"), "utf8"),
        originalClaudeAuth,
      );

      const failingCodex = join(bin, "failing-codex");
      writeFileSync(failingCodex, "#!/bin/sh\nexit 17\n", { mode: 0o700 });
      const failedSetup = spawnSync(script, ["--setup"], {
        encoding: "utf8",
        env: { ...env, CODEX_BIN: failingCodex },
      });
      assert.notEqual(failedSetup.status, 0);
      assert.match(failedSetup.stderr, /Codex app-server exited 17/);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
      assert.equal(
        readFileSync(join(home, ".claude/.credentials.json"), "utf8"),
        originalClaudeAuth,
      );
      assert.equal(
        readFileSync(join(codexHome, "config.toml.llm-gateway.backup"), "utf8"),
        originalCodex,
      );
      assert.equal(
        readFileSync(`${claudeSettingsPath}.llm-gateway.backup`, "utf8"),
        originalClaudeSettings,
      );

      const check = run("--check");
      assert.equal(check.status, 0, check.stderr);
      const setup = run("--setup");
      assert.equal(setup.status, 0, setup.stderr);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
      assert.equal(
        readFileSync(join(home, ".claude/.credentials.json"), "utf8"),
        originalClaudeAuth,
      );

      const rollback = run("--rollback");
      assert.equal(rollback.status, 0, rollback.stderr);
      assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), originalCodex);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), originalAuth);
      assert.equal(
        readFileSync(join(home, ".claude/.credentials.json"), "utf8"),
        originalClaudeAuth,
      );
      assert.equal(readFileSync(claudeSettingsPath, "utf8"), originalClaudeSettings);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
