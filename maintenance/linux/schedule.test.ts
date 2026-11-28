import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect, FileSystem } from "effect";
import { CommandError, CommandRunner } from "../../lib/command.ts";
import { manageSchedule } from "./schedule.ts";

function fixture(
  options: { missing?: string; linger?: boolean; failure?: string; spawnFailure?: boolean } = {},
) {
  const calls: Array<Array<string>> = [];
  const inspected: Array<string> = [];

  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      const failing = args.includes(options.failure ?? "never");

      if (failing && options.spawnFailure) {
        return Effect.fail(new CommandError({ command, message: "spawn failed" }));
      }

      return Effect.succeed({
        status: failing ? 9 : 0,
        stdout: command === "loginctl" ? (options.linger === false ? "no\n" : "yes\n") : "",
        stderr: failing ? "denied" : "",
      });
    },
  });

  const fs = FileSystem.makeNoop({
    exists: (path) => {
      inspected.push(path);

      return Effect.succeed(!path.endsWith(options.missing ?? "never"));
    },
  });

  const run = (action: string) =>
    Effect.runPromise(
      manageSchedule(action, "/home/test", 1000).pipe(
        Effect.provideService(CommandRunner, runner),
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );

  return { calls, inspected, run };
}

for (const suffix of ["timer", "service"]) {
  test(`enable requires the rendered ${suffix}`, async () => {
    const f = fixture({ missing: suffix });
    await assert.rejects(f.run("enable"), /run .\/dotfiles apply first/);
    assert.deepEqual(f.calls, []);
  });
}

test("enable requires lingering before reloading or enrolling", async () => {
  const f = fixture({ linger: false });
  await assert.rejects(f.run("enable"), /lingering/);
  assert.deepEqual(f.calls, [["loginctl", "show-user", "1000", "--property=Linger", "--value"]]);
});

test("enable reloads unit definitions before starting the timer", async () => {
  const f = fixture();
  await f.run("enable");
  assert.deepEqual(f.calls, [
    ["loginctl", "show-user", "1000", "--property=Linger", "--value"],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "dotfiles-software-update.timer"],
  ]);
});

test("failed reload prevents enrollment", async () => {
  const f = fixture({ failure: "daemon-reload" });
  await assert.rejects(f.run("enable"), /daemon-reload exited 9/);
  assert.equal(f.calls.length, 2);
});

test("run is nonblocking and does not require unit files or lingering", async () => {
  const f = fixture({ missing: "service", linger: false });
  await f.run("run");
  assert.deepEqual(f.inspected, []);
  assert.deepEqual(f.calls, [
    ["systemctl", "--user", "start", "--no-block", "dotfiles-software-update.service"],
  ]);
});

for (const failure of ["disable", "stop"]) {
  for (const spawnFailure of [false, true]) {
    test(`disable attempts both operations despite ${failure} ${spawnFailure ? "spawn" : "exit"} failure`, async () => {
      const f = fixture({ failure, spawnFailure });
      await assert.rejects(f.run("disable"), /exited/);
      assert.deepEqual(f.inspected, []);
      assert.deepEqual(f.calls, [
        ["systemctl", "--user", "disable", "--now", "dotfiles-software-update.timer"],
        ["systemctl", "--user", "stop", "dotfiles-software-update.service"],
      ]);
    });
  }
}
