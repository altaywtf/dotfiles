import { Effect, FileSystem, Schema } from "effect";
import { readFileSync } from "node:fs";

const Capabilities = Schema.Struct({
  requiresSopsIdentity: Schema.Boolean,
  devbox: Schema.Boolean,
  workstation: Schema.Boolean,
  personal: Schema.Boolean,
});

const AgentLayer = Schema.Literals(["developer", "workstation", "devbox", "personal"]);
const InstallStep = Schema.Literals([
  "apply-dotfiles",
  "install-t3-service",
  "install-oh-my-zsh",
  "trust-agent-worktrees",
  "install-gh-extensions",
  "install-runtimes",
  "install-repository-dependencies",
  "configure-codex",
  "configure-grok",
  "configure-llm-gateway",
  "sync-agents",
]);
const ProfileConfig = Schema.Struct({
  capabilities: Capabilities,
  brewfiles: Schema.NonEmptyArray(Schema.NonEmptyString),
  externalHomebrew: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        packageType: Schema.Literals(["brew", "cask"]),
        name: Schema.NonEmptyString,
      }),
    ),
  ),
  agentLayers: Schema.Array(AgentLayer).pipe(
    Schema.check(
      Schema.makeFilter(
        (layers: ReadonlyArray<typeof AgentLayer.Type>) =>
          layers.includes("developer") || "must include developer",
      ),
    ),
  ),
  installSteps: Schema.TupleWithRest(
    Schema.Tuple([
      Schema.Literal("apply-dotfiles"),
      Schema.Literal("install-runtimes"),
      Schema.Literal("install-repository-dependencies"),
    ]),
    [InstallStep],
  ),
});
const ProfileModel = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Record(Schema.String, ProfileConfig),
});
const ProfileDocument = Schema.Struct({ profileModel: ProfileModel });

export type InstallStep = typeof InstallStep.Type;
export type AgentLayer = typeof AgentLayer.Type;
export type ProfileConfig = typeof ProfileConfig.Type;
export type ProfileModel = typeof ProfileModel.Type;

class ProfileModelError extends Schema.TaggedError<ProfileModelError>()("ProfileModelError", {
  message: Schema.String,
}) {}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const validateProfile = Effect.fn("validateProfile")(function* (
  name: string,
  profile: ProfileConfig,
) {
  if (!/^[a-z][a-z-]*$/.test(name)) {
    return yield* new ProfileModelError({ message: `profile name ${name} is invalid` });
  }
  for (const [field, values] of [
    ["brewfiles", profile.brewfiles],
    ["agentLayers", profile.agentLayers],
    ["installSteps", profile.installSteps],
  ] as const) {
    if (!hasUniqueValues(values)) {
      return yield* new ProfileModelError({
        message: `profile ${name} ${field} must contain unique values`,
      });
    }
  }
  if (profile.brewfiles[0] !== "homebrew/Brewfile") {
    return yield* new ProfileModelError({
      message: `profile ${name} must start with the shared Brewfile`,
    });
  }
});

const parseProfileModelEffect = Effect.fn("parseProfileModel")(function* (contents: string) {
  const parsed = yield* Effect.try({
    try: () => JSON.parse(contents) as unknown,
    catch: (error) =>
      new ProfileModelError({
        message: `profile model is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
  const document = yield* Schema.decodeUnknownEffect(ProfileDocument, {
    errors: "all",
    onExcessProperty: "error",
  })(parsed).pipe(
    Effect.mapError(
      (error) =>
        new ProfileModelError({ message: `profile model has an invalid shape: ${error.message}` }),
    ),
  );
  const entries = Object.entries(document.profileModel.profiles);
  if (entries.length === 0) {
    return yield* new ProfileModelError({
      message: "profile model must contain at least one profile",
    });
  }
  yield* Effect.forEach(entries, ([name, profile]) => validateProfile(name, profile));
  return document.profileModel;
});

export const readProfileModelEffect = Effect.fn("readProfileModel")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (error) =>
          new ProfileModelError({ message: `cannot read profile model ${path}: ${error.message}` }),
      ),
    );
  return yield* parseProfileModelEffect(contents);
});

export function parseProfileModel(contents: string): ProfileModel {
  return Effect.runSync(parseProfileModelEffect(contents));
}

export function readProfileModel(path: string): ProfileModel {
  return parseProfileModel(readFileSync(path, "utf8"));
}

export function requireProfile(model: ProfileModel, name: string): ProfileConfig {
  if (!Object.hasOwn(model.profiles, name)) {
    throw new Error(`unknown profile ${name || "<empty>"}`);
  }
  return model.profiles[name];
}
