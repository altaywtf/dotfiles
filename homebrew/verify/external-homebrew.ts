#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { configureExternalCapabilities } from "../external-capabilities.ts";
import { fail, runMain } from "../../lib/program.ts";
import { readProfileModelEffect, requireProfile, type ProfileModel } from "../../profiles/model.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
type Capability = Record<string, unknown>;
const xml = (capabilities: readonly Capability[]) => {
  const value = (input: unknown): string => {
    if (typeof input === "string")
      return `<string>${input.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</string>`;
    if (typeof input === "number") return `<integer>${input}</integer>`;
    if (Array.isArray(input)) return `<array>${input.map(value).join("")}</array>`;
    if (typeof input === "object" && input !== null)
      return `<dict>${Object.entries(input)
        .map(([key, item]) => `<key>${key}</key>${value(item)}`)
        .join("")}</dict>`;
    throw new Error("unsupported plist fixture value");
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${value({ version: 1, capabilities })}</plist>\n`;
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const actual = yield* CommandRunner;
    const model = yield* readProfileModelEffect(
      join(repoRoot, "chezmoi/.chezmoidata/profiles.json"),
    );
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-external-homebrew." });
    const managed = join(temporary, "managed tool");
    const log = join(temporary, "managed.log");
    const config = join(temporary, "external-homebrew.plist");
    yield* fs.writeFileString(
      managed,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$MANAGED_TOOL_LOG"\nexit "${MANAGED_TOOL_EXIT:-0}"\n',
      { mode: 0o755 },
    );
    yield* fs.writeFileString(log, "");
    const command = (
      packageType: "brew" | "cask",
      name: string,
      args: readonly string[],
    ): Capability => ({ packageType, name, validator: "command", path: managed, arguments: args });
    const bundle = (name: string, path: string, identifier: string, team: string): Capability => ({
      packageType: "cask",
      name,
      validator: "bundle",
      path,
      bundleIdentifier: identifier,
      teamIdentifier: team,
    });
    const write = Effect.fn("writeExternalHomebrewFixture")(function* (
      capabilities: readonly Capability[],
    ) {
      yield* fs.writeFileString(config, xml(capabilities), { mode: 0o600 });
      yield* fs.chmod(config, 0o600);
    });
    const local = join(temporary, "Brewfile.local");
    const validate = Effect.fn("validateExternalHomebrewFixture")(function* (
      profile = "workstation",
      extra: Readonly<Record<string, string>> = {},
      profiles: ProfileModel = model,
    ) {
      Object.assign(process.env, {
        DOTFILES_EXTERNAL_HOMEBREW_FILE: config,
        DOTFILES_BREWFILE_LOCAL: join(temporary, "missing/Brewfile.local"),
        MANAGED_TOOL_LOG: log,
        ...extra,
      });
      for (const key of [
        "HOMEBREW_BUNDLE_BREW_SKIP",
        "HOMEBREW_BUNDLE_CASK_SKIP",
        "HOMEBREW_BUNDLE_TAP_SKIP",
        "HOMEBREW_BUNDLE_MAS_SKIP",
      ])
        if (!(key in extra)) delete process.env[key];
      return yield* configureExternalCapabilities(repoRoot, profiles, profile);
    });
    yield* write([
      command("brew", "git", ["--label=hello | dünya", " spaced value "]),
      command("cask", "google-chrome", ["--version"]),
    ]);
    const skips = yield* validate();
    assert.equal(skips.HOMEBREW_BUNDLE_BREW_SKIP, "git");
    assert.equal(skips.HOMEBREW_BUNDLE_CASK_SKIP, "google-chrome");
    const logged = yield* fs.readFileString(log);
    assert.match(logged, /^--label=hello \| dünya$/m);
    assert.match(logged, /^ spaced value $/m);
    yield* fs.chmod(managed, 0o777);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* fs.chmod(managed, 0o755);
    yield* write([command("cask", "tailscale-app", ["--version"])]);
    assert.equal(
      (yield* validate("personal-workstation")).HOMEBREW_BUNDLE_CASK_SKIP,
      "tailscale-app",
    );
    assert.equal((yield* validate("personal-devbox").pipe(Effect.option))._tag, "None");
    yield* write([command("brew", "not-declared", ["--version"])]);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* fs.writeFileString(local, 'brew "not-declared"\n', { mode: 0o600 });
    assert.equal(
      (yield* validate("workstation", { DOTFILES_BREWFILE_LOCAL: local }))
        .HOMEBREW_BUNDLE_BREW_SKIP,
      "not-declared",
    );
    yield* fs.chmod(local, 0o666);
    assert.equal(
      (yield* validate("workstation", { DOTFILES_BREWFILE_LOCAL: local }).pipe(Effect.option))._tag,
      "None",
    );
    yield* write([command("brew", "git", ["--version"])]);
    yield* fs.chmod(config, 0o666);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* fs.chmod(config, 0o600);
    const symlink = join(temporary, "link.plist");
    yield* fs.symlink(config, symlink);
    process.env.DOTFILES_EXTERNAL_HOMEBREW_FILE = symlink;
    assert.equal(
      (yield* configureExternalCapabilities(repoRoot, model, "workstation").pipe(Effect.option))
        ._tag,
      "None",
    );
    process.env.DOTFILES_EXTERNAL_HOMEBREW_FILE = config;
    yield* fs.writeFileString(config, "<plist><dict>");
    yield* fs.chmod(config, 0o600);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* write([command("brew", "git", ["one", "two", "three", "four"])]);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* write([command("brew", "git", ["--version"]), command("brew", "git", ["--help"])]);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");
    yield* write([command("brew", "git", ["--version"])]);
    assert.equal(
      (yield* validate("workstation", { MANAGED_TOOL_EXIT: "23" }).pipe(Effect.option))._tag,
      "None",
    );
    delete process.env.MANAGED_TOOL_EXIT;

    const managedCask = "example/tap/managed-tool";
    const externalModel: ProfileModel = {
      ...model,
      profiles: {
        ...model.profiles,
        workstation: {
          ...requireProfile(model, "workstation"),
          externalHomebrew: [{ packageType: "cask", name: managedCask }],
        },
      },
    };
    yield* write([command("cask", managedCask, ["version"])]);
    assert.deepEqual(yield* validate("workstation", {}, externalModel), {});
    assert.equal(
      (yield* validate("workstation", { MANAGED_TOOL_EXIT: "23" }, externalModel).pipe(
        Effect.option,
      ))._tag,
      "None",
    );
    delete process.env.MANAGED_TOOL_EXIT;
    assert.equal((yield* validate("devbox", {}, externalModel).pipe(Effect.option))._tag, "None");
    yield* fs.writeFileString(local, `cask "${managedCask}"\n`);
    yield* fs.chmod(local, 0o600);
    for (const profile of ["workstation", "devbox"]) {
      assert.equal(
        (yield* validate(profile, { DOTFILES_BREWFILE_LOCAL: local })).HOMEBREW_BUNDLE_CASK_SKIP,
        managedCask,
      );
    }
    yield* write([command("cask", "uinaf/tap/slopwake", ["version"])]);
    assert.equal((yield* validate().pipe(Effect.option))._tag, "None");

    const app = join(temporary, "Managed Browser.app");
    yield* fs.makeDirectory(join(app, "Contents"), { recursive: true });
    yield* fs.writeFileString(join(app, "Contents/Info.plist"), "fixture");
    const fakeRunner = CommandRunner.of({
      run: (executable, args, options) => {
        if (executable === "/usr/libexec/PlistBuddy")
          return Effect.succeed({
            status: 0,
            stdout: `${process.env.TEST_BUNDLE_ID || "com.example.ManagedBrowser"}\n`,
            stderr: "",
          });
        if (executable === "/usr/bin/codesign" && args?.[0] === "--verify")
          return Effect.succeed({
            status: process.env.TEST_CODESIGN_FAIL ? 1 : 0,
            stdout: "",
            stderr: "",
          });
        if (executable === "/usr/bin/codesign")
          return Effect.succeed({
            status: 0,
            stdout: "",
            stderr: `TeamIdentifier=${process.env.TEST_TEAM || "MANAGEDTEAM"}\n`,
          });
        return actual.run(executable, args, options);
      },
    });
    const validateBundle = (capability: Capability) =>
      Effect.gen(function* () {
        yield* write([capability]);
        return yield* validate();
      }).pipe(Effect.provideService(CommandRunner, fakeRunner));
    const validBundle = bundle("google-chrome", app, "com.example.ManagedBrowser", "MANAGEDTEAM");
    assert.equal((yield* validateBundle(validBundle)).HOMEBREW_BUNDLE_CASK_SKIP, "google-chrome");
    assert.equal(
      (yield* validateBundle(
        bundle("google-chrome", app, "com.example.ManagedBrowser", "WRONGTEAM"),
      ).pipe(Effect.option))._tag,
      "None",
    );
    assert.equal(
      (yield* validateBundle(
        bundle("google-chrome", app, "com.example.ManagedBrowser", "not set"),
      ).pipe(Effect.option))._tag,
      "None",
    );
    process.env.TEST_BUNDLE_ID = "com.example.WrongBrowser";
    assert.equal((yield* validateBundle(validBundle).pipe(Effect.option))._tag, "None");
    delete process.env.TEST_BUNDLE_ID;
    process.env.TEST_CODESIGN_FAIL = "1";
    assert.equal((yield* validateBundle(validBundle).pipe(Effect.option))._tag, "None");
    delete process.env.TEST_CODESIGN_FAIL;
    yield* Console.log("ok external Homebrew XML plist is typed, unambiguous, and fail closed");
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);
runMain(program);
