#!/usr/bin/env node

import { configureExternalCapabilities } from "./external-capabilities.ts";

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { commandAvailable } from "../lib/command-available.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import {
  brewfilePath,
  composeBrewfile,
  profileBrewfiles,
  removeComposedBrewfile,
  runHomebrewRaw,
  trustTaps,
  withLocalBrewfile,
} from "./homebrew.ts";
import { normalizeProfile, profileModelFile } from "../profiles/current.ts";
import { readProfileModelEffect } from "../profiles/model.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const usage = `Usage:
  homebrew/brew-bundle.ts developer|devbox|workstation|personal-devbox|personal-workstation
  homebrew/brew-bundle.ts --shared-only PROFILE
  homebrew/brew-bundle.ts --print-files PROFILE
  homebrew/brew-bundle.ts --cleanup PROFILE
  homebrew/brew-bundle.ts --maintenance PROFILE

Installs the shared base first, then the selected profile layers and an optional
gitignored Brewfile.local. --shared-only skips both.
--cleanup removes packages outside the complete host contract.
--maintenance installs missing declarations without upgrades.`;

type Arguments = {
  readonly profile: string;
  readonly sharedOnly: boolean;
  readonly printFiles: boolean;
  readonly cleanup: boolean;
  readonly maintenance: boolean;
};

const parseArguments = Effect.fn("parseBrewBundleArguments")(function* (
  raw: readonly string[],
): Effect.fn.Return<Arguments, CliFailure> {
  let profile = "";
  let sharedOnly = false;
  let printFiles = false;
  let cleanup = false;
  let maintenance = false;
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === "--profile") {
      const value = raw[index + 1];
      if (!value || profile) {
        return yield* fail("invalid --profile", 2);
      }
      profile = value;
      index += 1;
    } else if (argument === "--shared-only") {
      if (sharedOnly) {
        return yield* fail("duplicate --shared-only", 2);
      }
      sharedOnly = true;
    } else if (argument === "--print-files") {
      if (printFiles) {
        return yield* fail("duplicate --print-files", 2);
      }
      printFiles = true;
    } else if (argument === "--maintenance") {
      if (maintenance) {
        return yield* fail("duplicate --maintenance", 2);
      }
      maintenance = true;
    } else if (argument === "--cleanup") {
      if (cleanup) {
        return yield* fail("duplicate --cleanup", 2);
      }
      cleanup = true;
    } else if (argument?.startsWith("-")) {
      return yield* fail(`unsupported argument ${argument}`, 2);
    } else if (!profile && argument) {
      profile = argument;
    } else {
      return yield* fail("multiple profiles are unsupported", 2);
    }
  }
  if (!profile || (cleanup && (sharedOnly || maintenance))) {
    return yield* fail("invalid brew bundle arguments", 2);
  }
  return { profile, sharedOnly, printFiles, cleanup, maintenance };
});

const execute = Effect.fn("executeBrewBundleCommand")(function* (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run(command, args, { env, extendEnv: true, stdin: "inherit", output: "inherit" })
    .pipe(Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })));
  if (result.status !== 0) {
    return yield* fail(`${command} exited ${result.status}`, result.status);
  }
});

const program = Effect.gen(function* () {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && (raw[0] === "-h" || raw[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args = yield* parseArguments(raw).pipe(Effect.tapError(() => Console.error(usage)));
  const profile = yield* normalizeProfile(args.profile).pipe(
    Effect.mapError(() => new CliFailure({ exitCode: 2, message: usage })),
  );
  const model = yield* readProfileModelEffect(profileModelFile());
  const files = args.sharedOnly
    ? profileBrewfiles(model, profile).slice(0, 1)
    : yield* withLocalBrewfile(repoRoot, profileBrewfiles(model, profile));
  if (args.printFiles) {
    for (const file of files) {
      yield* Console.log(brewfilePath(repoRoot, file));
    }
    return;
  }
  if (!(yield* commandAvailable("brew"))) {
    return yield* fail("brew is required before running this script");
  }
  const external = yield* configureExternalCapabilities(repoRoot, model, profile);
  if (args.maintenance) {
    const checks = yield* Effect.forEach(files, (file) =>
      runHomebrewRaw(
        "brew",
        ["bundle", "check", "--no-upgrade", "--file", brewfilePath(repoRoot, file)],
        {
          env: {
            ...external,
            HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile,
            HOMEBREW_NO_AUTO_UPDATE: "1",
          },
        },
      ),
    );
    if (checks.every((result) => result.status === 0)) {
      yield* Console.log("All declared Homebrew packages are installed.");
      return;
    }
  }
  yield* trustTaps(repoRoot, files);
  for (const file of files) {
    const path = brewfilePath(repoRoot, file);
    yield* Console.log(`\n## brew bundle --file ${path}`);
    const env = { ...external, HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile };
    const bundleArgs = ["bundle", ...(args.maintenance ? ["--no-upgrade"] : []), "--file", path];
    yield* execute("brew", bundleArgs, env);
  }
  if (!args.cleanup) {
    return;
  }
  const composed = yield* composeBrewfile(
    repoRoot,
    yield* withLocalBrewfile(repoRoot, profileBrewfiles(model, profile)),
  );
  yield* Effect.gen(function* () {
    yield* trustTaps(repoRoot, [composed]);
    yield* Console.log(`\n## brew bundle cleanup --force (composed ${profile} host contract)`);
    const env = { ...external, HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile };
    yield* execute("brew", ["bundle", "cleanup", "--force", "--file", composed], env);
  }).pipe(Effect.ensuring(removeComposedBrewfile(repoRoot, composed).pipe(Effect.orDie)));
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
