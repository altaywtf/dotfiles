import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import { CommandError, CommandRunner } from "../../lib/command.ts";
import { isCliFailure } from "../../lib/program.ts";
import { join } from "node:path";
import { convergeUserManager } from "./user-manager.ts";

for (const unavailable of ["exit", "spawn"] as const) {
  test(`apply tolerates an unavailable user manager (${unavailable})`, async () => {
    const calls: Array<Array<string>> = [];
    const runner = CommandRunner.of({
      run: (command, args = []) => {
        calls.push([command, ...args]);
        return unavailable === "spawn"
          ? Effect.fail(new CommandError({ command, message: "not found" }))
          : Effect.succeed({ status: 1, stdout: "", stderr: "no bus" });
      },
    });
    await Effect.runPromise(
      convergeUserManager("/home/test", false, "linux").pipe(
        Effect.provideService(CommandRunner, runner),
      ),
    );
    assert.deepEqual(calls, [["systemctl", "--user", "show-environment"]]);
  });
}

test("apply converges manager PATH idempotently without losing unrelated entries", async () => {
  const home = "/home/test";
  const front = [".local/share/mise/shims", ".local/libexec/dotfiles/bin", ".local/bin"].map(
    (part) => join(home, part),
  );
  let path = `/custom/bin:${front[2]}:/usr/bin:${front[0]}:${front[0]}`;
  const calls: Array<Array<string>> = [];
  const runner = CommandRunner.of({
    run: (_command, args = []) => {
      calls.push([...args]);
      if (args[1] === "set-environment") {
        path = args[2]?.slice(5) ?? "";
      }
      return Effect.succeed({
        status: 0,
        stdout: args[1] === "show-environment" ? `OTHER=value\nPATH=${path}\n` : "",
        stderr: "",
      });
    },
  });
  for (let index = 0; index < 2; index++) {
    await Effect.runPromise(
      convergeUserManager(home, false, "linux").pipe(Effect.provideService(CommandRunner, runner)),
    );
    assert.equal(path, [...front, "/custom/bin", "/usr/bin"].join(":"));
  }
  assert.deepEqual(
    calls.map((call) => call[1]),
    [
      "show-environment",
      "daemon-reload",
      "set-environment",
      "show-environment",
      "daemon-reload",
      "set-environment",
    ],
  );
});

for (const operation of ["daemon-reload", "set-environment"]) {
  for (const failure of ["exit", "spawn"]) {
    test(`reachable manager ${operation} ${failure} failure is reported`, async () => {
      const runner = CommandRunner.of({
        run: (command, args = []) =>
          args[1] === operation
            ? failure === "spawn"
              ? Effect.fail(new CommandError({ command, message: "unavailable" }))
              : Effect.succeed({ status: 7, stdout: "", stderr: "denied" })
            : Effect.succeed({ status: 0, stdout: "PATH=/usr/bin", stderr: "" }),
      });
      const error = await Effect.runPromise(
        convergeUserManager("/home/test", false, "linux").pipe(
          Effect.provideService(CommandRunner, runner),
          Effect.flip,
        ),
      );
      assert.ok(isCliFailure(error));
      assert.match(error.message, new RegExp(`systemctl --user ${operation}`));
      assert.equal(error.exitCode, failure === "exit" ? 7 : 1);
    });
  }
}

test("dry-run and non-Linux apply never contact systemd", async () => {
  const calls: Array<string> = [];
  const runner = CommandRunner.of({
    run: (command) => {
      calls.push(command);
      return Effect.succeed({ status: 0, stdout: "", stderr: "" });
    },
  });
  await Effect.runPromise(
    convergeUserManager("/home/test", true, "linux").pipe(
      Effect.provideService(CommandRunner, runner),
    ),
  );
  await Effect.runPromise(
    convergeUserManager("/home/test", false, "darwin").pipe(
      Effect.provideService(CommandRunner, runner),
    ),
  );
  assert.deepEqual(calls, []);
});
