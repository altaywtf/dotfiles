import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, PlatformError } from "effect";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";
import { CommandError, CommandRunner } from "./command.ts";

test("a missing executable retains its structured platform cause", async () => {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const runner = yield* CommandRunner;
      return yield* runner.run("/dotfiles-test-missing-executable");
    }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
  assert.ok(Exit.isFailure(exit));
  const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
  assert.ok(error instanceof CommandError);
  assert.ok(error.cause instanceof PlatformError.PlatformError);
  assert.equal(error.cause.reason._tag, "NotFound");
  assert.equal(error.message, String(error.cause));
});

test("a child that inherits stdin stays in the caller's terminal process group", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* CommandRunner;
      return yield* runner.run("sh", ["-c", 'ps -o pgid= -p "$$"'], { stdin: "inherit" });
    }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
  const caller = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), caller.stdout.trim());
});

test("a timeout kills a child that ignores SIGTERM", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* CommandRunner;
      return yield* runner.run("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], {
        timeoutMs: 200,
      });
    }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
  );
  assert.equal(result.status, 124);
}, 15_000);
