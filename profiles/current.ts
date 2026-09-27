import { Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readProfileModelEffect, requireProfile } from "./model.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileModelPath = resolve(repoRoot, "chezmoi/.chezmoidata/profiles.json");

export class ProfileResolutionError extends Schema.TaggedError<ProfileResolutionError>()(
  "ProfileResolutionError",
  {
    exitCode: Schema.Int,
    message: Schema.String,
  },
) {}

function resolutionFailure(message: string, exitCode: number): ProfileResolutionError {
  return new ProfileResolutionError({ exitCode, message });
}

export const normalizeProfile = Effect.fn("normalizeProfile")(function* (requested: string) {
  const name = requested.trim();
  if (!/^[a-z][a-z-]*$/.test(name)) {
    return yield* resolutionFailure(`unsupported profile: ${requested}`, 2);
  }
  const model = yield* readProfileModelEffect(profileModelPath).pipe(
    Effect.mapError((error) => resolutionFailure(error.message, 2)),
  );
  return yield* Effect.try({
    try: () => {
      requireProfile(model, name);
      return name;
    },
    catch: () => resolutionFailure(`unsupported profile: ${requested}`, 2),
  });
});

export const readPersistedProfile = Effect.fn("readPersistedProfile")(function* (
  path: string,
  expectedUid?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const unsafe = () =>
    resolutionFailure(
      `profile marker is missing or unsafe: ${path}; it must be a regular file you own that group and others cannot write (chmod 600 ${path})`,
      3,
    );
  const link = yield* fs.readLink(path).pipe(Effect.option);
  if (Option.isSome(link)) {
    return yield* unsafe();
  }
  const info = yield* fs.stat(path).pipe(Effect.mapError(unsafe));
  if (info.type !== "File" || (info.mode & 0o022) !== 0) {
    return yield* unsafe();
  }
  if (expectedUid !== undefined && Option.getOrUndefined(info.uid) !== expectedUid) {
    return yield* unsafe();
  }
  const contents = yield* fs.readFileString(path).pipe(Effect.mapError(unsafe));
  if (!/^[^\r\n]*(?:\r?\n)?$/.test(contents)) {
    return yield* unsafe();
  }
  return yield* normalizeProfile(contents).pipe(Effect.mapError(unsafe));
});

function profileMarkerPath(env: NodeJS.ProcessEnv): string {
  return env.DOTFILES_PROFILE_FILE || join(env.HOME || "", ".config/dotfiles/profile");
}

// None only when no marker exists; an unsafe marker fails.
const readRecordedProfile = Effect.fn("readRecordedProfile")(function* (
  env: NodeJS.ProcessEnv,
  expectedUid: number | undefined,
) {
  const profileFile = profileMarkerPath(env);
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs
    .exists(profileFile)
    .pipe(
      Effect.mapError(() =>
        resolutionFailure(`profile marker is missing or unsafe: ${profileFile}`, 3),
      ),
    );
  const link = yield* fs.readLink(profileFile).pipe(Effect.option);
  if (!exists && Option.isNone(link) && env.DOTFILES_PROFILE_FILE === undefined) {
    return Option.none<string>();
  }
  return Option.some(yield* readPersistedProfile(profileFile, expectedUid));
});

export const guardProfileSwitch = Effect.fn("guardProfileSwitch")(function* (
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
  expectedUid: number | undefined = process.getuid?.(),
) {
  const recorded = yield* readRecordedProfile(env, expectedUid);
  if (Option.isSome(recorded) && recorded.value !== requested) {
    return yield* resolutionFailure(
      `this user is recorded as ${recorded.value} in ${profileMarkerPath(env)}; rerun with --switch-profile to replace it with ${requested}`,
      2,
    );
  }
});

export const resolveProfile = Effect.fn("resolveProfile")(function* (
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  expectedUid: number | undefined = process.getuid?.(),
) {
  let candidate = requested;
  if (!candidate) {
    const recorded = yield* readRecordedProfile(env, expectedUid);
    if (Option.isSome(recorded)) return recorded.value;
    candidate = env.DOTFILES_PROFILE;
  }
  if (!candidate?.trim()) {
    return yield* resolutionFailure(
      "a supported profile is required: developer, devbox, workstation, personal-devbox, or personal-workstation",
      1,
    );
  }
  return yield* normalizeProfile(candidate);
});

export function profileModelFile(): string {
  return profileModelPath;
}
