import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { basename, isAbsolute, join } from "node:path";
import { runCommand as runRaw } from "../lib/command.ts";
import { CliFailure, fail } from "../lib/program.ts";
import { requireProfile } from "../profiles/model.ts";
import type { ProfileModel } from "../profiles/model.ts";
import { brewfilePath, profileBrewfiles, withLocalBrewfile } from "./homebrew.ts";

const PackageName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9@+._/-]+$/)));
const CommandCapability = Schema.Struct({
  packageType: Schema.Literals(["brew", "cask"]),
  name: PackageName,
  validator: Schema.Literal("command"),
  path: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
});
const BundleCapability = Schema.Struct({
  packageType: Schema.Literal("cask"),
  name: PackageName,
  validator: Schema.Literal("bundle"),
  path: Schema.NonEmptyString,
  bundleIdentifier: Schema.NonEmptyString,
  teamIdentifier: Schema.NonEmptyString,
});
const ExternalHomebrew = Schema.Struct({
  version: Schema.Literal(1),
  capabilities: Schema.Array(Schema.Union([CommandCapability, BundleCapability])),
});

const parsePlist = Effect.fn("parseExternalHomebrewPlist")(function* (path: string) {
  const converted = yield* runRaw("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  if (converted.status !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${path} is not a valid property list`,
    );
  }
  const json = yield* Effect.try({
    try: () => JSON.parse(converted.stdout) as unknown,
    catch: () =>
      new CliFailure({
        exitCode: 1,
        message: `invalid external Homebrew capability: ${path} is not a valid property list`,
      }),
  });
  return yield* Schema.decodeUnknownEffect(ExternalHomebrew, {
    errors: "all",
    onExcessProperty: "error",
  })(json).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: 1,
          message: `invalid external Homebrew capability: ${error.message}`,
        }),
    ),
  );
});

const declared = Effect.fn("externalHomebrewEntryDeclared")(function* (
  repoRoot: string,
  files: readonly string[],
  profile: string,
  packageType: "brew" | "cask",
  name: string,
) {
  const flag = packageType === "brew" ? "--formula" : "--cask";
  for (const file of files) {
    const listed = yield* runRaw(
      "brew",
      ["bundle", "list", flag, "--file", brewfilePath(repoRoot, file)],
      {
        env: { HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile, HOMEBREW_NO_AUTO_UPDATE: "1" },
      },
    );
    if (listed.status === 0 && listed.stdout.split("\n").includes(name)) {
      return true;
    }
    if (
      listed.status === 0 &&
      name.includes("/") &&
      listed.stdout.split("\n").includes(basename(name))
    ) {
      const fs = yield* FileSystem.FileSystem;
      const contents = yield* fs.readFileString(brewfilePath(repoRoot, file));
      if (contents.split("\n").some((line) => line.trim() === `${packageType} "${name}"`)) {
        return true;
      }
    }
  }
  return false;
});

const validateCommand = Effect.fn("validateExternalHomebrewCommand")(function* (
  packageType: string,
  name: string,
  path: string,
  args: readonly string[],
) {
  if (!isAbsolute(path)) {
    return yield* fail(
      `invalid external Homebrew capability: ${packageType} ${name} command path must be absolute`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || (info.value.mode & 0o111) === 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${packageType} ${name} command is not executable: ${path}`,
    );
  }
  const uid = Option.getOrUndefined(info.value.uid);
  if (uid !== process.getuid?.() && uid !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${path} must be owned by the current user or root`,
    );
  }
  if ((info.value.mode & 0o022) !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${path} must not be group or world writable`,
    );
  }
  const checked = yield* runRaw(path, args);
  if (checked.status !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${packageType} ${name} command check failed: ${path}`,
    );
  }
});

const validateBundle = Effect.fn("validateExternalHomebrewBundle")(function* (
  name: string,
  path: string,
  bundleIdentifier: string,
  teamIdentifier: string,
) {
  if (teamIdentifier === "not set") {
    return yield* fail(
      `invalid external Homebrew capability: ${name} requires a concrete signing team`,
    );
  }
  if (!isAbsolute(path) || !path.endsWith(".app")) {
    return yield* fail(
      `invalid external Homebrew capability: ${name} bundle path must be an absolute .app path`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "Directory") {
    return yield* fail(
      `invalid external Homebrew capability: ${name} bundle is missing or symlinked: ${path}`,
    );
  }
  const identifier = yield* runRaw("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    join(path, "Contents/Info.plist"),
  ]);
  if (identifier.status !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${name} bundle identifier is unreadable`,
    );
  }
  if (identifier.stdout.trim() !== bundleIdentifier) {
    return yield* fail(
      `invalid external Homebrew capability: ${name} bundle identifier is ${identifier.stdout.trim()}; expected ${bundleIdentifier}`,
    );
  }
  const verified = yield* runRaw("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
  if (verified.status !== 0) {
    return yield* fail(
      `invalid external Homebrew capability: ${name} bundle signature verification failed`,
    );
  }
  const detail = yield* runRaw("/usr/bin/codesign", ["-dv", "--verbose=4", path]);
  const actualTeam =
    `${detail.stdout}\n${detail.stderr}`
      .split("\n")
      .find((line) => line.startsWith("TeamIdentifier="))
      ?.slice("TeamIdentifier=".length) || "";
  if (detail.status !== 0 || actualTeam !== teamIdentifier) {
    return yield* fail(
      `invalid external Homebrew capability: ${name} signing team is ${actualTeam || "missing"}; expected ${teamIdentifier}`,
    );
  }
});

export const configureExternalCapabilities = Effect.fn("configureExternalHomebrewCapabilities")(
  function* (repoRoot: string, model: ProfileModel, profile: string) {
    const defaultPath = join(process.env.HOME || "", ".config/dotfiles/external-homebrew.plist");
    const path = process.env.DOTFILES_EXTERNAL_HOMEBREW_FILE || defaultPath;
    for (const key of [
      "HOMEBREW_BUNDLE_BREW_SKIP",
      "HOMEBREW_BUNDLE_CASK_SKIP",
      "HOMEBREW_BUNDLE_TAP_SKIP",
      "HOMEBREW_BUNDLE_MAS_SKIP",
    ] as const) {
      if (process.env[key]) {
        return yield* fail(
          `invalid external Homebrew capability: ambient Homebrew Bundle skip variables are unsupported; use ${path}`,
        );
      }
    }
    const fs = yield* FileSystem.FileSystem;
    const link = yield* fs.readLink(path).pipe(Effect.option);
    const exists = yield* fs.exists(path);
    if (!exists && Option.isNone(link)) {
      return {};
    }
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "File") {
      return yield* fail(
        `invalid external Homebrew capability: ${path} must be a readable regular file`,
      );
    }
    if (Option.getOrUndefined(info.value.uid) !== process.getuid?.()) {
      return yield* fail(
        `invalid external Homebrew capability: ${path} must be owned by the current user`,
      );
    }
    if ((info.value.mode & 0o022) !== 0) {
      return yield* fail(
        `invalid external Homebrew capability: ${path} must not be group or world writable`,
      );
    }
    yield* fs.access(path, { readable: true }).pipe(
      Effect.mapError(
        () =>
          new CliFailure({
            exitCode: 1,
            message: `invalid external Homebrew capability: ${path} must be a readable regular file`,
          }),
      ),
    );
    const first = (yield* fs.readFileString(path)).split(/\r?\n/, 1)[0];
    if (!first?.startsWith("<?xml ")) {
      return yield* fail(
        `invalid external Homebrew capability: ${path} must be an XML property list`,
      );
    }
    const config = yield* parsePlist(path);
    const files = yield* withLocalBrewfile(repoRoot, profileBrewfiles(model, profile));
    const seen = new Set<string>();
    const skips: Record<"HOMEBREW_BUNDLE_BREW_SKIP" | "HOMEBREW_BUNDLE_CASK_SKIP", string[]> = {
      HOMEBREW_BUNDLE_BREW_SKIP: [],
      HOMEBREW_BUNDLE_CASK_SKIP: [],
    };
    for (const capability of config.capabilities) {
      const externalOnly =
        requireProfile(model, profile).externalHomebrew?.some(
          (entry) => entry.packageType === capability.packageType && entry.name === capability.name,
        ) ?? false;
      if (
        !externalOnly &&
        !(yield* declared(repoRoot, files, profile, capability.packageType, capability.name))
      ) {
        return yield* fail(
          `invalid external Homebrew capability: ${capability.packageType} ${capability.name} is not declared by profile ${profile} or the local Brewfile`,
        );
      }
      const key = `${capability.packageType}|${capability.name}`;
      if (seen.has(key)) {
        return yield* fail(`invalid external Homebrew capability: duplicate ${key}`);
      }
      seen.add(key);
      if (capability.validator === "command") {
        if (capability.arguments.length > 3) {
          return yield* fail(
            `invalid external Homebrew capability: ${capability.name} command validation accepts at most three arguments`,
          );
        }
        yield* validateCommand(
          capability.packageType,
          capability.name,
          capability.path,
          capability.arguments,
        );
      } else {
        yield* validateBundle(
          capability.name,
          capability.path,
          capability.bundleIdentifier,
          capability.teamIdentifier,
        );
      }
      if (!externalOnly) {
        skips[
          capability.packageType === "brew"
            ? "HOMEBREW_BUNDLE_BREW_SKIP"
            : "HOMEBREW_BUNDLE_CASK_SKIP"
        ].push(capability.name);
      }
      yield* Console.log(`validated external ${capability.packageType} ${capability.name}`);
    }
    return Object.fromEntries(
      Object.entries(skips)
        .filter(([, values]) => values.length > 0)
        .map(([key, values]) => [key, values.join(" ")]),
    );
  },
);
