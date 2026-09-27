#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.DOTFILES_OPERATOR_REPO_ROOT || sourceRoot;
const defaultProfile = "developer";
const usage = `Usage: ./dotfiles diff|check [PROFILE]
       ./dotfiles apply [PROFILE] [--switch-profile]

  diff   Preview per-user convergence
  apply  Converge the selected per-user profile
  check  Check the live per-user profile

PROFILE defaults to the stored ~/.config/dotfiles/profile, then ${defaultProfile}.
apply refuses a PROFILE other than the stored one unless --switch-profile is given.
Homebrew packages, identities, secrets, and host-wide settings remain separate.`;

const delegate = Effect.fn("delegateDotfilesCommand")(function* (
  owner: string,
  args: readonly string[],
  commandName: string,
  profile: string,
) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run(resolve(repoRoot, owner), args, {
    cwd: repoRoot,
    stdin: "inherit",
    output: "inherit",
  });
  if (result.status !== 0) {
    return yield* fail(
      `${owner} failed; fix the error above and rerun ./dotfiles ${commandName} ${profile}`,
      result.status,
    );
  }
});

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const switchProfile = argv.includes("--switch-profile");
  const args = argv.filter((argument) => argument !== "--switch-profile");
  if (
    args.length < 1 ||
    args.length > 2 ||
    argv.length - args.length > 1 ||
    (switchProfile && args[0] !== "apply")
  ) {
    yield* Console.error(usage);
    return yield* fail("invalid operator arguments", 2);
  }
  const commandName = args[0];
  // A stored marker wins; only a missing marker falls back to the default.
  const requestedProfile =
    args[1] ??
    (yield* resolveProfile(undefined, { ...process.env, DOTFILES_PROFILE: defaultProfile }).pipe(
      Effect.mapError(
        (error) => new CliFailure({ exitCode: error.exitCode, message: error.message }),
      ),
    ));
  const model = yield* readProfileModelEffect(
    resolve(repoRoot, "chezmoi/.chezmoidata/profiles.json"),
  );
  let profile: string;
  try {
    requireProfile(model, requestedProfile);
    profile = requestedProfile;
  } catch {
    yield* Console.error(`unsupported profile: ${requestedProfile}`);
    yield* Console.error(usage);
    return yield* fail("unsupported profile", 2);
  }

  yield* Console.error(
    "Not included: Homebrew packages, identities, secrets, or host-wide settings.",
  );
  switch (commandName) {
    case "diff":
      yield* Console.log(`Per-user convergence steps for ${profile}:`);
      yield* delegate(
        "bootstrap/install.ts",
        ["--print-steps", "--profile", profile],
        commandName,
        profile,
      );
      yield* Console.log("\nDotfile changes:");
      return yield* delegate(
        "bootstrap/apply-dotfiles.ts",
        ["--profile", profile, "--dry-run", "--verbose"],
        commandName,
        profile,
      );
    case "apply":
      return yield* delegate(
        "bootstrap/install.ts",
        ["--profile", profile, ...(switchProfile ? ["--switch-profile"] : [])],
        commandName,
        profile,
      );
    case "check":
      return yield* delegate("verify/bootstrap.ts", ["--profile", profile], commandName, profile);
    default:
      yield* Console.error(`unsupported command: ${commandName}`);
      yield* Console.error(usage);
      return yield* fail("unsupported command", 2);
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
