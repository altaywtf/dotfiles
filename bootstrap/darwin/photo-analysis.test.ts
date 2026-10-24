import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import { CommandError, CommandRunner } from "../../lib/command.ts";
import { CliFailure } from "../../lib/program.ts";
import { NodeServices } from "@effect/platform-node";
import { checkDevboxPhotoAnalysis, disableDevboxPhotoAnalysis } from "./photo-analysis.ts";

const profiles = ["developer", "workstation", "personal-workstation", "devbox", "personal-devbox"];

function run<A, E>(
  effect: Effect.Effect<A, E, CommandRunner | NodeServices.NodeServices>,
  runner: CommandRunner["Service"],
) {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(CommandRunner, runner), Effect.provide(NodeServices.layer)),
  );
}

function launchctlRunner(loaded: boolean, bootoutStatus = 0) {
  const calls: string[][] = [];
  const runner = CommandRunner.of({
    run: (command, args = []) => {
      calls.push([command, ...args]);
      const status = args[0] === "print" ? (loaded ? 0 : 113) : bootoutStatus;
      return Effect.succeed({ status, stdout: "", stderr: "" });
    },
  });
  return { calls, runner };
}

test("Photos analysis policy applies only to macOS devbox profiles", async () => {
  for (const profile of profiles) {
    for (const platform of ["darwin", "linux"] as const) {
      for (const dryRun of [false, true]) {
        const { calls, runner } = launchctlRunner(false);
        await run(disableDevboxPhotoAnalysis(profile, 501, dryRun, platform), runner);
        assert.deepEqual(
          calls,
          platform === "darwin" && !dryRun && ["devbox", "personal-devbox"].includes(profile)
            ? [["launchctl", "disable", "gui/501/com.apple.photoanalysisd"]]
            : [],
        );
      }
    }
  }
});

test("Photos analysis policy reports a rejected launchctl change", async () => {
  const { runner } = launchctlRunner(false, 5);
  const failure = await run(
    disableDevboxPhotoAnalysis("devbox", 501, false, "darwin").pipe(Effect.flip),
    runner,
  );
  assert.ok(failure instanceof CliFailure);
  assert.equal(failure.exitCode, 5);
});

for (const profile of profiles) {
  for (const platform of ["darwin", "linux"] as const) {
    test(`Photos verification boundary: ${profile} on ${platform}`, async () => {
      const calls: string[][] = [];
      const runner = CommandRunner.of({
        run: (command, args = []) => {
          calls.push([command, ...args]);
          return Effect.succeed({
            status: 0,
            stdout: '"com.apple.photoanalysisd" => disabled',
            stderr: "",
          });
        },
      });
      await run(checkDevboxPhotoAnalysis(profile, 501, platform), runner);
      assert.deepEqual(
        calls,
        platform === "darwin" && profile.endsWith("devbox")
          ? [["launchctl", "print-disabled", "gui/501"]]
          : [],
      );
    });
  }
}
for (const output of [
  '"com.apple.photoanalysisd" => enabled',
  '"com.apple.photoanalysisd" => false',
  "",
  '"com.apple.photoanalysisd.other" => disabled',
]) {
  test(`Photos verification rejects drift: ${output}`, async () => {
    const runner = CommandRunner.of({
      run: () => Effect.succeed({ status: 0, stdout: output, stderr: "" }),
    });
    await assert.rejects(
      run(checkDevboxPhotoAnalysis("devbox", 501, "darwin"), runner),
      /policy drift/,
    );
  });
}
for (const failure of ["exit", "spawn"] as const) {
  test(`Photos verification fails closed on ${failure}`, async () => {
    const runner = CommandRunner.of({
      run: () =>
        failure === "spawn"
          ? Effect.fail(new CommandError({ command: "launchctl", message: "unavailable" }))
          : Effect.succeed({
              status: 1,
              stdout: '"com.apple.photoanalysisd" => disabled',
              stderr: "",
            }),
    });
    await assert.rejects(run(checkDevboxPhotoAnalysis("devbox", 501, "darwin"), runner));
  });
}
test("Photos verification rejects root without invoking launchctl", async () => {
  const runner = CommandRunner.of({
    run: () => {
      throw new Error("must not run");
    },
  });
  await assert.rejects(run(checkDevboxPhotoAnalysis("devbox", 0, "darwin"), runner), /non-root/);
});
