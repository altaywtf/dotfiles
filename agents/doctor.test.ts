import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { main } from "./doctor.ts";
import { type Runtime } from "./runtime.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class BufferWriter {
  value = "";
  write(message: string): void {
    this.value += message;
  }
}

type Reply = { status?: number; stdout?: string; stderr?: string };

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly installedCommands = new Set(["claude", "codex", "grok", "sh"]);
  readonly repoDir: string;
  readonly replies: ReadonlyMap<string, Reply>;

  constructor(repoDir: string, home: string, replies: ReadonlyMap<string, Reply>) {
    this.repoDir = repoDir;
    this.env = { HOME: home, PWD: "/fixture/project" };
    // The healthy Grok path is the mise shim under the fixture home.
    this.replies = new Map(
      [...replies].map(([command, reply]) => [
        command,
        { ...reply, stdout: reply.stdout?.replaceAll("$HOME", home) },
      ]),
    );
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]) {
    if (command.endsWith("/resolve-profile.ts"))
      return { status: 0, stdout: "workstation\n", stderr: "" };
    const reply = this.replies.get(`${command} ${args.join(" ")}`) ?? {};
    return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-doctor-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repoDir, "chezmoi/.chezmoidata"), { recursive: true });
  mkdirSync(join(repoDir, "agents/mcps"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi/.chezmoidata/profiles.json"),
    readFileSync(join(repoRoot, "chezmoi/.chezmoidata/profiles.json")),
  );
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    writeFileSync(
      join(repoDir, `agents/mcps/${layer}.json`),
      JSON.stringify({
        servers:
          layer === "developer"
            ? [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }]
            : [],
      }),
    );
  }
  return { repoDir, home };
}

const healthy = new Map<string, Reply>([
  [
    "claude mcp get shared-mcp",
    { stdout: "shared-mcp:\n  Status: ✔ Connected\n  URL: https://mcp.fixture.test/mcp\n" },
  ],
  [
    "codex mcp list --json",
    { stdout: JSON.stringify([{ name: "shared-mcp", auth_status: "o_auth" }]) },
  ],
  [
    "grok mcp doctor --json",
    {
      stdout: JSON.stringify({
        servers: [
          {
            name: "shared-mcp",
            healthy: true,
            checks: [{ label: "9 tools discovered", passed: true }],
          },
        ],
      }),
    },
  ],
  [
    "which -a grok",
    {
      stdout:
        "$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41/bin/grok\n$HOME/.local/share/mise/shims/grok\n",
    },
  ],
  [
    "mise which grok",
    { stdout: "$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41/bin/grok\n" },
  ],
  [
    "mise where npm:@xai-official/grok",
    { stdout: "$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41\n" },
  ],
  ["npm ls --global --json --depth=0 @xai-official/grok", { status: 1, stdout: "{}\n" }],
]);

test("reports every harness usable and exits 0", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /ok {4}Claude Code: shared-mcp - connected/);
  assert.match(runtime.stdout.value, /\? {5}Codex: shared-mcp - o_auth/);
  assert.match(runtime.stdout.value, /ok {4}Grok: shared-mcp - 9 tools discovered/);
  assert.match(runtime.stdout.value, /All managed MCP servers are usable\./);
  assert.doesNotMatch(runtime.stdout.value, /repair:/);
});

test("names the login command for each expired harness and exits 1", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("claude mcp get shared-mcp", {
    stdout: "shared-mcp:\n  Status: ! Needs authentication\n",
  });
  replies.set("grok mcp doctor --json", {
    stdout: JSON.stringify({
      servers: [
        {
          name: "shared-mcp",
          healthy: false,
          checks: [
            {
              label: "handshake failed",
              passed: false,
              detail: "error: Auth required, when send initialize request",
            },
          ],
        },
      ],
    }),
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /LOGIN Claude Code: shared-mcp[^\n]*\n {6}repair: claude mcp login shared-mcp/,
  );
  assert.match(
    runtime.stdout.value,
    /LOGIN Grok: shared-mcp[^\n]*\n {6}repair: \.\/agents\/grok-mcp-login\.ts shared-mcp/,
  );
  assert.match(runtime.stdout.value, /2 MCP server state\(s\) need attention\./);
});

test("flags Grok config parse errors and installation drift", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("grok mcp doctor --json", {
    stdout: "",
    stderr:
      "ERROR config toml has syntax errors: TOML parse error at line 66, column 14: duplicate key file=/h/.grok/config.toml",
  });
  replies.set("which -a grok", {
    stdout:
      "/opt/homebrew/bin/grok\n$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /FAIL {2}Grok: shared-mcp - ~\/\.grok\/config\.toml does not parse: TOML parse error/,
  );
  assert.match(
    runtime.stdout.value,
    /FAIL {2}Grok: install - grok resolves to \/opt\/homebrew\/bin\/grok, not the mise pin/,
  );
  assert.match(
    runtime.stdout.value,
    /repair: remove \/opt\/homebrew\/bin\/grok with its installer/,
  );
});

test("accepts the mise pin as Grok's managed install", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", { stdout: "$HOME/.local/share/mise/shims/grok\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 0);
  assert.doesNotMatch(runtime.stdout.value, /Grok: install/);
});

test("reports a global npm Grok under a mise-managed Node", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", {
    stdout: "$HOME/.local/share/mise/installs/node/24.21.0/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to .*installs\/node\//);
});

test("reports a global npm Grok the mise shim dispatches to", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("mise which grok", {
    stdout: "$HOME/.local/share/mise/installs/node/24.21.0/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to .*installs\/node\//);
});

test("reports a mise shim that resolves to another provider", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("mise which grok", {
    stdout: "$HOME/.local/share/mise/installs/npm-other-grok/2.0.0/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to .*npm-other-grok/);
});

test("reports a mise shim that mise cannot resolve", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("mise which grok", { status: 1, stderr: "grok is not a mise bin" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /Grok: install - grok resolves to .*shims\/grok, which mise cannot resolve/,
  );
});

test("reports a shim that dispatches away from the pin when the pin comes first on PATH", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("mise which grok", {
    stdout: "$HOME/.local/share/mise/installs/node/24.21.0/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to .*installs\/node\//);
});

test("reports a foreign Grok later on PATH", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", {
    stdout:
      "$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41/bin/grok\n/opt/homebrew/bin/grok\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to \/opt\/homebrew\/bin\/grok/);
});

test("reports a global npm Grok that PATH does not expose", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("npm ls --global --json --depth=0 @xai-official/grok", {
    stdout: JSON.stringify({
      name: "lib",
      dependencies: { "@xai-official/grok": { version: "1.0.40" } },
    }),
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /Grok: install - npm has a global @xai-official\/grok 1\.0\.40 install/,
  );
});

test("accepts Grok's pin-aligned staged binary on PATH", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", {
    stdout:
      "$HOME/.local/share/mise/installs/npm-xai-official-grok/1.0.41/bin/grok\n$HOME/.grok/bin/grok\n",
  });
  replies.set(`readlink ${home}/.grok/bin/grok`, { stdout: "grok-1.0.41\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 0);
  assert.doesNotMatch(runtime.stdout.value, /Grok: install/);
});

test("reports a staged Grok link left on an older version", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", {
    stdout: "$HOME/.grok/bin/grok\n$HOME/.local/share/mise/shims/grok\n",
  });
  replies.set(`readlink ${home}/.grok/bin/grok`, { stdout: "grok-1.0.40\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /Grok: install - .*\.grok\/bin\/grok links to grok-1\.0\.40, not grok-1\.0\.41/,
  );
});

test("reports a foreign Grok once when PATH lists it and a shim resolving to it", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", {
    stdout: "$HOME/.local/share/mise/shims/grok\n/opt/homebrew/bin/grok\n",
  });
  replies.set("mise which grok", { stdout: "/opt/homebrew/bin/grok\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.equal(runtime.stdout.value.match(/Grok: install/g)?.length, 1);
});

test("checks Grok installation drift for profiles without Grok MCP servers", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(join(repoDir, "agents/mcps/developer.json"), JSON.stringify({ servers: [] }));
  const replies = new Map(healthy);
  replies.set("which -a grok", { stdout: "/opt/homebrew/bin/grok\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - grok resolves to \/opt\/homebrew\/bin\/grok/);
});

test("reports a global npm Grok once when the shim already resolves to it", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("mise which grok", {
    stdout: "$HOME/.local/share/mise/installs/node/24.21.0/bin/grok\n",
  });
  replies.set("npm ls --global --json --depth=0 @xai-official/grok", {
    stdout: JSON.stringify({ dependencies: { "@xai-official/grok": { version: "1.0.40" } } }),
  });
  replies.set("npm prefix --global", { stdout: "$HOME/.local/share/mise/installs/node/24.21.0\n" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.equal(runtime.stdout.value.match(/Grok: install/g)?.length, 1);
});

test("reports when PATH cannot be listed for Grok", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("which -a grok", { status: 127, stderr: "spawnSync which ENOENT" });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(runtime.stdout.value, /Grok: install - cannot list grok on PATH/);
});

test("skips harnesses that are not installed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  runtime.installedCommands.delete("grok");
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Skipping Grok: 'grok' is not installed/);
});
