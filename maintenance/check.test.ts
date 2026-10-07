#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import type { ProfileConfig } from "../profiles/model.ts";
import {
  collectMaintenanceSnapshot,
  collectMaintenanceSnapshotEffect,
  parseBrewBacklog,
  type CommandRunner,
  type MaintenanceContext,
} from "./check.ts";
import type { MacOSUpdateIO } from "./darwin/macos-updates.ts";

const profileConfig = {
  capabilities: {
    requiresSopsIdentity: false,
    devbox: false,
    workstation: true,
    personal: false,
  },
  brewfiles: ["homebrew/Brewfile"],
  agentLayers: ["developer"],
  installSteps: ["apply-dotfiles", "install-runtimes", "install-repository-dependencies"],
} as const satisfies ProfileConfig;

const emptyMiseRoot = mkdtempSync(join(tmpdir(), "maintenance-empty-mise-"));
for (const directory of [
  "chezmoi/.chezmoitemplates/linux",
  "chezmoi/.chezmoitemplates/darwin",
  ".config/mise",
])
  mkdirSync(join(emptyMiseRoot, directory), { recursive: true });
for (const file of [
  "chezmoi/.chezmoitemplates/mise.toml",
  "chezmoi/.chezmoitemplates/linux/mise.toml",
  "chezmoi/.chezmoitemplates/darwin/mise.toml",
  ".config/mise/config.toml",
])
  writeFileSync(join(emptyMiseRoot, file), "[tools]\n");
afterAll(() => rm(emptyMiseRoot, { recursive: true, force: true }));

function context(): MaintenanceContext {
  return {
    cwd: emptyMiseRoot,
    env: { HOME: emptyMiseRoot, USER: "fixture" },
    home: emptyMiseRoot,
    hostname: "fixture-host",
    ownsHomebrew: false,
    platform: "linux",
    profile: "workstation",
    profileConfig,
    repoRoot: emptyMiseRoot,
    user: "fixture",
    fresh: false,
    verify: false,
  };
}

function result(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

test("single-owner Darwin devboxes retain the service probe without shared Homebrew", async () => {
  const calls: string[][] = [];
  await collectMaintenanceSnapshot(
    {
      ...context(),
      platform: "darwin",
      profile: "personal-devbox",
      profileConfig: {
        ...profileConfig,
        agentLayers: [],
        capabilities: { ...profileConfig.capabilities, devbox: true, workstation: false },
      },
    },
    async (command, args) => {
      calls.push([command, ...args]);
      return result("");
    },
  );
  assert.ok(
    calls.some((call) => call.includes(join(emptyMiseRoot, "verify/darwin/devbox-services.ts"))),
  );
});

test("Homebrew backlog parsing keeps exact installed and current versions", () => {
  assert.deepEqual(
    parseBrewBacklog(
      '{"formulae":[{"name":"jq","installed_versions":["1.7"],"current_version":"1.8","pinned":true}],"casks":[{"name":"example","installed_versions":["1.0"],"current_version":"2.0","auto_updates":false}]}',
    ),
    {
      formulae: [{ name: "jq", installed_versions: ["1.7"], current_version: "1.8" }],
      casks: [{ name: "example", installed_versions: ["1.0"], current_version: "2.0" }],
    },
  );
});

test("Homebrew backlog refreshes metadata before the greedy inventory", async () => {
  const brewCalls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === "brew") {
      brewCalls.push([...args]);
      if (args[0] === "update") return result("");
      return result('{"formulae":[],"casks":[]}');
    }
    if (command === "df")
      return result(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n",
      );
    if (command === "tailscale" && args[0] === "status")
      return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  await collectMaintenanceSnapshot(
    {
      ...context(),
      env: { ...context().env, HOMEBREW_NO_AUTO_UPDATE: "1" },
      ownsHomebrew: true,
      profileConfig: { ...profileConfig, agentLayers: [] },
    },
    runner,
  );
  assert.deepEqual(brewCalls, [["update"], ["outdated", "--greedy", "--json=v2"]]);
});

test("a failed Homebrew metadata refresh makes the snapshot incomplete", async () => {
  const brewCalls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    if (command === "brew") {
      brewCalls.push([...args]);
      return result("", 1);
    }
    if (command === "df")
      return result(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n",
      );
    if (command === "tailscale" && args[0] === "status")
      return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  const snapshot = await collectMaintenanceSnapshot(
    {
      ...context(),
      ownsHomebrew: true,
      profileConfig: { ...profileConfig, agentLayers: [] },
    },
    runner,
  );
  assert.deepEqual(brewCalls, [["update"]]);
  assert.equal(snapshot.probes.brew_outdated_greedy?.status, "failed");
  assert.equal(snapshot.probes.brew_outdated_greedy?.error, "brew update failed: exit 1");
  assert.equal(snapshot.summary.status, "incomplete");
});

test("maintenance probes run concurrently and summarize package drift", async () => {
  let active = 0;
  let maxActive = 0;
  const runner: CommandRunner = async (command, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (maxActive === 1) {
      await new Promise<void>((resolve, reject) =>
        queueMicrotask(() => {
          if (maxActive > 1) resolve();
          else reject(new Error("maintenance probes ran sequentially"));
        }),
      );
    }
    active -= 1;
    if (command === "df")
      return result(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n",
      );
    if (command === "tailscale" && args[0] === "status")
      return result(
        JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "fixture.ts.net",
          Self: { Online: true },
          Peer: {},
        }),
      );
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    if (command === "git") return result("");
    if (args.some((argument) => argument.endsWith("bootstrap.ts")))
      return result("bootstrap verification ok\n");
    return result("1.0.0\n");
  };
  const snapshot = await collectMaintenanceSnapshot(
    { ...context(), profileConfig: { ...profileConfig, agentLayers: [] } },
    runner,
  );
  assert.ok(maxActive > 1);
  assert.equal(snapshot.summary.required_failures, 0);
  assert.equal(snapshot.summary.backlog_count, 0);
  assert.equal(snapshot.summary.status, "clean");
});

test("missing required commands make the snapshot incomplete without throwing", async () => {
  const runner: CommandRunner = async () => ({
    status: 127,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("missing"), { code: "ENOENT" }),
  });
  const snapshot = await collectMaintenanceSnapshot(
    { ...context(), profileConfig: { ...profileConfig, agentLayers: [] } },
    runner,
  );
  assert.equal(snapshot.summary.status, "incomplete");
  assert.ok(snapshot.summary.required_failures > 0);
  assert.equal(snapshot.probes.system?.status, "unavailable");
});

test("macOS inventory preserves typed partial results in the maintenance probe", async () => {
  const runner: CommandRunner = async (command, args) => {
    if (command === "sw_vers" && args[0] === "-productVersion") return result("26.6.2\n");
    if (command === "sw_vers" && args[0] === "-buildVersion") return result("25G83\n");
    if (command === "defaults") return result("26.6.2\n");
    if (command === "ioreg")
      return result('+-o Fixture1AP <class IOPlatformExpertDevice>\n{\n"model" = <"Mac99,1">\n}\n');
    if (command === "softwareupdate")
      return result("Software Update Tool\nNo new software available.\n");
    if (command === "df")
      return result(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n",
      );
    if (command === "tailscale" && args[0] === "status")
      return result(JSON.stringify({ BackendState: "Running", Self: { Online: true }, Peer: {} }));
    if (command === "mise" || (command === "npm" && args[0] === "outdated")) return result("{}");
    return result("1.0.0\n");
  };
  const updateIO: MacOSUpdateIO = {
    async fetch(url) {
      if (url.includes("gdmf.apple.com")) {
        return {
          status: 200,
          body: JSON.stringify({
            PublicAssetSets: {
              macOS: [
                { ProductVersion: "26.6.2", Build: "25G83", SupportedDevices: ["Fixture1AP"] },
              ],
            },
          }),
        };
      }
      if (url.includes("macos_data_feed")) {
        return {
          status: 200,
          body: JSON.stringify({
            Version: "2.0",
            OSVersions: [
              {
                Latest: { ProductVersion: "26.6.2", Build: "25G83" },
                SupportedModels: [{ Identifiers: { "Mac99,1": "Fixture Mac" } }],
              },
            ],
          }),
        };
      }
      return { status: 503, body: "unavailable" };
    },
    async readCache() {
      return undefined;
    },
    async writeCache() {},
  };
  const snapshot = await collectMaintenanceSnapshot(
    {
      ...context(),
      platform: "darwin",
      profileConfig: { ...profileConfig, agentLayers: [] },
    },
    runner,
    updateIO,
  );

  assert.equal(snapshot.probes.software_update?.status, "ok");
  assert.equal(snapshot.summary.software_update_status, "current");
  assert.equal(snapshot.summary.required_failures, 0);
  const inventory = snapshot.probes.software_update?.value;
  assert.equal(inventory?.installed.os.version, "26.6.2");
  assert.equal(inventory?.installed.os.build, "25G83");
  assert.equal(inventory?.installed.device.software_update_id, "Fixture1AP");
  assert.equal(inventory?.upstream.apple_gdmf.status, "ok");
});

test("interrupting the collector reaps every owned probe before completing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maintenance-cancellation-"));
  const bin = join(root, "bin");
  const pids = join(root, "pids");
  await mkdir(bin);
  await mkdir(pids);
  const controller = new AbortController();
  let completion: Promise<Exit.Exit<unknown, unknown>> | undefined;
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    await rm(root, { recursive: true, force: true });
  });
  const commands = ["mise", "npm", "node", "codex", "claude"];
  for (const command of commands) {
    await writeFile(
      join(bin, command),
      `#!${process.execPath}
process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(${JSON.stringify(pids)} + '/' + process.pid, 'ready');
setTimeout(() => process.exit(9), 5000);
`,
      { mode: 0o700 },
    );
  }
  completion = Effect.runPromiseExit(
    collectMaintenanceSnapshotEffect({
      ...context(),
      cwd: root,
      env: { PATH: bin },
      home: root,
      repoRoot: root,
      profileConfig: {
        ...profileConfig,
        agentLayers: [],
        capabilities: { ...profileConfig.capabilities, workstation: false },
      },
    }),
    { signal: controller.signal },
  );
  const deadline = performance.now() + 4000;
  let started: string[];
  do {
    started = await readdir(pids);
    assert.ok(performance.now() < deadline, "probes did not start");
    if (started.length < commands.length + 1) await delay(20);
  } while (started.length < commands.length + 1);
  controller.abort();
  const exit = await completion;
  assert.equal(Exit.isFailure(exit), true);
  for (const pid of started) assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
});

test("interrupting the collector aborts inventory feeds and drains them before returning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maintenance-feed-cancellation-"));
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const drain = Promise.withResolvers<void>();
  let fetches = 0;
  let suppliedSignals = 0;
  let aborts = 0;
  let writes = 0;
  let completed = false;
  const updateIO: MacOSUpdateIO = {
    async readCache() {
      return undefined;
    },
    async fetch(_url, _agent, _timeout, signal) {
      if (++fetches === 3) started.resolve();
      if (signal) suppliedSignals++;
      assert.ok(signal);
      const canceled = Promise.withResolvers<void>();
      signal.addEventListener(
        "abort",
        () => {
          if (++aborts === 3) aborted.resolve();
          canceled.resolve();
        },
        { once: true },
      );
      await canceled.promise;
      await drain.promise;
      return { status: 503, body: "" };
    },
    async writeCache() {
      writes++;
    },
  };
  const completion = Effect.runPromiseExit(
    collectMaintenanceSnapshotEffect(
      {
        ...context(),
        cwd: root,
        home: root,
        repoRoot: root,
        platform: "darwin",
        env: { PATH: root },
      },
      updateIO,
    ),
    { signal: controller.signal },
  ).then((exit) => {
    completed = true;
    return exit;
  });
  t.onTestFinished(async () => {
    controller.abort();
    drain.resolve();
    await completion;
    await rm(root, { recursive: true, force: true });
  });
  await started.promise;
  assert.equal(suppliedSignals, 3, "each feed must receive the inventory cancellation signal");
  controller.abort();
  await aborted.promise;
  assert.equal(completed, false, "interruption must wait for active feed IO to settle");
  drain.resolve();
  assert.equal(Exit.isFailure(await completion), true);
  assert.equal(fetches, 3);
  assert.equal(writes, 0, "canceled feed results must not update the cache");
});

test("maintenance rejects the same conflicting skill declarations as synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "maintenance-skills-"));
  try {
    await mkdir(join(root, "agents/skills"), { recursive: true });
    for (const layer of ["developer", "workstation", "devbox", "personal"]) {
      await writeFile(
        join(root, `agents/skills/${layer}.json`),
        JSON.stringify({
          skills:
            layer === "developer" || layer === "workstation"
              ? [{ name: "example", source: `example/${layer}` }]
              : [],
        }),
      );
    }
    await assert.rejects(
      collectMaintenanceSnapshot(
        {
          ...context(),
          repoRoot: root,
          profileConfig: { ...profileConfig, agentLayers: ["developer", "workstation"] },
        },
        async () => result("{}"),
      ),
      /Invalid layered skills: example is defined more than once/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed npm output fails without exposing its contents", async () => {
  const snapshot = await collectMaintenanceSnapshot(
    { ...context(), profileConfig: { ...profileConfig, agentLayers: [] } },
    async (command) =>
      command === "npm" ? result("private malformed diagnostic", 1) : result("{}"),
  );
  assert.equal(snapshot.probes.npm_outdated.status, "failed");
  assert.equal(snapshot.probes.npm_outdated.error, "npm returned an invalid update inventory");
});

test("npm inventory distinguishes outdated packages from error envelopes", async () => {
  for (const [payload, status, expected, count] of [
    [{ example: { current: "1.0.0", wanted: "1.1.0", latest: "2.0.0" } }, 1, "ok", 1],
    [{}, 0, "ok", 0],
    [
      { error: { code: "E401", summary: "fixture failure", detail: "private diagnostic" } },
      1,
      "failed",
      0,
    ],
    [{ example: { latest: 42 } }, 1, "failed", 0],
  ] as const) {
    const snapshot = await collectMaintenanceSnapshot(
      {
        ...context(),
        profileConfig: {
          ...profileConfig,
          agentLayers: [],
          capabilities: { ...profileConfig.capabilities, workstation: false },
        },
      },
      async (command) =>
        command === "npm" ? result(JSON.stringify(payload), status) : result("{}"),
    );
    assert.equal(snapshot.probes.npm_outdated.status, expected);
    assert.equal(snapshot.summary.backlog_count, count);
    if (expected === "failed") {
      assert.equal(snapshot.summary.status, "incomplete");
      assert.ok(snapshot.summary.required_failures > 0);
      assert.doesNotMatch(snapshot.probes.npm_outdated.error ?? "", /private diagnostic/);
    }
  }
});

test("SSH agent probes preserve the installed gateway wrapper outside the inherited PATH", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-ssh-probe-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".local/bin/claude"), "#!/bin/sh\necho gateway-wrapper-version\n", {
    mode: 0o700,
  });
  const { runProcess } = await import("./probes.ts");
  const snapshot = await collectMaintenanceSnapshot(
    {
      ...context(),
      home,
      cwd: home,
      env: { PATH: "/usr/bin:/bin" },
      profileConfig: { ...profileConfig, agentLayers: [] },
    },
    (command, args, options) =>
      command === "claude" ? runProcess(command, args, options) : Promise.resolve(result("{}")),
  );
  assert.equal(snapshot.probes.version_claude.status, "ok");
  assert.equal(snapshot.probes.version_claude.value, "gateway-wrapper-version");
  await rm(join(home, ".local/bin/claude"));
  const missing = await collectMaintenanceSnapshot(
    {
      ...context(),
      home,
      cwd: home,
      env: { PATH: "/usr/bin:/bin" },
      profileConfig: { ...profileConfig, agentLayers: [] },
    },
    (command, args, options) =>
      command === "claude" ? runProcess(command, args, options) : Promise.resolve(result("{}")),
  );
  assert.equal(missing.probes.version_claude.status, "unavailable");
});

for (const inventoryAvailable of [true, false]) {
  test(`cask backlog retains unverified versions when inventory is ${inventoryAvailable ? "available" : "failed"}`, async () => {
    const casks = ["current", "outdated", "unknown", "compound"].map((name) => ({
      name,
      installed_versions: ["1.0"],
      current_version: name === "compound" ? "2.0,20" : "2.0",
    }));
    const snapshot = await collectMaintenanceSnapshot(
      {
        ...context(),
        platform: "darwin",
        ownsHomebrew: true,
        profileConfig: { ...profileConfig, agentLayers: [] },
      },
      async (command, args) => {
        if (command === "brew" && args[0] === "outdated")
          return result(JSON.stringify({ formulae: [], casks }));
        if (command === "brew" && args[0] === "info")
          return inventoryAvailable
            ? result(
                JSON.stringify({
                  casks: [
                    { token: "current", bundle_short_version: "2.0", bundle_version: "20" },
                    { token: "outdated", bundle_short_version: "1.5", bundle_version: "15" },
                    {
                      token: "unknown",
                      bundle_short_version: null,
                      bundle_version: null,
                      auto_updates: true,
                    },
                    { token: "compound", bundle_short_version: "2.0", bundle_version: "20" },
                  ],
                }),
              )
            : result("", 1);
        return result("{}");
      },
    );
    const backlog = snapshot.probes.brew_outdated_greedy.value as {
      casks: { name: string }[];
      record_lag: { name: string }[];
      cask_verification: { status: string }[];
    };
    assert.deepEqual(
      backlog.record_lag.map((item) => item.name),
      inventoryAvailable ? ["current", "compound"] : [],
    );
    assert.deepEqual(
      backlog.casks.map((item) => item.name),
      inventoryAvailable ? ["outdated", "unknown"] : casks.map((item) => item.name),
    );
    assert.deepEqual(
      backlog.cask_verification.map((item) => item.status),
      inventoryAvailable
        ? ["record_lag", "pending", "unknown", "record_lag"]
        : ["unknown", "unknown", "unknown", "unknown"],
    );
    assert.equal(snapshot.summary.backlog_count, inventoryAvailable ? 2 : 4);
  });
}

async function pinContext() {
  const root = await mkdtemp(join(tmpdir(), "maintenance-mise-pins-"));
  await mkdir(join(root, "chezmoi/.chezmoitemplates/linux"), { recursive: true });
  await mkdir(join(root, ".config/mise"), { recursive: true });
  await writeFile(join(root, "chezmoi/.chezmoitemplates/mise.toml"), '[tools]\nnode = "24.21.0"\n');
  await writeFile(
    join(root, "chezmoi/.chezmoitemplates/linux/mise.toml"),
    '[tools]\n"github:anthropics/claude-code" = { version = "2.1.292", matching_regex = "^claude-linux-arm64" }\n',
  );
  await writeFile(
    join(root, ".config/mise/config.toml"),
    '[tools]\nnode = "24.21.0"\n"github:anthropics/claude-code" = { version = "2.1.291" }\n',
  );
  return {
    ...context(),
    cwd: root,
    repoRoot: root,
    home: root,
    env: { HOME: root },
    profileConfig: {
      ...profileConfig,
      agentLayers: [],
      capabilities: { ...profileConfig.capabilities, workstation: false },
    },
  };
}

const pinnedInstall = {
  node: [{ version: "24.21.0", requested_version: "24.21.0", installed: true }],
  "github:anthropics/claude-code": [
    { version: "2.1.291", requested_version: "2.1.291", installed: true },
  ],
};

test("source pin changes remain pending even when the installed mise catalog reports no updates", async (t) => {
  const fixture = await pinContext();
  t.onTestFinished(() => rm(fixture.home, { recursive: true, force: true }));
  const snapshot = await collectMaintenanceSnapshot(fixture, async (command, args, options) => {
    if (command === "mise" && args[0] === "ls") {
      assert.equal(options.cwd, fixture.home);
      return result(JSON.stringify(pinnedInstall));
    }
    return result("{}");
  });
  assert.equal(snapshot.summary.status, "attention");
  assert.equal(snapshot.summary.backlog_count, 1);
  assert.deepEqual(snapshot.probes.mise_convergence.value, {
    "github:anthropics/claude-code": {
      declared: "2.1.292",
      configured: "2.1.291",
      current: "2.1.291",
      installed: true,
    },
  });
});

test("missing declared installations count once alongside upstream availability", async (t) => {
  const fixture = await pinContext();
  t.onTestFinished(() => rm(fixture.home, { recursive: true, force: true }));
  await writeFile(
    join(fixture.home, ".config/mise/config.toml"),
    '[tools]\nnode = "24.21.0"\n"github:anthropics/claude-code" = "2.1.292"\n',
  );
  const snapshot = await collectMaintenanceSnapshot(fixture, async (command, args) => {
    if (command === "mise" && args[0] === "ls")
      return result(
        JSON.stringify({
          ...pinnedInstall,
          "github:anthropics/claude-code": [
            { version: "2.1.292", requested_version: "2.1.292", installed: false },
          ],
        }),
      );
    if (command === "mise")
      return result(
        JSON.stringify({
          "github:anthropics/claude-code": { current: "2.1.291", latest: "2.1.292" },
        }),
      );
    return result("{}");
  });
  assert.equal(snapshot.summary.status, "attention");
  assert.equal(snapshot.summary.backlog_count, 1);
  assert.deepEqual(snapshot.probes.mise_convergence.value, {
    "github:anthropics/claude-code": {
      declared: "2.1.292",
      configured: "2.1.292",
      current: "2.1.292",
      installed: false,
    },
  });
});

test("unavailable, failed, absent and malformed installed pin inspections remain incomplete", async (t) => {
  const fixture = await pinContext();
  t.onTestFinished(() => rm(fixture.home, { recursive: true, force: true }));
  for (const inspection of [
    { ...result("", 127), error: Object.assign(new Error("missing"), { code: "ENOENT" }) },
    result("", 1),
    result("private malformed inspection"),
    result("{}"),
    result(JSON.stringify({ node: [{ version: 24, installed: true }] })),
  ]) {
    const snapshot = await collectMaintenanceSnapshot(fixture, async (command, args) =>
      command === "mise" && args[0] === "ls" ? inspection : result("{}"),
    );
    assert.equal(snapshot.summary.status, "incomplete");
    assert.notEqual(snapshot.probes.mise_convergence.status, "ok");
    assert.doesNotMatch(
      snapshot.probes.mise_convergence.error ?? "",
      /private malformed inspection/,
    );
  }
  await rm(join(fixture.repoRoot, "chezmoi/.chezmoitemplates/linux/mise.toml"));
  const snapshot = await collectMaintenanceSnapshot(fixture, async () =>
    result(JSON.stringify(pinnedInstall)),
  );
  assert.equal(snapshot.summary.status, "incomplete");
  assert.equal(snapshot.probes.mise_convergence.status, "failed");
});

test("T3 CLI version uses the same managed executable path as the other harness probes", async () => {
  const snapshot = await collectMaintenanceSnapshot(
    { ...context(), profileConfig: { ...profileConfig, agentLayers: [] } },
    async (command, args, options) => {
      if (command === "t3") {
        assert.deepEqual(args, ["--version"]);
        assert.ok(options.env.PATH?.startsWith(join(context().home, ".local/bin")));
        return result("t3 v0.0.45\n");
      }
      return result("{}");
    },
  );
  assert.equal(snapshot.probes.version_t3?.value, "t3 v0.0.45");
});

test("converged runtime selectors and source pins do not invent an upgrade", async (t) => {
  const fixture = await pinContext();
  t.onTestFinished(() => rm(fixture.home, { recursive: true, force: true }));
  await writeFile(
    join(fixture.repoRoot, "chezmoi/.chezmoitemplates/mise.toml"),
    '[tools]\nnode = "24.21.0"\njava = "temurin-25"\n',
  );
  await writeFile(
    join(fixture.home, ".config/mise/config.toml"),
    '[tools]\nnode = "24.21.0"\njava = "temurin-25"\n"github:anthropics/claude-code" = "2.1.292"\n',
  );
  const snapshot = await collectMaintenanceSnapshot(fixture, async (command, args) => {
    if (command === "mise" && args[0] === "ls")
      return result(
        JSON.stringify({
          ...pinnedInstall,
          java: [
            {
              requested_version: "temurin-25",
              version: "temurin-25.0.4+101.0.LTS",
              installed: true,
            },
          ],
          "github:anthropics/claude-code": [
            { requested_version: "2.1.292", version: "2.1.292", installed: true },
          ],
        }),
      );
    return result("{}");
  });
  assert.equal(snapshot.summary.status, "clean");
  assert.deepEqual(snapshot.probes.mise_convergence.value, {});
});
