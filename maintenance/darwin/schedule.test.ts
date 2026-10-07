import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Result } from "effect";
import { NodeServices } from "@effect/platform-node";
import { CommandRunner } from "../../lib/command.ts";
import { CliFailure } from "../../lib/program.ts";
import {
  comparePlist,
  manageSchedule,
  parseLaunchdPrint,
  receiptWarning,
  updateLabel,
} from "./schedule.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("on-demand updates reuse the loaded service without killing its current work", async () => {
  const calls: string[][] = [];
  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      return Effect.succeed({ status: 0, stdout: "loaded", stderr: "" });
    },
  });
  await Effect.runPromise(
    manageSchedule("run", "/fixture/home", 501).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  assert.deepEqual(calls, [
    ["launchctl", "print", `gui/501/${updateLabel}`],
    ["launchctl", "kickstart", `gui/501/${updateLabel}`],
  ]);
});

const systemService = `system/${updateLabel}.fixture`;

function systemRunner(calls: string[][], kickstartStatus = 0, systemLoaded = true) {
  return CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      if (command === "id") return Effect.succeed({ status: 0, stdout: "fixture", stderr: "" });
      const status =
        args[0] === "print"
          ? args[1] === systemService && systemLoaded
            ? 0
            : 113
          : kickstartStatus;
      return Effect.succeed({ status, stdout: "", stderr: "" });
    },
  });
}

async function runSystemUpdate(
  runner: CommandRunner["Service"],
  options: { devbox?: string; interactive: boolean },
) {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-schedule-run-"));
  try {
    if (options.devbox !== undefined) {
      await mkdir(join(home, ".config/dotfiles"), { recursive: true });
      await writeFile(join(home, ".config/dotfiles/devbox.env"), options.devbox, { mode: 0o600 });
    }
    return await Effect.runPromise(
      manageSchedule("run", home, 501, options.interactive).pipe(
        Effect.provideService(CommandRunner, runner),
        Effect.provide(NodeServices.layer),
        Effect.result,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a missing job cannot silently run an uncoordinated updater", async () => {
  const calls: string[][] = [];
  const result = await runSystemUpdate(systemRunner(calls, 0, false), {
    devbox: "SOPS_SUDO_SECRET_FILE=/fixture/sudo.sops.json\n",
    interactive: false,
  });
  assert.ok(Result.isFailure(result));
  assert.match(String(result.failure), /enable the scheduler first/);
  assert.deepEqual(calls, [
    ["launchctl", "print", `gui/501/${updateLabel}`],
    ["id", "-un", "501"],
    ["launchctl", "print", systemService],
  ]);
});

test("enrolled devboxes start the system updater through the sudo helper", async () => {
  const calls: string[][] = [];
  const result = await runSystemUpdate(systemRunner(calls), {
    devbox: "SOPS_SUDO_SECRET_FILE=/fixture/sudo.sops.json\n",
    interactive: false,
  });
  assert.ok(Result.isSuccess(result));
  const kickstart = calls.at(-1) ?? [];
  assert.equal(kickstart[0], process.execPath);
  assert.match(kickstart[1] ?? "", /identity\/sops-devbox-sudo\.ts$/);
  assert.deepEqual(kickstart.slice(2), ["--", "/bin/launchctl", "kickstart", systemService]);
});

test("unattended callers without sudo helper config never wait on a sudo prompt", async () => {
  const calls: string[][] = [];
  const result = await runSystemUpdate(systemRunner(calls, 1), {
    devbox: "DEVBOX_USER=fixture\n",
    interactive: false,
  });
  assert.deepEqual(calls.at(-1), [
    "/usr/bin/sudo",
    "-n",
    "--",
    "/bin/launchctl",
    "kickstart",
    systemService,
  ]);
  assert.ok(Result.isFailure(result));
  assert.match(
    String(result.failure),
    new RegExp(`run: sudo /bin/launchctl kickstart ${systemService.replaceAll(".", "\\.")}`),
  );
});

test("terminal callers without the helper get the sudo prompt", async () => {
  const calls: string[][] = [];
  const result = await runSystemUpdate(systemRunner(calls), { interactive: true });
  assert.ok(Result.isSuccess(result));
  assert.deepEqual(calls.at(-1), [
    "/usr/bin/sudo",
    "--",
    "/bin/launchctl",
    "kickstart",
    systemService,
  ]);
});

test("on-demand launch failures reach the caller", async () => {
  const runner = CommandRunner.of({
    run: (_command, args = []) =>
      Effect.succeed({
        status: args[0] === "kickstart" ? 5 : 0,
        stdout: "",
        stderr: "launch failed",
      }),
  });
  const failure = await Effect.runPromise(
    manageSchedule("run", "/fixture/home", 501).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(NodeServices.layer),
      Effect.flip,
    ),
  );
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 5);
});

for (const loaded of [false, true]) {
  test(`disabling a ${loaded ? "loaded" : "missing"} job persists its disabled state`, async () => {
    const calls: string[][] = [];
    const runner = CommandRunner.of({
      run: (command, args = []) => {
        calls.push([command, ...args]);
        if (command === "id") return Effect.succeed({ status: 0, stdout: "fixture", stderr: "" });
        return Effect.succeed({
          status: args[0] === "print" && (!loaded || args[1] === systemService) ? 113 : 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    await Effect.runPromise(
      manageSchedule("disable", "/fixture/home", 501).pipe(
        Effect.provideService(CommandRunner, runner),
        Effect.provide(NodeServices.layer),
      ),
    );
    const service = `gui/501/${updateLabel}`;
    assert.deepEqual(calls, [
      ["launchctl", "print", service],
      ["launchctl", "disable", service],
      ...(loaded ? [["launchctl", "bootout", service]] : []),
      ["id", "-un", "501"],
      ["launchctl", "print", systemService],
    ]);
  });
}

test("disabling fails while the system updater stays enrolled", async () => {
  const calls: string[][] = [];
  const failure = await Effect.runPromise(
    manageSchedule("disable", "/fixture/home", 501).pipe(
      Effect.provideService(CommandRunner, systemRunner(calls)),
      Effect.provide(NodeServices.layer),
      Effect.flip,
    ),
  );
  assert.ok(failure instanceof CliFailure);
  assert.match(failure.message, /system updater still enrolled/);
});

for (const kind of ["regular", "writable", "symlink", "system"] as const) {
  test(`enrollment checks the ${kind} plist before enabling a job`, async (t) => {
    const uid = process.getuid?.();
    assert.ok(uid, "enrollment requires an unprivileged Unix user");
    const home = await mkdtemp(join(tmpdir(), "dotfiles-enrollment-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    const plist = join(home, `Library/LaunchAgents/${updateLabel}.plist`);
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    await writeFile(join(home, ".config/dotfiles/profile"), "workstation\n", { mode: 0o600 });
    await writeFile(plist, "fixture: plutil is stubbed at the process boundary", { mode: 0o600 });
    if (kind === "writable") await chmod(plist, 0o622);
    if (kind === "symlink") {
      await rm(plist);
      await symlink(join(home, ".config/dotfiles/profile"), plist);
    }
    const calls: string[][] = [];
    let loaded = false;
    const runner = CommandRunner.of({
      run: (command, args = []) => {
        calls.push([command, ...args]);
        if (command === "id") return Effect.succeed({ status: 0, stdout: "fixture", stderr: "" });
        if (args[0] === "bootstrap") loaded = true;
        return Effect.succeed({
          status: args[0] === "print" && !loaded ? 113 : 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    const operation = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* manageSchedule("enable", home, uid).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) =>
            kind === "system" &&
            path === "/Library/LaunchDaemons/local.dotfiles.software-update.fixture.plist"
              ? Effect.succeed(true)
              : fs.exists(path),
        }),
      );
    }).pipe(Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer));
    const service = `gui/${uid}/${updateLabel}`;
    if (kind === "regular") {
      await Effect.runPromise(operation);
      assert.deepEqual(calls, [
        ["launchctl", "print", service],
        ["id", "-un", String(uid)],
        ["plutil", "-lint", plist],
        ["launchctl", "enable", service],
        ["launchctl", "bootstrap", `gui/${uid}`, plist],
        ["launchctl", "print", service],
      ]);
    } else {
      const failure = await Effect.runPromise(operation.pipe(Effect.flip));
      assert.match(
        String(failure),
        kind === "system"
          ? /system updater already enrolled/
          : kind === "symlink"
            ? /must not be a symlink/
            : /owning user/,
      );
      assert.deepEqual(calls, [
        ["launchctl", "print", service],
        ["id", "-un", String(uid)],
      ]);
    }
  });
}

// Captured from `launchctl print gui/501/local.dotfiles.software-update` on macOS 15.
const launchdPrintFixture = `gui/501/local.dotfiles.software-update = {
\tactive count = 0
\tpath = /Users/fixture/Library/LaunchAgents/local.dotfiles.software-update.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /Users/fixture/.local/share/mise/shims/node
\targuments = {
\t\t/Users/fixture/.local/share/mise/shims/node
\t\t/Users/fixture/projects/dotfiles/maintenance/run.ts
\t\tsoftware-update
\t\t--
\t\t/opt/homebrew/bin/topgrade
\t\t--yes
\t}

\tinherited environment = {
\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.fixture/Listeners
\t}

\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}

\tenvironment = {
\t\tOSLogRateLimit => 64
\t\tGIT_TERMINAL_PROMPT => 0
\t\tPATH => /Users/fixture/.local/bin:/usr/bin:/bin
\t\tNO_COLOR => 1
\t\tXPC_SERVICE_NAME => local.dotfiles.software-update
\t}

\tevent triggers = {
\t\tlocal.dotfiles.software-update.268435486 => {
\t\t\tdescriptor = {
\t\t\t\t"Minute" => 23
\t\t\t\t"Hour" => 18
\t\t\t}
\t\t}
\t}
}
`;
const fixtureArguments = [
  "/Users/fixture/.local/share/mise/shims/node",
  "/Users/fixture/projects/dotfiles/maintenance/run.ts",
  "software-update",
  "--",
  "/opt/homebrew/bin/topgrade",
  "--yes",
];
const fixturePlist = {
  ProgramArguments: fixtureArguments,
  EnvironmentVariables: {
    GIT_TERMINAL_PROMPT: "0",
    PATH: "/Users/fixture/.local/bin:/usr/bin:/bin",
    NO_COLOR: "1",
  },
};

test("plist comparison covers only arguments and environment, never the schedule", () => {
  const loaded = parseLaunchdPrint(launchdPrintFixture);
  const rescheduled = {
    ...fixturePlist,
    StartCalendarInterval: [{ Hour: 3, Minute: 0 }],
    WorkingDirectory: "/elsewhere",
  };
  assert.deepEqual(comparePlist(loaded, rescheduled), { comparable: true, drift: [] });
});

test("launchctl print parsing extracts only the job's own arguments and environment", () => {
  const loaded = parseLaunchdPrint(launchdPrintFixture);
  assert.deepEqual(loaded.arguments, fixtureArguments);
  assert.equal(loaded.environment?.GIT_TERMINAL_PROMPT, "0");
  assert.equal(loaded.environment?.XPC_SERVICE_NAME, "local.dotfiles.software-update");
  assert.equal(
    loaded.environment?.SSH_AUTH_SOCK,
    undefined,
    "inherited environment must not leak in",
  );
  assert.equal(
    loaded.environment?.PATH,
    "/Users/fixture/.local/bin:/usr/bin:/bin",
    "default environment must not win",
  );
  assert.deepEqual(parseLaunchdPrint("garbage without blocks"), {});
  assert.deepEqual(
    parseLaunchdPrint("\targuments = {\n\t\tunclosed"),
    {},
    "unterminated blocks parse to nothing",
  );
});

test("drift detection compares the loaded job against the rendered plist defensively", () => {
  const loaded = parseLaunchdPrint(launchdPrintFixture);
  assert.deepEqual(comparePlist(loaded, fixturePlist), { comparable: true, drift: [] });
  const changedArguments = {
    ...fixturePlist,
    ProgramArguments: [...fixtureArguments.slice(0, -1), "--dry-run"],
  };
  assert.match(comparePlist(loaded, changedArguments).drift.join("\n"), /ProgramArguments differ/);
  const changedEnvironment = {
    ...fixturePlist,
    EnvironmentVariables: { ...fixturePlist.EnvironmentVariables, NO_COLOR: "0" },
  };
  assert.match(
    comparePlist(loaded, changedEnvironment).drift.join("\n"),
    /EnvironmentVariables\.NO_COLOR differs/,
  );
  assert.equal(comparePlist(loaded, { ProgramArguments: "not-a-list" }).comparable, false);
  assert.equal(comparePlist({}, fixturePlist).comparable, false);
  assert.equal(comparePlist(loaded, null).comparable, false);
});

test("stale, missing, and unreadable receipts are flagged while fresh ones pass", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const receipt = (finishedAt: string) =>
    JSON.stringify({
      version: 1,
      job: "software-update",
      startedAt: finishedAt,
      finishedAt,
      exitCode: 0,
    });
  assert.equal(receiptWarning(receipt("2026-09-07T06:30:00Z"), now), undefined);
  assert.match(receiptWarning(receipt("2026-09-06T22:00:00Z"), now) ?? "", /older than 13 hours/);
  assert.equal(
    receiptWarning(receipt("2026-09-06T23:30:00Z"), now),
    undefined,
    "12.5h stays inside the 13h budget",
  );
  assert.match(receiptWarning("not json", now) ?? "", /unreadable/);
  assert.match(receiptWarning(JSON.stringify({ startedAt: 42 }), now) ?? "", /unreadable/);
  assert.match(receiptWarning(undefined, now) ?? "", /no update receipt exists/);
  // A running receipt has no finishedAt yet; a fresh startedAt is enough.
  assert.equal(
    receiptWarning(JSON.stringify({ state: "running", startedAt: "2026-09-07T11:00:00Z" }), now),
    undefined,
  );
});

test("status compares the loaded job with the rendered on-disk plist", async (t) => {
  const uid = process.getuid?.();
  assert.ok(uid);
  const home = await mkdtemp(join(tmpdir(), "dotfiles-status-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const plist = join(home, `Library/LaunchAgents/${updateLabel}.plist`);
  await mkdir(dirname(plist), { recursive: true });
  await writeFile(plist, "fixture: plutil is stubbed at the process boundary");
  await mkdir(join(home, ".local/state/dotfiles/updates"), { recursive: true });
  await writeFile(
    join(home, ".local/state/dotfiles/updates/software-update.json"),
    JSON.stringify({
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
    }),
  );
  const calls: string[][] = [];
  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      if (command === "plutil")
        return Effect.succeed({ status: 0, stdout: JSON.stringify(fixturePlist), stderr: "" });
      return Effect.succeed({ status: 0, stdout: launchdPrintFixture, stderr: "" });
    },
  });
  await Effect.runPromise(
    manageSchedule("status", home, uid).pipe(
      Effect.provideService(CommandRunner, runner),
      Effect.provide(NodeServices.layer),
    ),
  );
  assert.deepEqual(calls, [
    ["launchctl", "print", `gui/${uid}/${updateLabel}`],
    ["plutil", "-convert", "json", "-o", "-", plist],
  ]);
});

test("rendered profiles keep updater scope, scheduling, and paths valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "dotfiles-updates-"));
  try {
    // Spaces and XML metacharacters must survive launchd's argument boundary.
    const home = join(root, "home & space");
    await mkdir(home);
    for (const profile of ["workstation", "personal-workstation", "devbox", "personal-devbox"]) {
      const render = (target: string) => {
        const result = spawnSync(
          "chezmoi",
          [
            "--source",
            join(repoRoot, "chezmoi"),
            "--destination",
            home,
            "--override-data",
            JSON.stringify({ dotfilesProfile: profile }),
            "cat",
            join(home, target),
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, "config") },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const plist = join(root, "update.plist");
      await writeFile(plist, render(`Library/LaunchAgents/${updateLabel}.plist`));
      const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], {
        encoding: "utf8",
      });
      assert.equal(parsed.status, 0, parsed.stderr);
      const job = JSON.parse(parsed.stdout);
      assert.equal(job.Label, "local.dotfiles.software-update");
      assert.equal(job.Disabled, true, "applying dotfiles alone must not enroll a scheduler");
      assert.equal(job.RunAtLoad, true);
      assert.equal(job.KeepAlive, undefined, "failures must not spin in a restart loop");
      assert.deepEqual(
        job.StartCalendarInterval,
        [0, 6, 12, 18].map((Hour) => ({ Hour, Minute: 0 })),
      );
      assert.deepEqual(job.ProgramArguments, [
        join(home, ".local/share/mise/installs/node/latest/bin/node"),
        join(repoRoot, "maintenance/run.ts"),
        "software-update",
        "--",
        join(home, ".local/share/mise/shims/topgrade"),
        "--config",
        join(home, ".config/topgrade.toml"),
        "--no-tmux",
        "--no-ask-retry",
        "--no-self-update",
        "--notify-end",
        "on_failure",
        "--yes",
      ]);
      assert.equal(job.EnvironmentVariables.HOMEBREW_NO_UPGRADE_QUIT_CASKS, "1");
      assert.equal(job.EnvironmentVariables.HOMEBREW_NO_UPGRADE_AUTO_UPDATES_CASKS, "1");
      assert.equal(job.EnvironmentVariables.HOMEBREW_NO_INSTALL_CLEANUP, "1");
      assert.equal(job.EnvironmentVariables.GIT_TERMINAL_PROMPT, "0");
      assert.ok(
        job.EnvironmentVariables.PATH.split(":").includes(join(home, ".local/bin")),
        "installed user harnesses must be available to scheduled agent sync",
      );
      const config = render(".config/topgrade.toml");
      assert.ok(config.includes('"Stable Homebrew" = "brew developer off"'));
      const selection = config.split("\n").find((line) => line.startsWith("only = "));
      assert.ok(selection);
      assert.deepEqual(JSON.parse(selection.slice("only = ".length)), [
        "brew_formula",
        "brew_cask",
        "github_cli_extensions",
        "custom_commands",
      ]);
      assert.ok(
        !config.includes("t3-server"),
        "the updater must not push T3 Code to other hosts; T3 Code manages its own server updates",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const loaded of [true, false]) {
  test(`status inspects a namespaced system updater and ${loaded ? "compares its plist" : "fails when neither domain is loaded"}`, async (t) => {
    const uid = process.getuid?.();
    assert.ok(uid);
    const home = await mkdtemp(join(tmpdir(), "dotfiles-system-status-"));
    t.onTestFinished(() => rm(home, { recursive: true, force: true }));
    await mkdir(join(home, ".config/dotfiles"), { recursive: true });
    await writeFile(join(home, ".config/dotfiles/launchd-namespace"), "example.host\n", {
      mode: 0o600,
    });
    const service = "system/example.host.software-update.fixture";
    const plist = "/Library/LaunchDaemons/example.host.software-update.fixture.plist";
    const calls: string[][] = [];
    const runner = CommandRunner.of({
      run: (command, args = []) => {
        calls.push([command, ...args]);
        if (command === "id") return Effect.succeed({ status: 0, stdout: "fixture\n", stderr: "" });
        if (command === "plutil")
          return Effect.succeed({ status: 0, stdout: JSON.stringify(fixturePlist), stderr: "" });
        return Effect.succeed({
          status: loaded && args[1] === service ? 0 : 113,
          stdout: launchdPrintFixture,
          stderr: "",
        });
      },
    });
    const operation = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* manageSchedule("status", home, uid).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) => (path === plist ? Effect.succeed(true) : fs.exists(path)),
        }),
      );
    }).pipe(Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer));
    if (loaded) await Effect.runPromise(operation);
    else
      assert.match(
        String(await Effect.runPromise(operation.pipe(Effect.flip))),
        /not loaded in the GUI or system domain/,
      );
    assert.deepEqual(calls, [
      ["launchctl", "print", `gui/${uid}/${updateLabel}`],
      ["id", "-un", String(uid)],
      ["launchctl", "print", service],
      ...(loaded ? [["plutil", "-convert", "json", "-o", "-", plist]] : []),
    ]);
  });
}
