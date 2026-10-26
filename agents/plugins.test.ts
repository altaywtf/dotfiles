import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { readProfileModel } from "../profiles/model.ts";
import { HARNESSES, main, pluginRef, readLayeredPlugins, readPlugins } from "./plugins.ts";
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

type FixtureOptions = {
  failures?: ReadonlyMap<string, FixtureFailure>;
  outputs?: ReadonlyMap<string, string>;
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
  readonly profile: string;
  readonly repoDir: string;

  constructor(repoDir: string, home: string, options: FixtureOptions = {}) {
    this.repoDir = repoDir;
    this.failures = options.failures ?? new Map();
    this.outputs = options.outputs ?? new Map();
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

    const diagnostic = this.failures.get(`${command} ${args.join(" ")}`);
    if (diagnostic !== undefined) {
      return { status: 1, stdout: diagnostic.stdout, stderr: diagnostic.stderr };
    }
    const key = `${command} ${args.join(" ")}`;
    return {
      status: 0,
      stdout: this.outputs.get(key) ?? (key === `claude ${AUTH_STATUS}` ? SIGNED_IN : ""),
      stderr: "",
    };
  }
}

const temporaryDirectories: string[] = [];

const fixtureSharedPlugins = [
  { marketplace: "fixture/shared-market", name: "shared-plugin" },
  { marketplace: "fixture/shared-market", name: "second-plugin" },
];

const fixturePersonalPlugins = [
  { marketplace: "fixture/personal-market", name: "personal-plugin", harnesses: ["claude"] },
];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-plugins-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");

  mkdirSync(join(repoDir, "agents", "plugins"), { recursive: true });
  mkdirSync(join(repoDir, "chezmoi", ".chezmoidata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".local/state/dotfiles/agents"), { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi", ".chezmoidata", "profiles.json"),
    readFileSync(join(repoRoot, "chezmoi", ".chezmoidata", "profiles.json")),
  );
  writeManifest(repoDir, "developer", fixtureSharedPlugins);
  writeManifest(repoDir, "workstation", []);
  writeManifest(repoDir, "devbox", []);
  writeManifest(repoDir, "personal", fixturePersonalPlugins);

  return { repoDir, home };
}

function writeManifest(repoDir: string, layer: string, plugins: unknown): void {
  writeFileSync(
    join(repoDir, "agents", "plugins", `${layer}.json`),
    JSON.stringify({ plugins }, null, 2),
  );
}

function manifestPath(repoDir: string, layer: string): string {
  return join(repoDir, "agents", "plugins", `${layer}.json`);
}

function harnessCalls(runtime: FixtureRuntime, binary: string): string[] {
  return runtime.calls
    .filter((call) => call.command === binary)
    .map((call) => call.args.join(" "))
    .filter((call) => call !== SYNCED_LIST && call !== AUTH_STATUS);
}

const SYNCED_LIST = "plugin list --json";
const AUTH_STATUS = "auth status";
const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });

function listOutputs(ids: readonly string[]): ReadonlyMap<string, string> {
  return new Map([
    [
      `claude ${SYNCED_LIST}`,
      JSON.stringify(
        ids.map((id) => ({
          id,
          scope: id.endsWith("@synced") ? "synced" : "user",
          enabled: true,
        })),
      ),
    ],
  ]);
}

function syncedOutputs(names: readonly string[]): ReadonlyMap<string, string> {
  return listOutputs(["shared-plugin@shared-market", ...names.map((name) => `${name}@synced`)]);
}

function pluginLockPath(home: string): string {
  return join(home, ".local/state/dotfiles/agents", "plugins.lock.json");
}

function lockPlugin(plugin: {
  marketplace: string;
  name: string;
  harnesses?: readonly string[];
}): unknown {
  return {
    marketplace: plugin.marketplace,
    marketplaceId: plugin.marketplace.split("/")[1],
    name: plugin.name,
    harnesses: plugin.harnesses ?? [...HARNESSES],
  };
}

function writePluginLock(home: string, plugins: Parameters<typeof lockPlugin>[0][]): void {
  mkdirSync(dirname(pluginLockPath(home)), { recursive: true });
  writeFileSync(
    pluginLockPath(home),
    JSON.stringify({ version: 1, plugins: plugins.map(lockPlugin) }, null, 2),
  );
}

test("defaults a manifest entry to every harness and derives the marketplace id", () => {
  const { repoDir } = createFixture();
  const plugins = readPlugins(manifestPath(repoDir, "developer"));
  const first = plugins[0];

  assert.ok(first !== undefined);
  assert.deepEqual(first.harnesses, HARNESSES);
  assert.equal(first.marketplaceId, "shared-market");
  assert.equal(pluginRef(first), "shared-plugin@shared-market");
});

test("honours an explicit marketplaceId when the marketplace name diverges", () => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [
    { marketplace: "fixture/dotfiles-marketplace", name: "one", marketplaceId: "renamed" },
  ]);

  assert.equal(readPlugins(manifestPath(repoDir, "developer"))[0]?.marketplaceId, "renamed");
});

const ENTRY_SHAPE = /expected a marketplace .* and a safe plugin name/;
const HARNESS_SET = /harnesses must be a unique/;

test.each([
  ["a marketplace that is not owner/repo", { marketplace: "fixture", name: "one" }, ENTRY_SHAPE],
  ["an unsafe plugin name", { marketplace: "fixture/market", name: "../escape" }, ENTRY_SHAPE],
  [
    "an HTTPS marketplace with credentials",
    { marketplace: "https://user:secret@git.fixture.test/m.git", name: "one", marketplaceId: "m" },
    ENTRY_SHAPE,
  ],
  ["a relative path marketplace", { marketplace: "./market", name: "one" }, ENTRY_SHAPE],
  [
    "a Git URL without marketplaceId",
    { marketplace: "https://git.fixture.test/m.git", name: "one" },
    /one needs a marketplaceId because its marketplace is not owner\/repo/,
  ],
  ["an unknown harness", { marketplace: "f/m", name: "one", harnesses: ["windsurf"] }, HARNESS_SET],
  [
    "a duplicated harness",
    { marketplace: "f/m", name: "one", harnesses: ["claude", "claude"] },
    HARNESS_SET,
  ],
  ["an empty harness list", { marketplace: "f/m", name: "one", harnesses: [] }, HARNESS_SET],
])("rejects a manifest entry with %s", (_case, entry, message) => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [entry]);

  assert.throws(() => readPlugins(manifestPath(repoDir, "developer")), message);
});

test.each([
  "https://git.fixture.test/owner/market.git",
  "ssh://git@git.fixture.test/owner/market.git",
  "git@git.fixture.test:owner/market.git",
  "/srv/fixture/market",
])("accepts the marketplace source %s with an explicit marketplaceId", (marketplace) => {
  const { repoDir } = createFixture();
  writeManifest(repoDir, "developer", [{ marketplace, marketplaceId: "market", name: "one" }]);

  assert.deepEqual(readPlugins(manifestPath(repoDir, "developer")), [
    { marketplace, marketplaceId: "market", name: "one", harnesses: HARNESSES },
  ]);
});

function writeLocalPlugins(repoDir: string, plugins: unknown): void {
  writeFileSync(join(repoDir, "agents", "local.json"), JSON.stringify({ plugins }), {
    mode: 0o600,
  });
}

test("local overlay plugins install after profile layers and skip Codex upgrade for a path", () => {
  const { repoDir, home } = createFixture();
  writeLocalPlugins(repoDir, [
    { marketplace: "/srv/fixture/local-market", marketplaceId: "local-market", name: "local" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main(["--update"], runtime), 0);
  assert.match(runtime.stdout.value, /Plugin layers: developer, workstation, local/);
  assert.deepEqual(
    harnessCalls(runtime, "codex").filter((call) => call.includes("local")),
    ["plugin marketplace add /srv/fixture/local-market", "plugin add local@local-market"],
  );
  assert.ok(harnessCalls(runtime, "claude").includes("plugin install local@local-market"));
});

test("another checkout without the overlay keeps overlay-owned plugins", () => {
  const { repoDir, home } = createFixture();
  writeLocalPlugins(repoDir, [
    { marketplace: "/srv/fixture/local-market", marketplaceId: "local-market", name: "local" },
  ]);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  const other = new FixtureRuntime(createFixture().repoDir, home);
  assert.equal(main([], other), 0);
  assert.equal(
    harnessCalls(other, "claude").some((call) => call.includes("uninstall -y local@local-market")),
    false,
  );
  const lock = JSON.parse(readFileSync(pluginLockPath(home), "utf8")) as {
    plugins: { name: string }[];
  };
  assert.ok(lock.plugins.some((plugin) => plugin.name === "local"));
});

test("dropping a plugin from this checkout's overlay uninstalls it", () => {
  const { repoDir, home } = createFixture();
  writeLocalPlugins(repoDir, [
    { marketplace: "/srv/fixture/local-market", marketplaceId: "local-market", name: "local" },
  ]);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);
  assert.equal(main([], new FixtureRuntime(repoDir, home)), 0);

  writeLocalPlugins(repoDir, []);
  const runtime = new FixtureRuntime(repoDir, home);
  assert.equal(main([], runtime), 0);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin uninstall -y local@local-market"));
  assert.ok(harnessCalls(runtime, "codex").includes("plugin remove local@local-market"));
});

test("applies the developer layer across every installed harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
  assert.match(runtime.stdout.value, /Plugin layers: developer/);
  assert.match(runtime.stdout.value, /Done\./);
});

test("refreshes installed plugins and marketplaces on --update", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main(["--update"], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
    "plugin update shared-plugin@shared-market -y",
    "plugin update second-plugin@shared-market -y",
  ]);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin marketplace upgrade shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
});

test("skips refresh commands after their marketplace add or plugin install fails", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["codex plugin marketplace add fixture/shared-market", { stdout: "", stderr: "name taken" }],
      [
        "claude plugin install shared-plugin@shared-market",
        { stdout: "", stderr: "install failed" },
      ],
    ]),
  });

  assert.equal(main(["--update"], runtime), 1);
  assert.deepEqual(harnessCalls(runtime, "codex"), [
    "plugin marketplace add fixture/shared-market",
    "plugin add shared-plugin@shared-market",
    "plugin add second-plugin@shared-market",
  ]);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
    "plugin update second-plugin@shared-market -y",
  ]);

  const addFailed = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      ["claude plugin marketplace add fixture/shared-market", { stdout: "", stderr: "name taken" }],
    ]),
  });
  assert.equal(main(["--update"], addFailed), 1);
  assert.deepEqual(harnessCalls(addFailed, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
});

test("does not prune or advance ownership when an install or refresh fails", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  const previous = { version: 1, plugins: [...fixtureSharedPlugins, retired].map(lockPlugin) };

  for (const [command, stderr] of [
    ["claude plugin marketplace add fixture/shared-market", "install failed"],
    ["claude plugin update shared-plugin@shared-market -y", "stale cache locked"],
    ["codex plugin marketplace upgrade shared-market", "upgrade failed"],
  ] as const) {
    writePluginLock(home, [...fixtureSharedPlugins, retired]);
    const runtime = new FixtureRuntime(repoDir, home, {
      failures: new Map([[command, { stdout: "", stderr }]]),
    });

    assert.equal(main(["--update"], runtime), 1);
    assert.equal(
      harnessCalls(runtime, "claude").some((call) => call.includes("uninstall")),
      false,
    );
    assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(home), "utf8")), previous);
  }
});

test("adds the personal layer only for personal profiles", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-devbox" });

  assert.equal(main(["--profile", "personal-devbox"], runtime), 0);
  assert.match(runtime.stdout.value, /Plugin layers: developer, devbox, personal/);
  assert.ok(
    harnessCalls(runtime, "claude").includes("plugin install personal-plugin@personal-market"),
  );
  assert.ok(
    harnessCalls(runtime, "claude").includes("plugin marketplace add fixture/personal-market"),
  );
  assert.equal(
    harnessCalls(runtime, "codex").some((call) => call.includes("personal-plugin")),
    false,
  );
});

test("reports every failing command with a redacted diagnostic", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "claude plugin marketplace add fixture/shared-market",
        { stdout: "", stderr: "fatal: repository not found\ntoken=stderr-secret" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Plugin sync failed for 1 failure:/);
  assert.match(
    runtime.stderr.value,
    /Claude Code: plugin marketplace add fixture\/shared-market \(exit 1\)/,
  );
  assert.match(runtime.stderr.value, /token=\[REDACTED\]/);
  assert.doesNotMatch(runtime.stderr.value, /stderr-secret/);
  assert.doesNotMatch(runtime.stdout.value, /Done\./);
});

test("rejects a conflicting plugin definition across selected layers", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "personal", [
    { marketplace: "fixture/shared-market", name: "shared-plugin", harnesses: ["claude"] },
  ]);
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /shared-plugin@shared-market is defined more than once/);
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("rejects one marketplace registered under different ids across layers", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "personal", [
    { marketplace: "fixture/shared-market", marketplaceId: "other-id", name: "third-plugin" },
  ]);
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stderr.value,
    /fixture\/shared-market is registered as both shared-market and other-id/,
  );
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("collapses an identical plugin selected by more than one layer", () => {
  const { repoDir, home } = createFixture();
  writeManifest(repoDir, "personal", fixtureSharedPlugins);
  const runtime = new FixtureRuntime(repoDir, home, { profile: "personal-workstation" });

  assert.equal(main([], runtime), 0);
  const installs = harnessCalls(runtime, "claude").filter((call) =>
    call.startsWith("plugin install"),
  );
  assert.deepEqual(installs, [
    "plugin install shared-plugin@shared-market",
    "plugin install second-plugin@shared-market",
  ]);
});

test("refuses an unknown profile before touching a harness", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, { profile: "unsupported" });

  assert.equal(main([], runtime), 1);
  assert.match(runtime.stderr.value, /Plugin sync failed: Profile resolution failed/);
  assert.equal(runtime.calls.length, 1);
});

test("prints help without applying", () => {
  const { repoDir, home } = createFixture();
  const helped = new FixtureRuntime(repoDir, home);
  assert.equal(main(["--help"], helped), 0);
  assert.match(
    helped.stdout.value,
    /Usage: \.\/agents\/plugins\.ts \[--profile PROFILE\] \[--update\]/,
  );
  assert.equal(helped.calls.length, 0);
});

test("every real plugin manifest parses", () => {
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    readPlugins(join(repoRoot, `agents/plugins/${layer}.json`));
  }
});

test("initializes a missing ownership lock without removing unowned plugins", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 0);
  assert.equal(
    harnessCalls(runtime, "claude").some((call) => call.includes("uninstall")),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(home), "utf8")), {
    version: 1,
    plugins: readLayeredPlugins(repoDir, "workstation", ["developer", "workstation"]).plugins,
  });
  assert.match(
    runtime.stdout.value,
    /Initializing managed plugins lock without removing existing plugins/,
  );
});

test("prunes dropped plugins on present harnesses and defers absent ones until their CLI returns", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(home, [
    { marketplace: "fixture/shared-market", name: "shared-plugin" },
    { marketplace: "fixture/retired-market", name: "retired-plugin" },
  ]);
  const removals = (runtime: FixtureRuntime, binary: string) =>
    harnessCalls(runtime, binary).filter((call) => /^plugin (uninstall|remove) /.test(call));
  const lockedHarnesses = () =>
    Object.fromEntries(
      JSON.parse(readFileSync(pluginLockPath(home), "utf8")).plugins.map(
        (plugin: { marketplaceId: string; name: string; harnesses: string[] }) => [
          `${plugin.name}@${plugin.marketplaceId}`,
          [...plugin.harnesses].sort(),
        ],
      ),
    );

  const withoutCodex = new FixtureRuntime(repoDir, home);
  withoutCodex.installedCommands.delete("codex");
  assert.equal(main([], withoutCodex), 0);
  assert.deepEqual(removals(withoutCodex, "claude"), [
    "plugin uninstall -y retired-plugin@retired-market",
  ]);
  assert.deepEqual(harnessCalls(withoutCodex, "codex"), []);
  assert.match(withoutCodex.stdout.value, /Skipping Codex plugins: 'codex' is not installed/);
  assert.match(
    withoutCodex.stdout.value,
    /Skipping Codex plugin removal: 'codex' is not installed/,
  );
  assert.deepEqual(lockedHarnesses(), {
    "shared-plugin@shared-market": ["claude", "codex"],
    "second-plugin@shared-market": ["claude"],
    "retired-plugin@retired-market": ["codex"],
  });

  const withCodex = new FixtureRuntime(repoDir, home);
  assert.equal(main([], withCodex), 0);
  assert.deepEqual(removals(withCodex, "claude"), []);
  assert.deepEqual(removals(withCodex, "codex"), ["plugin remove retired-plugin@retired-market"]);
  assert.deepEqual(lockedHarnesses(), {
    "shared-plugin@shared-market": ["claude", "codex"],
    "second-plugin@shared-market": ["claude", "codex"],
  });
});

test("leaves a plugin synced from claude.ai to Claude and still installs it in Codex", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(home, fixtureSharedPlugins);
  const runtime = new FixtureRuntime(repoDir, home, { outputs: syncedOutputs(["shared-plugin"]) });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin uninstall -y shared-plugin@shared-market",
    "plugin marketplace add fixture/shared-market",
    "plugin install second-plugin@shared-market",
  ]);
  assert.ok(harnessCalls(runtime, "codex").includes("plugin add shared-plugin@shared-market"));
  const locked = JSON.parse(readFileSync(pluginLockPath(home), "utf8")).plugins;
  assert.deepEqual(
    locked.map((plugin: { name: string; harnesses: string[] }) => [plugin.name, plugin.harnesses]),
    [
      ["shared-plugin", ["codex"]],
      ["second-plugin", ["claude", "codex"]],
    ],
  );
});

test("drops Claude ownership of a synced plugin that has no local install left", () => {
  const { repoDir, home } = createFixture();
  writePluginLock(home, fixtureSharedPlugins);
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: listOutputs(["shared-plugin@synced"]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin marketplace add fixture/shared-market",
    "plugin install second-plugin@shared-market",
  ]);
  const locked = JSON.parse(readFileSync(pluginLockPath(home), "utf8")).plugins;
  assert.deepEqual(
    locked.map((plugin: { name: string; harnesses: string[] }) => [plugin.name, plugin.harnesses]),
    [
      ["shared-plugin", ["codex"]],
      ["second-plugin", ["claude", "codex"]],
    ],
  );
});

test("still uninstalls a retired local install that a synced plugin shadows", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  writePluginLock(home, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: listOutputs(["retired-plugin@retired-market", "retired-plugin@synced"]),
  });

  assert.equal(main([], runtime), 0);
  assert.ok(
    harnessCalls(runtime, "claude").includes("plugin uninstall -y retired-plugin@retired-market"),
  );
});

test("uninstalls only a local Claude install that shadows a selected synced plugin", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    outputs: listOutputs([
      "shared-plugin@synced",
      "shared-plugin@other-market",
      "second-plugin@shared-market",
      "unrelated@unrelated-market",
      "unrelated@synced",
    ]),
  });

  assert.equal(main([], runtime), 0);
  assert.deepEqual(harnessCalls(runtime, "claude"), [
    "plugin uninstall -y shared-plugin@other-market",
    "plugin marketplace add fixture/shared-market",
    "plugin install second-plugin@shared-market",
  ]);
  assert.match(
    runtime.stdout.value,
    /Claude: shared-plugin@other-market shadows shared-plugin@synced from claude\.ai; uninstalling/,
  );
});

test("installs every selected plugin when Claude cannot list synced plugins", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([[`claude ${SYNCED_LIST}`, { stdout: "", stderr: "boom" }]]),
  });

  assert.equal(main([], runtime), 0);
  assert.ok(harnessCalls(runtime, "claude").includes("plugin install shared-plugin@shared-market"));
  assert.match(runtime.stdout.value, /could not read synced plugins/);
});

test.each([
  [
    "is signed out",
    { outputs: new Map([[`claude ${AUTH_STATUS}`, '{"loggedIn":false,"authMethod":"none"}']]) },
    /Claude: not signed in for this run; leaving plugins unchanged/,
  ],
  [
    "cannot report its sign-in status",
    { failures: new Map([[`claude ${AUTH_STATUS}`, { stdout: "", stderr: "boom" }]]) },
    /Claude: could not read sign-in status \(exit 1\)/,
  ],
  [
    "prints unparseable sign-in output",
    { outputs: new Map([[`claude ${AUTH_STATUS}`, "not json"]]) },
    /Claude: could not read sign-in status/,
  ],
])("leaves Claude plugins and their ownership unchanged when Claude %s", (_case, auth, message) => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  writePluginLock(home, [retired]);
  const runtime = new FixtureRuntime(repoDir, home, auth);

  assert.equal(main(["--update"], runtime), 0);
  assert.match(runtime.stdout.value, message);
  assert.deepEqual(
    runtime.calls.filter((call) => call.command === "claude").map((call) => call.args.join(" ")),
    [AUTH_STATUS],
  );
  assert.ok(harnessCalls(runtime, "codex").includes("plugin add shared-plugin@shared-market"));
  assert.ok(harnessCalls(runtime, "codex").includes("plugin remove retired-plugin@retired-market"));
  const locked = JSON.parse(readFileSync(pluginLockPath(home), "utf8")).plugins;
  assert.deepEqual(
    locked.map((plugin: { name: string; harnesses: string[] }) => [plugin.name, plugin.harnesses]),
    [
      ["shared-plugin", ["codex"]],
      ["second-plugin", ["codex"]],
      ["retired-plugin", ["claude"]],
    ],
  );
});

test("does not advance ownership when a managed removal fails", () => {
  const { repoDir, home } = createFixture();
  const retired = { marketplace: "fixture/retired-market", name: "retired-plugin" };
  const previous = { version: 1, plugins: [...fixtureSharedPlugins, retired].map(lockPlugin) };
  writePluginLock(home, [...fixtureSharedPlugins, retired]);
  const runtime = new FixtureRuntime(repoDir, home, {
    failures: new Map([
      [
        "claude plugin uninstall -y retired-plugin@retired-market",
        { stdout: "", stderr: "remove failed" },
      ],
    ]),
  });

  assert.equal(main([], runtime), 1);
  assert.ok(
    harnessCalls(runtime, "claude").includes("plugin uninstall -y retired-plugin@retired-market"),
  );
  assert.deepEqual(JSON.parse(readFileSync(pluginLockPath(home), "utf8")), previous);
  assert.match(runtime.stderr.value, /Plugin sync failed for 1 failure:/);
});

test.each([
  [
    "an unsafe plugin name",
    {
      marketplace: "fixture/market",
      marketplaceId: "market",
      name: "../escape",
      harnesses: ["claude"],
    },
  ],
  [
    "no explicit harness membership",
    { marketplace: "fixture/shared-market", marketplaceId: "shared-market", name: "shared-plugin" },
  ],
])("rejects an ownership lock entry with %s before changing plugins", (_case, entry) => {
  const { repoDir, home } = createFixture();
  writeFileSync(pluginLockPath(home), JSON.stringify({ version: 1, plugins: [entry] }));
  const runtime = new FixtureRuntime(repoDir, home);

  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stderr.value,
    /Invalid managed plugins lock.*expected explicit marketplace, marketplaceId, name, and harnesses/,
  );
  assert.equal(harnessCalls(runtime, "claude").length, 0);
});

test("the executable TypeScript entrypoint runs the CLI", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "plugins.ts");
  const result = spawnSync(scriptPath, ["unexpected"], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: \.\/agents\/plugins\.ts \[--profile PROFILE\] \[--update\]/);
  assert.match(result.stderr, /Unknown argument: unexpected/);
});
