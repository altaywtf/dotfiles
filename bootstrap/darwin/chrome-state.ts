#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { basename, dirname, join } from "node:path";
import { CliFailure, runMain } from "../../lib/program.ts";

type Mode = "enable" | "disable";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
type JsonObject = typeof JsonObject.Type;

const decodeObject = (schema: Schema.Codec<JsonObject, unknown>, value: unknown, label: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new Error(`${label} must be a JSON object`)),
  );
const object = (value: unknown, label: string) => decodeObject(JsonObject, value, label);
const jsonObject = (source: string, label: string) =>
  decodeObject(Schema.fromJsonString(JsonObject), source, label);

const Arguments = Schema.Tuple([
  Schema.NonEmptyString,
  Schema.Literals(["enable", "disable"]),
  Schema.NonEmptyString,
  Schema.NonEmptyString,
]);

const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = dirname(path);
  yield* fs.makeDirectory(directory, { recursive: true });
  const info = yield* fs.stat(path).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
  );
  const fileMode = Option.isSome(info) ? info.value.mode & 0o7777 : 0o600;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        directory,
        prefix: ".chrome-state.",
      });
      const temporaryPath = join(temporaryDirectory, basename(path));
      yield* fs.writeFileString(temporaryPath, contents, { mode: fileMode });
      yield* fs.chmod(temporaryPath, fileMode);
      yield* fs.rename(temporaryPath, path);
    }),
  );
});

export const updateChromeStateEffect = Effect.fn("updateChromeState")(function* (
  path: string,
  mode: Mode,
  flagName: string,
  flagValue: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
  );
  const data = Option.isSome(source) ? yield* jsonObject(source.value, `${path} contents`) : {};
  const browser = data.browser === undefined ? {} : yield* object(data.browser, '"browser"');
  const current = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(
    browser.enabled_labs_experiments ?? [],
  ).pipe(
    Effect.mapError(() => new Error('"browser.enabled_labs_experiments" must be a JSON array')),
  );
  const prefix = `${flagName}@`;
  const experiments = current.filter(
    (item) => !Predicate.isString(item) || (item !== flagName && !item.startsWith(prefix)),
  );
  const updated = {
    ...data,
    browser: {
      ...browser,
      enabled_labs_experiments: mode === "enable" ? [...experiments, flagValue] : experiments,
    },
  };
  yield* writeAtomically(path, `${JSON.stringify(updated)}\n`);
});

type Preference = { group: string; key: string; value: boolean };

const applyPreferences = Effect.fnUntraced(function* (
  data: JsonObject,
  preferences: readonly Preference[],
  mode: Mode,
) {
  const updated = { ...data };
  let changed = false;
  for (const { group, key, value } of preferences) {
    const section = updated[group] === undefined ? {} : yield* object(updated[group], `"${group}"`);
    if (mode === "enable" ? section[key] === value : !Predicate.hasProperty(section, key)) {
      continue;
    }
    updated[group] =
      mode === "enable"
        ? { ...section, [key]: value }
        : Object.fromEntries(Object.entries(section).filter(([name]) => name !== key));
    changed = true;
  }
  return changed ? Option.some(updated) : Option.none();
});

// prefs::kConfirmToQuitEnabled is browser-wide; turning it off drops the
// hold-Command-Q-to-quit prompt.
const localStatePreferences = [{ group: "browser", key: "confirm_to_quit", value: false }] as const;

export const updateChromeLocalStatePreferencesEffect = Effect.fn(
  "updateChromeLocalStatePreferences",
)(function* (path: string, mode: Mode) {
  const fs = yield* FileSystem.FileSystem;
  const source = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "{}";
  const updated = yield* applyPreferences(
    yield* jsonObject(source, `${path} contents`),
    localStatePreferences,
    mode,
  );
  if (Option.isNone(updated)) {
    return false;
  }
  yield* writeAtomically(path, `${JSON.stringify(updated.value)}\n`);
  return true;
});

// Chrome keeps these as per-profile preferences and no enterprise policy sets
// them: prefs::kVerticalTabsEnabled shows the vertical tab strip, and unpinning
// prefs::kTabSearchPinnedToTabstrip hides its Tab groups and Tab search buttons.
const profilePreferences = [
  { group: "vertical_tabs", key: "enabled", value: true },
  { group: "tab_search", key: "pinned_to_tabstrip", value: false },
] as const;

export const updateChromeProfilesEffect = Effect.fn("updateChromeProfiles")(function* (
  root: string,
  mode: Mode,
) {
  const fs = yield* FileSystem.FileSystem;
  const profiles: string[] = [];
  if (yield* fs.exists(root)) {
    for (const name of yield* fs.readDirectory(root)) {
      if (name === "System Profile" || name === "Guest Profile") {
        continue;
      }
      if ((yield* fs.stat(join(root, name))).type !== "Directory") {
        continue;
      }
      const path = join(root, name, "Preferences");
      if (yield* fs.exists(path)) {
        profiles.push(path);
      }
    }
  }
  if (profiles.length === 0 && mode === "enable") {
    profiles.push(join(root, "Default", "Preferences"));
  }
  let updated = 0;
  for (const path of profiles.sort()) {
    const source = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "{}";
    const profile = yield* applyPreferences(
      yield* jsonObject(source, `${path} contents`),
      profilePreferences,
      mode,
    );
    if (Option.isNone(profile)) {
      continue;
    }
    yield* writeAtomically(path, JSON.stringify(profile.value));
    updated += 1;
  }
  return { checked: profiles.length, updated };
});

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const program = Effect.gen(function* () {
    const [path, mode, flagName, flagValue] = yield* Schema.decodeUnknownEffect(Arguments)(
      process.argv.slice(2),
    ).pipe(
      Effect.mapError(
        () =>
          new CliFailure({
            exitCode: 2,
            message: "Usage: bootstrap/darwin/chrome-state.ts PATH <enable|disable> FLAG VALUE",
          }),
      ),
    );
    yield* updateChromeStateEffect(path, mode, flagName, flagValue);
  }).pipe(Effect.provide(NodeServices.layer));
  runMain(program);
}
