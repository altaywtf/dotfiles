import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { fail } from "../../lib/program.ts";
import { profileModelFile } from "../../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../../profiles/model.ts";

export const disableDevboxPhotoAnalysis = Effect.fn("disableDevboxPhotoAnalysis")(function* (
  profile: string,
  uid: number,
  dryRun: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin" || uid <= 0) {
    return;
  }
  const model = yield* readProfileModelEffect(profileModelFile());
  const { capabilities } = requireProfile(model, profile);
  if (!capabilities.devbox || capabilities.workstation) {
    return;
  }
  const service = `gui/${uid}/com.apple.photoanalysisd`;
  if (dryRun) {
    yield* Console.log(`would disable ${service}`);
    return;
  }
  const runner = yield* CommandRunner;
  const result = yield* runner.run("launchctl", ["disable", service]);
  if (result.status !== 0) {
    return yield* fail(
      `launchctl disable ${service} exited ${result.status}: ${result.stderr}`,
      result.status,
    );
  }
  yield* Console.log("Photos analysis disabled; an existing process may remain until logout");
});

export const checkDevboxPhotoAnalysis = Effect.fn("checkDevboxPhotoAnalysis")(function* (
  profile: string,
  uid: number,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin") {
    return;
  }
  const model = yield* readProfileModelEffect(profileModelFile());
  const { capabilities } = requireProfile(model, profile);
  if (!capabilities.devbox || capabilities.workstation) {
    return;
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    return yield* fail("Photos analysis policy requires a non-root user");
  }
  const runner = yield* CommandRunner;
  const result = yield* runner.run("launchctl", ["print-disabled", `gui/${uid}`], {
    output: "capture",
    timeoutMs: 5000,
  });
  if (result.status !== 0) {
    return yield* fail("cannot inspect Photos analysis policy with launchctl print-disabled");
  }
  if (!/^\s*"com\.apple\.photoanalysisd"\s*=>\s*(?:disabled|true)\s*$/m.test(result.stdout)) {
    return yield* fail("Photos analysis policy drift: run ./dotfiles apply to disable analysis");
  }
});
