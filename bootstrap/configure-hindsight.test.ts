import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vite-plus/test";

import { CLIENT_OVERRIDE, wantedClient, wiredInText } from "../agents/hindsight.ts";

const script = resolve(import.meta.dirname, "configure-hindsight.ts");

type Fixture = ReturnType<typeof fixture>;

// A fake npm reports the published version; a fake npx records its arguments
// and wires the harness configs the way the real installer does.
function fixture(options: { published?: string; installed?: string; harnesses?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-hindsight-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const runtime = join(home, ".hindsight/coding-agents");
  const log = join(root, "npx.log");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const config = join(home, ".hindsight/coding-agent.json");
  writeFileSync(
    config,
    `${JSON.stringify({ serverMode: "self-hosted", apiUrl: "https://hindsight.example" })}\n`,
    { mode: 0o600 },
  );
  if (options.installed !== undefined)
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ version: options.installed }));
  writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "${options.published ?? "1.0.0"}"\n`, {
    mode: 0o700,
  });
  writeFileSync(
    join(bin, "npx"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
mkdir -p "$HOME/.hindsight/coding-agents" "$HOME/.codex" "$HOME/.grok"
printf '{"version":"${options.published ?? "1.0.0"}"}' > "$HOME/.hindsight/coding-agents/package.json"
for h in "$@"; do
  case "$h" in
    claude-code) printf '{"mcpServers":{"hindsight":{"env":{"HINDSIGHT_MCP_HARNESS":"claude-code"}}}}' > "$HOME/.claude.json";;
    codex) printf '[mcp_servers.hindsight.env]\\nHINDSIGHT_MCP_HARNESS = "codex"\\n\\n[mcp_servers.hindsight]\\ncommand = "node"\\n' > "$HOME/.codex/config.toml";;
    grok-build) printf '[mcp_servers.hindsight]\\ncommand = "node"\\nenv = { HINDSIGHT_MCP_HARNESS = "grok-build" }\\n' > "$HOME/.grok/config.toml";;
  esac
done
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}.curl"\nwhile [ "$1" != "-o" ]; do shift; done\nprintf 'not the pinned client' > "$2"\n`,
    { mode: 0o700 },
  );
  for (const harness of options.harnesses ?? ["claude", "codex", "grok"])
    writeFileSync(join(bin, harness), "#!/bin/sh\n", { mode: 0o700 });
  // The current Node's bin directory is not on PATH: mise installs npm-backed agents such as grok next to node.
  symlinkSync(process.execPath, join(bin, "node"));
  return {
    root,
    home,
    bin,
    log,
    // Only fixture binaries and system tools are visible, so host agents never leak in.
    env: {
      ...process.env,
      HOME: home,
      HINDSIGHT_CONFIG: "",
      PATH: `${bin}:/usr/bin:/bin`,
    },
  };
}

function run(paths: Fixture, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: paths.env });
}

function npxCalls(paths: Fixture): string[] {
  try {
    return readFileSync(paths.log, "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

test("installs the published runtime for present harnesses and then converges", (t) => {
  const paths = fixture({ published: "1.2.3" });
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  assert.equal(run(paths, ["--check"]).status, 1);

  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(npxCalls(paths), [
    "-y @vectorize-io/hindsight-coding-agents@latest install claude-code codex grok-build",
  ]);
  assert.match(result.stdout, /1\.2\.3 wired for claude-code, codex, grok-build/);

  const check = run(paths, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(run(paths).status, 0);
  assert.equal(npxCalls(paths).length, 1);
});

test("rewires a harness whose MCP entry lost its harness env", (t) => {
  const paths = fixture({ published: "1.0.0", installed: "1.0.0" });
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  assert.equal(run(paths).status, 0);
  mkdirSync(join(paths.home, ".grok"), { recursive: true });
  writeFileSync(
    join(paths.home, ".grok/config.toml"),
    '[mcp_servers.hindsight]\ncommand = "node"\n',
  );

  const check = run(paths, ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /Grok is not wired with HINDSIGHT_MCP_HARNESS/);
  assert.equal(run(paths).status, 0);
  assert.equal(npxCalls(paths).length, 2);
  assert.equal(run(paths, ["--check"]).status, 0);
});

test("installs the pinned client build only while npm publishes the release it patches", () => {
  const override = {
    base: "1.0.0",
    version: "1.0.1-fork.0",
    url: "https://example.test/client.tgz",
    sha256: "0".repeat(64),
  };
  assert.deepEqual(wantedClient("1.0.0", override), {
    version: "1.0.1-fork.0",
    tarball: { url: override.url, sha256: override.sha256 },
  });
  assert.deepEqual(wantedClient("1.0.1", override), { version: "1.0.1" });
  assert.deepEqual(wantedClient("1.0.0", undefined), { version: "1.0.0" });
});

test("accepts the pinned client build as converged", (t) => {
  if (CLIENT_OVERRIDE === undefined) return t.skip("no client override pinned");
  const paths = fixture({ published: CLIENT_OVERRIDE.base });
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  spawnSync(join(paths.bin, "npx"), ["install", "claude-code", "codex", "grok-build"], {
    env: paths.env,
  });
  writeFileSync(
    join(paths.home, ".hindsight/coding-agents/package.json"),
    JSON.stringify({ version: CLIENT_OVERRIDE.version }),
  );
  rmSync(paths.log);

  const check = run(paths, ["--check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.ok(check.stdout.includes(`${CLIENT_OVERRIDE.version} wired`), check.stdout);
  assert.deepEqual(npxCalls(paths), []);
});

test("refuses a pinned client download whose checksum differs", (t) => {
  if (CLIENT_OVERRIDE === undefined) return t.skip("no client override pinned");
  const paths = fixture({ published: CLIENT_OVERRIDE.base, installed: CLIENT_OVERRIDE.base });
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));

  const result = run(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`expected ${CLIENT_OVERRIDE.sha256}`));
  assert.ok(readFileSync(`${paths.log}.curl`, "utf8").endsWith(` ${CLIENT_OVERRIDE.url}\n`));
  assert.deepEqual(npxCalls(paths), []);
});

test("requires a machine-local server configuration and never writes one", (t) => {
  const paths = fixture();
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  const configPath = join(paths.home, ".hindsight/coding-agent.json");
  writeFileSync(configPath, `${JSON.stringify({ autoUpdate: true })}\n`, { mode: 0o600 });

  const result = run(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /has no server/);
  assert.match(result.stderr, /--api-url <url>/);
  assert.match(result.stderr, /Set apiToken .*private local editor/);
  assert.doesNotMatch(result.stderr, /--api-token <token>/);
  assert.deepEqual(npxCalls(paths), []);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { autoUpdate: true });
});

test("rejects a server configuration readable by others", (t) => {
  const paths = fixture();
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  const configPath = join(paths.home, ".hindsight/coding-agent.json");
  chmodSync(configPath, 0o644);
  const result = run(paths);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must not be readable by group or others/);
});

test("does nothing without a managed coding agent", (t) => {
  const paths = fixture({ harnesses: [] });
  t.onTestFinished(() => rmSync(paths.root, { recursive: true, force: true }));
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to wire/);
  assert.deepEqual(npxCalls(paths), []);
});

test("TOML wiring needs both the server table and the harness env", () => {
  assert.equal(wiredInText("grok", undefined), false);
  assert.equal(wiredInText("grok", '[mcp_servers.hindsight]\ncommand = "node"\n'), false);
  assert.equal(
    wiredInText(
      "grok",
      '[mcp_servers.hindsight]\ncommand = "node"\nenv = { HINDSIGHT_MCP_HARNESS = "grok-build" }\n',
    ),
    true,
  );
  assert.equal(
    wiredInText(
      "codex",
      '[mcp_servers.hindsight.env]\nHINDSIGHT_MCP_HARNESS = "codex"\n\n[mcp_servers.hindsight]\n',
    ),
    true,
  );
  assert.equal(wiredInText("codex", 'HINDSIGHT_MCP_HARNESS = "codex"\n'), false);
});

test("can be imported without running the configurator", () => {
  const paths = fixture();
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(script)})`],
    { encoding: "utf8", env: paths.env },
  );
  rmSync(paths.root, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(npxCalls(paths), []);
});
