import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";
import { main } from "./mcps.ts";
import { HARNESSES } from "./harness.ts";
import { type Runtime } from "./runtime.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileModel = readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));

type CommandCall = {
  command: string;
  args: readonly string[];
};

type FixtureFailure = {
  stderr: string;
  stdout: string;
};

type FixtureResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type FixtureOptions = {
  failures?: ReadonlyMap<string, FixtureFailure>;
  outputs?: ReadonlyMap<string, string>;
  // Consumed one result per call for commands whose outcome changes between calls.
  sequences?: ReadonlyMap<string, FixtureResult[]>;
  profile?: string;
};

class BufferWriter {
  value = "";

  write(message: string): void {
    this.value += message;
  }
}

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly calls: CommandCall[] = [];
  readonly installedCommands = new Set(["claude", "codex"]);
  readonly failures: ReadonlyMap<string, FixtureFailure>;
  readonly outputs: ReadonlyMap<string, string>;
  readonly sequences: Map<string, FixtureResult[]>;
  readonly profile: string;
  readonly repoDir: string;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.failures = options.failures ?? new Map();
    this.outputs = options.outputs ?? new Map();
    this.sequences = new Map(options.sequences ?? []);
    this.profile = options.profile ?? "workstation";
    this.env = { HOME: home };
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(
    command: string,
    args: readonly string[],
  ): { status: number; stdout: string; stderr: string } {
    this.calls.push({ command, args });

    if (command.endsWith("/resolve-profile.ts")) {
      const expectedFlag = args.indexOf("--expected");
      const expected = expectedFlag >= 0 ? args[expectedFlag + 1] : undefined;
      if (expected !== undefined && expected !== this.profile) {
        return { status: 3, stdout: "", stderr: "profile mismatch" };
      }
      if (!Object.hasOwn(profileModel.profiles, this.profile)) {
        return { status: 3, stdout: "", stderr: "unknown profile" };
      }
      return { status: 0, stdout: `${this.profile}\n`, stderr: "" };
    }

    const key = `${command} ${args.join(" ")}`;
    const sequence = this.sequences.get(key);
    if (sequence !== undefined && sequence.length > 0) {
      return sequence.shift() as FixtureResult;
    }

    const diagnostic = this.failures.get(key);
    if (diagnostic !== undefined) {
      return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
    }
    return { status: 0, stdout: this.outputs.get(key) ?? "", stderr: "" };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSharedMcps = [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }];

const fixturePersonalMcps = [
  { name: "personal-mcp", url: "https://personal.fixture.test/mcp", harnesses: ["claude"] },
];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-mcps-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "agents", "mcps"), { recursive: true });
  mkdirSync(join(repoDir, "chezmoi", ".chezmoidata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".local/state/dotfiles/agents"), { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi", ".chezmoidata", "profiles.json"),
    readFileSync(join(repoRoot, "chezmoi", ".chezmoidata", "profiles.json")),
  );
  writeManifest(repoDir, "developer", fixtureSharedMcps);
  writeManifest(repoDir, "workstation", []);
  writeManifest(repoDir, "devbox", []);
  writeManifest(repoDir, "personal", fixturePersonalMcps);

  return { repoDir, home };
}

function writeManifest(repoDir: string, layer: string, mcps: unknown): void {
  writeFileSync(
    join(repoDir, "agents", "mcps", `${layer}.json`),
    JSON.stringify({ mcps }, null, 2),
  );
}

function harnessCalls(runtime: FixtureRuntime, binary: string): string[] {
  return runtime.calls.filter((call) => call.command === binary).map((call) => call.args.join(" "));
}

function mcpLockPath(home: string): string {
  return join(home, ".local/state/dotfiles/agents", "mcps.lock.json");
}

function writeMcpLock(home: string, mcps: unknown): void {
  mkdirSync(dirname(mcpLockPath(home)), { recursive: true });
  writeFileSync(mcpLockPath(home), JSON.stringify({ version: 1, mcps }, null, 2));
}

test("adds each mcp its harness config does not know", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["claude mcp get shared-mcp", { stdout: "", stderr: "not found" }]]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "mcp get shared-mcp",
    "mcp add -t http -s user shared-mcp https://mcp.fixture.test/mcp",
  ]);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "mcp get shared-mcp",
    "mcp add shared-mcp --url https://mcp.fixture.test/mcp",
  ]);
  assert.match(runtime.stdout.value, /MCP layers: developer, workstation/);
  assert.match(runtime.stdout.value, /Done\./);
});

test.each([
  ["claude", "shared-mcp:\n  Type: http\n  URL: https://mcp.fixture.test/mcp\n", "Claude Code"],
  ["codex", "shared-mcp\n  url: https://mcp.fixture.test/mcp\n", "Codex"],
])("skips a %s mcp whose URL already matches", (binary, configured, label) => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([[`${binary} mcp get shared-mcp`, configured]]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, binary), ["mcp get shared-mcp"]);
  assert.match(runtime.stdout.value, new RegExp(`${label}: shared-mcp is already configured`));
});

test("replaces a Claude mcp whose URL changed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: new Map([
      [
        "claude mcp get shared-mcp",
        "shared-mcp:\n  Type: http\n  URL: https://old.fixture.test/mcp\n",
      ],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "mcp get shared-mcp",
    "mcp remove -s user shared-mcp",
    "mcp add -t http -s user shared-mcp https://mcp.fixture.test/mcp",
  ]);
});

test("downgrades a Codex add whose config landed before its login step failed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "codex mcp add shared-mcp --url https://mcp.fixture.test/mcp",
        { stdout: "", stderr: "Error: timed out waiting for OAuth callback" },
      ],
    ]),
    sequences: new Map([
      [
        "codex mcp get shared-mcp",
        [
          { status: 1, stdout: "", stderr: "not found" },
          { status: 0, stdout: "shared-mcp\n  url: https://mcp.fixture.test/mcp\n", stderr: "" },
        ],
      ],
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.match(
    runtime.stdout.value,
    /Codex: shared-mcp is configured, but its login did not finish; run 'codex mcp login shared-mcp'/,
  );
});

test("narrows an MCP to its selected harnesses", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    profile: "personal-workstation",
    failures: new Map([
      ["claude mcp get shared-mcp", { stdout: "", stderr: "not found" }],
      ["claude mcp get personal-mcp", { stdout: "", stderr: "not found" }],
    ]),
  });

  assert.equal(main(["--profile", "personal-workstation"], runtime), 0);
  assert.ok(
    harnessCalls(runtime, "claude").includes(
      "mcp add -t http -s user personal-mcp https://personal.fixture.test/mcp",
    ),
  );
  assert.equal(
    harnessCalls(runtime, "codex").some((call) => call.includes("personal-mcp")),
    false,
  );
});

test("reports every failing command with a redacted diagnostic", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "codex mcp add shared-mcp --url https://mcp.fixture.test/mcp",
        { stdout: "", stderr: "connection refused\ntoken=stderr-secret" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /MCP sync failed for 1 command:/);
  assert.match(
    runtime.stderr.value,
    /Codex: mcp add shared-mcp --url https:\/\/mcp\.fixture\.test\/mcp \(exit 1\)/,
  );
  assert.match(runtime.stderr.value, /token=\[REDACTED\]/);
  assert.doesNotMatch(runtime.stderr.value, /stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("refuses an unknown profile before touching a harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "unsupported" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /MCP sync failed: Profile resolution failed/);
  assert.equal(runtime.calls.length, 1);
});

test("rejects unknown arguments and prints help without applying", () => {
  const { repoDir, home } = createFixture();
  const rejected = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--update"], rejected), 2);
  assert.match(rejected.stderr.value, /Unknown argument: --update/);
  assert.equal(rejected.calls.length, 0);

  const helped = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--help"], helped), 0);
  assert.match(helped.stdout.value, /Usage: \.\/agents\/mcps\.ts \[--profile PROFILE\]/);
  assert.equal(helped.calls.length, 0);
});

test("initializes a missing ownership lock without removing unowned MCPs", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([["claude mcp get shared-mcp", { stdout: "", stderr: "not found" }]]),
  });

  assert.equal(main([], runtime), 0);
  assert.equal(
    harnessCalls(runtime, "claude").some((call) => call.includes("remove")),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(mcpLockPath(home), "utf8")), {
    version: 1,
    mcps: [{ name: "shared-mcp", harnesses: [...HARNESSES] }],
  });
  assert.match(
    runtime.stdout.value,
    /Initializing managed MCP lock without removing existing MCPs/,
  );
});

test("prunes dropped mcps on present harnesses and defers absent ones until their CLI returns", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "developer", [
    ...fixtureSharedMcps,
    { name: "second-mcp", url: "https://second.fixture.test/mcp" },
  ]);
  writeMcpLock(home, [
    { name: "shared-mcp", harnesses: [...HARNESSES] },
    { name: "retired-mcp", harnesses: [...HARNESSES] },
  ]);
  const removals = (runtime: FixtureRuntime, binary: string) =>
    harnessCalls(runtime, binary).filter((call) => call.startsWith("mcp remove "));
  const lockedHarnesses = () =>
    Object.fromEntries(
      JSON.parse(readFileSync(mcpLockPath(home), "utf8")).mcps.map(
        (mcp: { name: string; harnesses: string[] }) => [mcp.name, [...mcp.harnesses].sort()],
      ),
    );

  // Selected Claude mcps already match, so every remove is an ownership prune.
  const outputs = new Map(
    [
      ["shared-mcp", "https://mcp.fixture.test/mcp"],
      ["second-mcp", "https://second.fixture.test/mcp"],
    ].map(([name, url]) => [`claude mcp get ${name}`, `${name}:\n  Type: http\n  URL: ${url}\n`]),
  );

  const withoutCodex = new FixtureRuntime(repoDir, home, { outputs });
  withoutCodex.installedCommands.delete("codex");
  assert.equal(main([], withoutCodex), 0);
  assert.deepEqual(removals(withoutCodex, "claude"), ["mcp remove -s user retired-mcp"]);
  assert.deepEqual(harnessCalls(withoutCodex, "codex"), []);
  assert.match(withoutCodex.stdout.value, /Skipping Codex MCPs: 'codex' is not installed/);
  assert.match(withoutCodex.stdout.value, /Skipping Codex MCP removal: 'codex' is not installed/);
  assert.deepEqual(lockedHarnesses(), {
    "shared-mcp": ["claude", "codex"],
    "second-mcp": ["claude"],
    "retired-mcp": ["codex"],
  });

  const withCodex = new FixtureRuntime(repoDir, home, { outputs });
  assert.equal(main([], withCodex), 0);
  assert.deepEqual(removals(withCodex, "claude"), []);
  assert.deepEqual(removals(withCodex, "codex"), ["mcp remove retired-mcp"]);
  assert.deepEqual(lockedHarnesses(), {
    "shared-mcp": ["claude", "codex"],
    "second-mcp": ["claude", "codex"],
  });
});

test("prunes from a lock written under the old servers key and rewrites it as mcps", () => {
  const { repoDir, home } = createFixture();
  mkdirSync(dirname(mcpLockPath(home)), { recursive: true });
  writeFileSync(
    mcpLockPath(home),
    JSON.stringify({ version: 1, servers: [{ name: "retired-mcp", harnesses: ["claude"] }] }),
  );
  const outputs = new Map([
    [
      "claude mcp get shared-mcp",
      "shared-mcp:\n  Type: http\n  URL: https://mcp.fixture.test/mcp\n",
    ],
  ]);
  const runtime = new FixtureRuntime(repoDir, home, { outputs });
  runtime.installedCommands.delete("codex");

  assert.equal(main([], runtime), 0);
  assert.ok(harnessCalls(runtime, "claude").includes("mcp remove -s user retired-mcp"));
  const lock = JSON.parse(readFileSync(mcpLockPath(home), "utf8"));
  assert.equal("servers" in lock, false);
  assert.deepEqual(
    lock.mcps.map((mcp: { name: string }) => mcp.name),
    ["shared-mcp"],
  );
});

test("does not prune or advance ownership when an add fails", () => {
  const { repoDir, home } = createFixture();
  const previous = {
    version: 1,
    mcps: [
      { name: "shared-mcp", harnesses: [...HARNESSES] },
      { name: "retired-mcp", harnesses: ["claude"] },
    ],
  };
  writeMcpLock(home, previous.mcps);
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "codex mcp add shared-mcp --url https://mcp.fixture.test/mcp",
        { stdout: "", stderr: "add failed" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.equal(
    harnessCalls(runtime, "claude").some((call) => call.includes("retired-mcp")),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(mcpLockPath(home), "utf8")), previous);
});

test("does not advance ownership when a managed removal fails", () => {
  const { repoDir, home } = createFixture();
  const previous = {
    version: 1,
    mcps: [
      { name: "shared-mcp", harnesses: [...HARNESSES] },
      { name: "retired-mcp", harnesses: ["claude"] },
    ],
  };
  writeMcpLock(home, previous.mcps);
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["claude mcp remove -s user retired-mcp", { stdout: "", stderr: "remove failed" }],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.ok(harnessCalls(runtime, "claude").includes("mcp remove -s user retired-mcp"));
  assert.deepEqual(JSON.parse(readFileSync(mcpLockPath(home), "utf8")), previous);
  assert.match(runtime.stderr.value, /MCP sync failed for 1 command:/);
});

test.each([
  [
    "no explicit harness membership",
    { name: "shared-mcp" },
    /harnesses must be an explicit unique non-empty subset/,
  ],
  ["an unsafe name", { name: "../escape", harnesses: ["claude"] }, /must have a safe name/],
])("rejects an ownership lock entry with %s before changing mcps", (_case, entry, message) => {
  const { repoDir, home } = createFixture();
  writeMcpLock(home, [entry]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Invalid managed MCP lock/);
  assert.match(runtime.stderr.value, message);
  assert.equal(runtime.calls.length, 1);
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "mcps.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/agents\/mcps\.ts \[--profile PROFILE\]/);
  assert.match(result.stderr, /Unknown argument: unexpected/);
});

test("another checkout without the overlay keeps overlay-owned mcps", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "agents", "local.json"),
    JSON.stringify({ mcps: [{ name: "machine-mcp", url: "https://machine.fixture.test/mcp" }] }),
    { mode: 0o600 },
  );
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  const other = new FixtureRuntime(createFixture().repoDir, home);
  assert.equal(main([], other), 0);
  assert.equal(
    harnessCalls(other, "claude").some((call) => call.includes("remove -s user machine-mcp")),
    false,
  );
  assert.ok(
    (JSON.parse(readFileSync(mcpLockPath(home), "utf8")) as { mcps: { name: string }[] }).mcps.some(
      (mcp) => mcp.name === "machine-mcp",
    ),
  );
});

test("a checkout selecting another checkout's overlay mcp keeps both harness sets", () => {
  const { repoDir, home } = createFixture();
  writeFileSync(
    join(repoDir, "agents", "local.json"),
    JSON.stringify({
      mcps: [
        { name: "machine-mcp", url: "https://machine.fixture.test/mcp", harnesses: ["claude"] },
      ],
    }),
    { mode: 0o600 },
  );
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  const other = createFixture().repoDir;
  writeFileSync(
    join(other, "agents", "local.json"),
    JSON.stringify({
      mcps: [
        { name: "machine-mcp", url: "https://machine.fixture.test/mcp", harnesses: ["codex"] },
      ],
    }),
    { mode: 0o600 },
  );
  const runtime = new FixtureRuntime(other, home);
  assert.equal(main([], runtime), 0);
  assert.equal(harnessCalls(runtime, "claude").includes("mcp remove -s user machine-mcp"), false);
  const locked = (
    JSON.parse(readFileSync(mcpLockPath(home), "utf8")) as {
      mcps: { name: string; harnesses: string[] }[];
    }
  ).mcps.find((mcp) => mcp.name === "machine-mcp");
  assert.deepEqual(locked?.harnesses, ["claude", "codex"]);
});
