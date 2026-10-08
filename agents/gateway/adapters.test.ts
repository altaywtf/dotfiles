import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, test, type TestContext } from "vite-plus/test";
import { bundleGatewayHelpers, gatewayInterpreter, type GatewayHelper } from "./bundle.ts";

let bundles: Record<GatewayHelper, string>;
beforeAll(async () => {
  bundles = await bundleGatewayHelpers();
});

function fixture(t: TestContext, installedBundles = bundles) {
  const root = mkdtempSync(join(tmpdir(), "gateway-adapters-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const installed = join(home, ".local/libexec/dotfiles");
  const bin = join(root, "bin");
  mkdirSync(installed, { recursive: true });
  mkdirSync(bin);
  for (const [name, contents] of Object.entries(installedBundles))
    writeFileSync(join(installed, name), contents, { mode: 0o700 });
  const config = {
    version: 3,
    credentials: { gatewai: "0123456789abcdefghijklmnopqrstuvwxyz_ABCD" },
    gatewaiBaseUrl: "https://gateway.example/v1",
  };
  const configPath = join(home, ".config/dotfiles/llm-gateway.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: home,
    PATH: bin,
    NODE_PATH: "",
    LLM_GATEWAY_CONFIG: undefined,
  };
  const run = (name: GatewayHelper, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(installed, name), args, {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...extra },
      timeout: 10_000,
    });
  return { root, home, bin, installed, config, configPath, env, run };
}

test("installed adapters run outside the checkout with no module graph, jq, Python, or Node on PATH", (t) => {
  const f = fixture(t);
  assert.equal(existsSync(join(f.root, "node_modules")), false);
  const result = f.run("llm-gateway-credential", ["gatewai"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), f.config.credentials.gatewai);
  assert.equal(result.stderr, "");
  const unknown = f.run("llm-gateway-credential", ["unknown"]);
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
});

test("credential validation is fail closed and never includes rejected payloads in diagnostics", (t) => {
  const f = fixture(t);
  chmodSync(f.configPath, 0o644);
  const permissions = f.run("llm-gateway-credential", ["gatewai"]);
  assert.notEqual(permissions.status, 0);
  assert.equal(permissions.stdout, "");
  assert.match(permissions.stderr, /0600/);
  chmodSync(f.configPath, 0o600);
  const rejected = "rejected-credential-payload";
  writeFileSync(
    f.configPath,
    JSON.stringify({ ...f.config, credentials: { ...f.config.credentials, gatewai: rejected } }),
  );
  const invalid = f.run("llm-gateway-credential", ["gatewai"]);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.ok(!invalid.stderr.includes(rejected));
  const other = `${f.configPath}.regular`;
  writeFileSync(other, JSON.stringify(f.config), { mode: 0o600 });
  rmSync(f.configPath);
  symlinkSync(other, f.configPath);
  const linked = f.run("llm-gateway-credential", ["gatewai"]);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /regular gateway config/);
});

test("Codex launcher pins installed credentials across redirected HOME without putting credentials in argv or env", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bin, "codex"),
    `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), config: process.env.LLM_GATEWAY_CONFIG, cursor: process.env.CURSOR_API_KEY || null, gatewai: process.env.CLIPROXYAPI_CLIENT_API_KEY || null }));
`,
    { mode: 0o700 },
  );
  const result = f.run("codex-gatewai", ["--ignore-user-config", "exec", "fixture"], {
    HOME: join(f.root, "redirected"),
    CURSOR_API_KEY: undefined,
    CLIPROXYAPI_CLIENT_API_KEY: undefined,
  });
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(result.stdout) as {
    args: string[];
    config: string;
    cursor: null;
    gatewai: null;
  };
  assert.equal(received.config, f.configPath);
  assert.ok(
    received.args.includes(
      `model_providers.gatewai.auth.command=${JSON.stringify(join(f.installed, "llm-gateway-credential"))}`,
    ),
  );
  assert.deepEqual(received.args.slice(-3), ["--ignore-user-config", "exec", "fixture"]);
  assert.equal(received.cursor, null);
  assert.equal(received.gatewai, null);
  assert.ok(!result.stdout.includes(f.config.credentials.gatewai));
});

test("mise interpreter path survives pruning the version used during enrollment", (t) => {
  const f = fixture(t);
  const versions = join(f.root, "mise/installs/node");
  const initial = join(versions, "24.1.0/bin/node");
  const replacement = join(versions, "24.2.0/bin/node");
  for (const path of [initial, replacement]) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(process.execPath, path);
  }
  const latest = join(versions, "latest");
  symlinkSync(join(versions, "24.1.0"), latest);
  const interpreter = gatewayInterpreter(initial);
  assert.equal(interpreter, join(latest, "bin/node"));
  const helper = join(f.root, "probe");
  writeFileSync(helper, `#!${interpreter}\nconsole.log("ready");\n`, { mode: 0o700 });
  rmSync(latest);
  symlinkSync(join(versions, "24.2.0"), latest);
  rmSync(join(versions, "24.1.0"), { recursive: true });
  const result = spawnSync(helper, { encoding: "utf8", env: { PATH: f.bin, HOME: f.root } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready\n");
});

test("installed bundles handle quoted interpreter paths and ancestor ESM packages", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gateway quoted interpreter "));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "Node's installs with spaces");
  mkdirSync(directory);
  const interpreter = join(directory, "node");
  symlinkSync(process.execPath, interpreter);
  const f = fixture(t, await bundleGatewayHelpers(interpreter));
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ type: "module" }));
  const credential = f.run("llm-gateway-credential", ["gatewai"]);
  assert.equal(credential.status, 0, credential.stderr);
  assert.equal(credential.stdout.trim(), f.config.credentials.gatewai);
});
