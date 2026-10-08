#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";

import { codexInstalled, fixturePath, script, validConfig } from "./llm-gateway-fixture.ts";

test(
  "gateway-only payload configures canonical Grok and rollback restores its saved login",
  { skip: !codexInstalled },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-grok-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const codexHome = join(home, ".codex");
    const configDir = join(home, ".config/dotfiles");
    const gatewayConfig = join(configDir, "llm-gateway.json");
    const claudeSettingsPath = join(home, ".claude/settings.json");
    const grokBin = join(bin, "grok-vendor");
    const grokConfig = join(home, ".grok/config.toml");
    const grokLogin = join(home, ".grok/auth.json");
    const originalCodex = '# retained\nforced_login_method = "chatgpt"\n';
    const originalClaude = '{"theme":"dark"}\n';
    const originalGrokConfig = '[ui]\ntheme = "dark"\n';
    const originalGrokLogin = '{"access_token":"saved-vendor-login"}\n';

    try {
      for (const path of [
        codexHome,
        configDir,
        bin,
        dirname(claudeSettingsPath),
        dirname(grokLogin),
      ])
        mkdirSync(path, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), originalCodex, { mode: 0o600 });
      writeFileSync(claudeSettingsPath, originalClaude, { mode: 0o600 });
      writeFileSync(grokConfig, originalGrokConfig, { mode: 0o600 });
      writeFileSync(grokLogin, originalGrokLogin, { mode: 0o600 });
      writeFileSync(
        gatewayConfig,
        `${JSON.stringify({
          version: 3,
          credentials: {
            gatewai: validConfig.credentials.gatewai,
          },
          gatewaiBaseUrl: "https://gatewai.example/v1",
          grokBin,
        })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        grokBin,
        `#!/usr/bin/env bash
if [ "\${1:-}" = login ]; then
  printf '{"access_token":"gateway-token"}\\n' > "$HOME/.grok/auth.json"
  chmod 600 "$HOME/.grok/auth.json"
  exit 0
fi
printf "%s\\n" "$*"
`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(bin, "claude"),
        '#!/usr/bin/env bash\n[ "${1:-}" = auth ] && [ "${2:-}" = logout ]\n',
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
      assert.match(apply.stdout, /canonical Grok gateway routing/);
      assert.equal(readFileSync(grokLogin, "utf8"), originalGrokLogin);
      assert.equal(readFileSync(`${grokLogin}.llm-gateway.backup`, "utf8"), originalGrokLogin);
      assert.equal(readFileSync(`${grokConfig}.llm-gateway.backup`, "utf8"), originalGrokConfig);
      assert.match(
        readFileSync(grokConfig, "utf8"),
        /default = "grok-4\.7"\ndefault_reasoning_effort = "high"/,
      );
      assert.match(readFileSync(grokConfig, "utf8"), /\[ui\]\ntheme = "dark"/);
      const grok = spawnSync(grokBin, ["-p", "hello"], { encoding: "utf8", env });
      assert.equal(grok.status, 0, grok.stderr);
      assert.match(grok.stdout, /-p hello/);

      const state = JSON.parse(readFileSync(join(configDir, "llm-gateway-state.json"), "utf8")) as {
        version: number;
        grokEnabled: boolean;
      };
      assert.equal(state.version, 9);
      assert.equal(state.grokEnabled, true);
      const check = run("--check");
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /Grok=true/);

      const rollback = run("--rollback");
      assert.equal(rollback.status, 0, rollback.stderr);
      assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), originalCodex);
      assert.equal(readFileSync(claudeSettingsPath, "utf8"), originalClaude);
      assert.equal(readFileSync(grokConfig, "utf8"), originalGrokConfig);
      assert.equal(readFileSync(grokLogin, "utf8"), originalGrokLogin);
      assert.equal(existsSync(join(home, ".local/bin/grok-gateway")), false);
      assert.equal(existsSync(join(home, ".config/dotfiles/grok-gateway")), false);
      assert.equal(existsSync(`${grokConfig}.llm-gateway.backup`), false);
      assert.equal(existsSync(`${grokLogin}.llm-gateway.backup`), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "unsupported gateway state fails closed with migration instructions",
  { skip: !codexInstalled },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-invalid-"));
    const home = join(root, "home");
    const configDir = join(home, ".config/dotfiles");
    const gatewayConfig = join(configDir, "llm-gateway.json");
    const statePath = join(configDir, "llm-gateway-state.json");

    try {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(gatewayConfig, `${JSON.stringify(validConfig)}\n`, { mode: 0o600 });
      writeFileSync(
        statePath,
        `${JSON.stringify(
          {
            version: 2,
            codexConfigExisted: false,
            codexBackupPath: null,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      const env = { ...process.env, HOME: home, LLM_GATEWAY_CONFIG: gatewayConfig };
      for (const args of [[], ["--check"], ["--rollback"]]) {
        const result = spawnSync(script, args, { encoding: "utf8", env });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /state must use version 9/);
      }
      assert.equal(existsSync(statePath), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Grok joins and leaves an existing enrollment without restoring Codex snapshots",
  { skip: !codexInstalled },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-llm-gateway-grok-join-"));
    const home = join(root, "home");
    const bin = join(root, "bin");
    const codexHome = join(home, ".codex");
    const configDir = join(home, ".config/dotfiles");
    const gatewayConfig = join(configDir, "llm-gateway.json");
    const claudeSettingsPath = join(home, ".claude/settings.json");
    const grokBin = join(bin, "grok-vendor");
    const grokConfig = join(home, ".grok/config.toml");
    const grokLogin = join(home, ".grok/auth.json");
    const originalGrokConfig = '[ui]\ntheme = "dark"\n';
    const originalGrokLogin = '{"access_token":"saved-vendor-login"}\n';
    const gateway = (grok: boolean) =>
      `${JSON.stringify({
        version: 3,
        credentials: {
          gatewai: validConfig.credentials.gatewai,
        },
        gatewaiBaseUrl: "https://gatewai.example/v1",
        ...(grok ? { grokBin } : {}),
      })}\n`;

    try {
      for (const path of [
        codexHome,
        configDir,
        bin,
        dirname(claudeSettingsPath),
        dirname(grokLogin),
      ])
        mkdirSync(path, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), "# retained\n", { mode: 0o600 });
      writeFileSync(claudeSettingsPath, '{"theme":"dark"}\n', { mode: 0o600 });
      writeFileSync(grokConfig, originalGrokConfig, { mode: 0o600 });
      writeFileSync(grokLogin, originalGrokLogin, { mode: 0o600 });
      writeFileSync(gatewayConfig, gateway(false), { mode: 0o600 });
      writeFileSync(
        grokBin,
        `#!/usr/bin/env bash
if [ "\${1:-}" = login ]; then
  printf '{"access_token":"gateway-token"}\\n' > "$HOME/.grok/auth.json"
  chmod 600 "$HOME/.grok/auth.json"
fi
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
      const statePath = join(configDir, "llm-gateway-state.json");
      const readGrokState = () =>
        JSON.parse(readFileSync(statePath, "utf8")) as {
          grokEnabled: boolean;
          grokConfigBackupPath: string | null;
          grokAuthBackupPath: string | null;
        };

      const enroll = run();
      assert.equal(enroll.status, 0, enroll.stderr);
      assert.equal(readGrokState().grokEnabled, false);
      // Something added to Codex after enrollment must survive a client-set change.
      const codexConfigPath = join(codexHome, "config.toml");
      writeFileSync(
        codexConfigPath,
        `${readFileSync(codexConfigPath, "utf8")}\n[marketplaces.later]\nsource_type = "git"\n`,
      );

      writeFileSync(gatewayConfig, gateway(true), { mode: 0o600 });
      const join_ = run();
      assert.equal(join_.status, 0, join_.stderr);
      assert.match(join_.stdout, /canonical Grok gateway routing/);
      assert.match(readFileSync(codexConfigPath, "utf8"), /\[marketplaces\.later\]/);
      assert.match(
        readFileSync(grokConfig, "utf8"),
        /default = "grok-4\.7"\ndefault_reasoning_effort = "high"/,
      );
      assert.equal(readFileSync(`${grokConfig}.llm-gateway.backup`, "utf8"), originalGrokConfig);
      assert.equal(readFileSync(`${grokLogin}.llm-gateway.backup`, "utf8"), originalGrokLogin);
      assert.equal(readGrokState().grokEnabled, true);
      const check = run("--check");
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /Grok=true/);

      writeFileSync(gatewayConfig, gateway(false), { mode: 0o600 });
      const leave = run();
      assert.equal(leave.status, 0, leave.stderr);
      assert.match(readFileSync(codexConfigPath, "utf8"), /\[marketplaces\.later\]/);
      assert.equal(readFileSync(grokConfig, "utf8"), originalGrokConfig);
      assert.equal(readFileSync(grokLogin, "utf8"), originalGrokLogin);
      assert.equal(existsSync(`${grokConfig}.llm-gateway.backup`), false);
      assert.equal(existsSync(`${grokLogin}.llm-gateway.backup`), false);
      assert.deepEqual(readGrokState(), {
        ...readGrokState(),
        grokEnabled: false,
        grokConfigBackupPath: null,
        grokAuthBackupPath: null,
      });
      assert.equal(run("--check").status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
