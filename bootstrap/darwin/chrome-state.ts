#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Schema } from "effect";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliFailure, runMain } from "../../lib/program.ts";

type Mode = "enable" | "disable";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

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
  let data: Record<string, unknown> = {};
  if (Option.isSome(source)) {
    data = yield* Effect.try({
      try: () => object(JSON.parse(source.value), `${path} contents`),
      catch: (error) => error,
    });
  }
  const browser = data.browser === undefined ? {} : object(data.browser, '"browser"');
  const current = browser.enabled_labs_experiments ?? [];
  if (!Array.isArray(current))
    return yield* Effect.fail(new Error('"browser.enabled_labs_experiments" must be a JSON array'));
  const prefix = `${flagName}@`;
  const experiments = current.filter(
    (item) => typeof item !== "string" || (item !== flagName && !item.startsWith(prefix)),
  );
  if (mode === "enable") experiments.push(flagValue);
  browser.enabled_labs_experiments = experiments;
  data.browser = browser;
  yield* writeAtomically(path, `${JSON.stringify(data)}\n`);
});

// Chrome keeps the vertical tab strip as a per-profile preference
// (prefs::kVerticalTabsEnabled); no enterprise policy sets it.
export const updateChromeProfilesEffect = Effect.fn("updateChromeProfiles")(function* (
  root: string,
  mode: Mode,
) {
  const fs = yield* FileSystem.FileSystem;
  const profiles: string[] = [];
  if (yield* fs.exists(root)) {
    for (const name of yield* fs.readDirectory(root)) {
      if (name === "System Profile" || name === "Guest Profile") continue;
      const path = join(root, name, "Preferences");
      if (yield* fs.exists(path)) profiles.push(path);
    }
  }
  if (profiles.length === 0 && mode === "enable")
    profiles.push(join(root, "Default", "Preferences"));
  let updated = 0;
  for (const path of profiles.sort()) {
    const source = (yield* fs.exists(path)) ? yield* fs.readFileString(path) : "{}";
    const data = yield* Effect.try({
      try: () => object(JSON.parse(source), `${path} contents`),
      catch: (error) => error,
    });
    const verticalTabs =
      data.vertical_tabs === undefined ? {} : object(data.vertical_tabs, '"vertical_tabs"');
    if (mode === "enable" ? verticalTabs.enabled === true : !("enabled" in verticalTabs)) continue;
    if (mode === "enable") verticalTabs.enabled = true;
    else delete verticalTabs.enabled;
    data.vertical_tabs = verticalTabs;
    yield* writeAtomically(path, JSON.stringify(data));
    updated += 1;
  }
  return { checked: profiles.length, updated };
});

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
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
