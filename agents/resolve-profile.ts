#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { normalizeProfile, resolveProfile } from "../profiles/current.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";

const usage = "Usage: agents/resolve-profile.ts [--expected PROFILE]";

const program = Effect.gen(function* () {
  let expected: string | undefined;

  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];

    if (argument === "--expected" && process.argv[index + 1]) {
      expected = process.argv[index + 1];
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);

      return;
    } else {
      yield* Console.error(usage);

      return yield* fail("invalid profile resolver arguments", 2);
    }
  }

  const normalizedExpected =
    expected === undefined
      ? undefined
      : yield* normalizeProfile(expected).pipe(
          Effect.mapError(
            () =>
              new CliFailure({ exitCode: 2, message: `unsupported expected profile: ${expected}` }),
          ),
        );

  const profileEnv = { ...process.env };
  delete profileEnv.DOTFILES_PROFILE;
  delete profileEnv.DOTFILES_PROFILE_FILE;

  const profile = yield* resolveProfile(undefined, profileEnv).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: error.exitCode === 2 && expected ? 2 : 3,
          message: `cannot use agent sync; ${error.message}`,
        }),
    ),
  );

  if (normalizedExpected && profile !== normalizedExpected) {
    return yield* fail(
      `cannot use agent sync; expected profile ${normalizedExpected} but the profile marker contains ${profile}`,
      3,
    );
  }

  yield* Console.log(profile);
}).pipe(Effect.provide(NodeServices.layer));

runMain(program);
