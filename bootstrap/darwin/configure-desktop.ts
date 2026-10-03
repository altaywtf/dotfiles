#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wallpaperIndex = join(
  process.env.HOME || "",
  "Library/Application Support/com.apple.wallpaper/Store/Index.plist",
);
const wallpaperSource = resolve(repoRoot, "bootstrap/darwin/assets/black-wallpaper.plist");
const usage = `Usage:
  bootstrap/darwin/configure-desktop.ts [--check]

Applies or verifies the owner desktop baseline for a macOS devbox: black system
wallpaper, hidden desktop icons and widgets, compact auto-hiding Dock, no recent
apps, and Google Chrome as the only persistent Dock application.`;

const defaultEquals = Effect.fn("defaultEquals")(function* (
  domain: string,
  key: string,
  expected: string,
) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("defaults", ["read", domain, key]);
  return result.status === 0 && result.stdout.trim() === expected;
});

const wallpaperIsBlack = Effect.fn("wallpaperIsBlack")(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(wallpaperIndex))) return false;
  const runner = yield* CommandRunner;
  const provider = yield* runner.run("plutil", [
    "-extract",
    "AllSpacesAndDisplays.Linked.Content.Choices.0.Provider",
    "raw",
    "-o",
    "-",
    wallpaperIndex,
  ]);
  if (provider.status !== 0 || provider.stdout.trim() !== "com.apple.wallpaper.choice.color")
    return false;
  const configuration = yield* runner.run("plutil", [
    "-extract",
    "AllSpacesAndDisplays.Linked.Content.Choices.0.Configuration",
    "raw",
    "-o",
    "-",
    wallpaperIndex,
  ]);
  if (configuration.status !== 0) return false;
  const decodedPath = yield* fs.makeTempFileScoped({
    prefix: "wallpaper-configuration.",
    suffix: ".plist",
  });
  yield* fs.writeFile(decodedPath, Buffer.from(configuration.stdout.trim(), "base64"));
  const decoded = yield* runner.run("plutil", ["-p", decodedPath]);
  return (
    decoded.status === 0 &&
    decoded.stdout.includes('"systemColor"') &&
    decoded.stdout.includes('"black"')
  );
});

const dockHasOnlyChrome = Effect.fn("dockHasOnlyChrome")(function* () {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("defaults", ["read", "com.apple.dock", "persistent-apps"]);
  if (result.status !== 0) return false;
  const bundleCount = result.stdout.match(/"bundle-identifier"/g)?.length ?? 0;
  const chromeCount =
    result.stdout.match(/"bundle-identifier" = "com\.google\.Chrome"/g)?.length ?? 0;
  if (bundleCount !== 1 || chromeCount !== 1) return false;
  // `defaults read` prints a string "15" and an integer 15 identically; the Dock
  // only resolves the integer and shows a question mark otherwise.
  const exported = yield* runner.run("defaults", ["export", "com.apple.dock", "-"]);
  if (exported.status !== 0) return false;
  const urlType = yield* runner.run(
    "plutil",
    [
      "-extract",
      "persistent-apps.0.tile-data.file-data._CFURLStringType",
      "raw",
      "-expect",
      "integer",
      "-o",
      "-",
      "-",
    ],
    { stdin: new TextEncoder().encode(exported.stdout) },
  );
  return urlType.status === 0 && urlType.stdout.trim() === "15";
});

const dockArrayIsEmpty = Effect.fn("dockArrayIsEmpty")(function* (key: string) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("defaults", ["read", "com.apple.dock", key]);
  return !result.stdout.includes('"tile-data"');
});

const stateIsCorrect = Effect.fn("desktopStateIsCorrect")(function* () {
  return (
    (yield* defaultEquals("com.apple.dock", "autohide", "1")) &&
    (yield* defaultEquals("com.apple.dock", "tilesize", "31")) &&
    (yield* defaultEquals("com.apple.dock", "show-recents", "0")) &&
    (yield* defaultEquals("com.apple.finder", "CreateDesktop", "0")) &&
    (yield* defaultEquals("com.apple.WindowManager", "HideDesktop", "1")) &&
    (yield* defaultEquals("com.apple.WindowManager", "StandardHideWidgets", "1")) &&
    (yield* defaultEquals("com.apple.WindowManager", "StageManagerHideWidgets", "1")) &&
    (yield* dockHasOnlyChrome()) &&
    (yield* dockArrayIsEmpty("persistent-others")) &&
    (yield* dockArrayIsEmpty("recent-apps")) &&
    (yield* wallpaperIsBlack())
  );
});

const writeDefault = Effect.fn("writeDefault")(function* (args: readonly string[]) {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("defaults", ["write", ...args], { output: "inherit" });
  if (result.status !== 0)
    return yield* fail(`defaults write ${args[0]} ${args[1]} exited ${result.status}`);
});

const program = Effect.gen(function* () {
  let checkOnly = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--check") checkOnly = true;
    else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }
  if (process.platform !== "darwin") return yield* fail("desktop baseline requires macOS");
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists("/Applications/Google Chrome.app")))
    return yield* fail("Google Chrome is not installed");
  if (yield* stateIsCorrect()) {
    yield* Console.log("desktop baseline ok");
    return;
  }
  if (checkOnly) return yield* fail("desktop baseline drift detected");

  yield* writeDefault(["com.apple.dock", "autohide", "-bool", "true"]);
  yield* writeDefault(["com.apple.dock", "tilesize", "-int", "31"]);
  yield* writeDefault(["com.apple.dock", "show-recents", "-bool", "false"]);
  yield* writeDefault([
    "com.apple.dock",
    "persistent-apps",
    "-array",
    // XML keeps _CFURLStringType an integer; the old-style plist syntax makes it a string.
    `<dict>
  <key>tile-data</key>
  <dict>
    <key>bundle-identifier</key><string>com.google.Chrome</string>
    <key>file-data</key>
    <dict>
      <key>_CFURLString</key><string>file:///Applications/Google%20Chrome.app/</string>
      <key>_CFURLStringType</key><integer>15</integer>
    </dict>
    <key>file-label</key><string>Google Chrome</string>
  </dict>
  <key>tile-type</key><string>file-tile</string>
</dict>`,
  ]);
  yield* writeDefault(["com.apple.dock", "persistent-others", "-array"]);
  yield* writeDefault(["com.apple.dock", "recent-apps", "-array"]);
  yield* writeDefault(["com.apple.finder", "CreateDesktop", "-bool", "false"]);
  yield* writeDefault(["com.apple.WindowManager", "HideDesktop", "-bool", "true"]);
  yield* writeDefault(["com.apple.WindowManager", "StandardHideWidgets", "-bool", "true"]);
  yield* writeDefault(["com.apple.WindowManager", "StageManagerHideWidgets", "-bool", "true"]);

  const runner = yield* CommandRunner;
  const lint = yield* runner.run("plutil", ["-lint", wallpaperSource]);
  if (lint.status !== 0) return yield* fail("black wallpaper plist is invalid");
  yield* fs.makeDirectory(dirname(wallpaperIndex), { recursive: true });
  yield* fs.copyFile(wallpaperSource, wallpaperIndex);
  yield* fs.chmod(wallpaperIndex, 0o644);
  yield* Effect.forEach(
    ["Dock", "Finder", "WallpaperAgent"],
    (name) => runner.run("killall", [name], { output: "ignore" }).pipe(Effect.ignore),
    { concurrency: "unbounded" },
  );
  yield* Effect.sleep("1 second");
  if (!(yield* stateIsCorrect())) return yield* fail("desktop baseline did not converge");
  yield* Console.log("desktop baseline applied");
}).pipe(Effect.scoped, Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
