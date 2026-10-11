#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, type CommandResult } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import { readPersistedProfile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect } from "../profiles/model.ts";

import { agentRulesCache, runWrapperResult, sharedFixtureRules } from "./agent-rules-fixture.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const modelPath = join(repoRoot, "chezmoi/.chezmoidata/profiles.json");

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-profiles." });
    const model = yield* readProfileModelEffect(modelPath);
    const profiles = Object.keys(model.profiles);
    const run = (
      command: string,
      args: readonly string[] = [],
      options: { env?: Readonly<Record<string, string>>; cwd?: string } = {},
    ): Effect.Effect<CommandResult, unknown> =>
      runner.run(command, args, { env: options.env, cwd: options.cwd });
    for (const script of ["bootstrap/darwin/configure-power.ts", "verify/bootstrap.ts"]) {
      const result = yield* run(process.execPath, [
        join(repoRoot, script),
        "workstation",
        "devbox",
      ]);
      assert.notEqual(result.status, 0, `${script} accepted duplicate profiles`);
    }
    const profileHome = join(temporary, "profile-resolution");
    const marker = join(profileHome, ".config/dotfiles/profile");
    yield* fs.makeDirectory(join(profileHome, ".config/dotfiles"), { recursive: true });
    yield* fs.writeFileString(marker, " \tpersonal-devbox\r\n", { mode: 0o600 });
    assert.equal(
      yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "workstation" }),
      "personal-devbox",
    );
    yield* fs.remove(marker);
    assert.equal(
      yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: " devbox " }),
      "devbox",
    );
    assert.equal(
      (yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "" }).pipe(
        Effect.flip,
      )).exitCode,
      1,
    );
    assert.equal(
      (yield* resolveProfile(undefined, { HOME: profileHome, DOTFILES_PROFILE: "invalid" }).pipe(
        Effect.flip,
      )).exitCode,
      2,
    );
    yield* fs.symlink(join(profileHome, "missing"), marker);
    assert.equal(
      (yield* resolveProfile(undefined, {
        HOME: profileHome,
        DOTFILES_PROFILE: "workstation",
      }).pipe(Effect.flip)).exitCode,
      3,
    );
    yield* fs.remove(marker);
    yield* fs.writeFileString(marker, "devbox\nextra\n", { mode: 0o600 });
    assert.equal((yield* readPersistedProfile(marker).pipe(Effect.option))._tag, "None");
    yield* fs.writeFileString(marker, "devbox\n", { mode: 0o666 });
    yield* fs.chmod(marker, 0o666);
    assert.equal((yield* readPersistedProfile(marker).pipe(Effect.option))._tag, "None");
    const unsafeMarker = yield* run(
      process.execPath,
      [join(repoRoot, "bootstrap/install.ts"), "--print-steps"],
      { env: { HOME: profileHome } },
    );
    assert.equal(unsafeMarker.status, 2, unsafeMarker.stderr);
    assert.match(unsafeMarker.stderr, /profile marker is missing or unsafe: .*chmod 600/);

    const agentHome = join(temporary, "agent-home");
    yield* fs.makeDirectory(join(agentHome, ".config/dotfiles"), { recursive: true });
    yield* fs.writeFileString(join(agentHome, ".config/dotfiles/profile"), "personal-devbox\n", {
      mode: 0o600,
    });
    const resolved = yield* run(
      process.execPath,
      [join(repoRoot, "agents/resolve-profile.ts"), "--expected", "personal-devbox"],
      { env: { HOME: agentHome } },
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout.trim(), "personal-devbox");
    assert.equal(
      (yield* run(
        process.execPath,
        [join(repoRoot, "agents/resolve-profile.ts"), "--expected", "devbox"],
        { env: { HOME: agentHome } },
      )).status,
      3,
    );

    const canonicalSymlinkHome = join(temporary, "canonical-symlink-home");
    const canonicalTarget = join(temporary, "canonical-symlink-target");
    yield* fs.makeDirectory(join(canonicalSymlinkHome, ".config"), { recursive: true });
    yield* fs.makeDirectory(canonicalTarget);
    yield* fs.symlink(canonicalTarget, join(canonicalSymlinkHome, ".config/dotfiles"));
    assert.notEqual(
      (yield* run(
        process.execPath,
        [join(repoRoot, "bootstrap/apply-dotfiles.ts"), "--profile", "devbox"],
        { env: { HOME: canonicalSymlinkHome } },
      )).status,
      0,
    );
    assert.deepEqual(yield* fs.readDirectory(canonicalTarget), []);

    const renderedMise = (os: string) =>
      run("chezmoi", [
        "--source",
        join(repoRoot, "chezmoi"),
        "--destination",
        temporary,
        "--override-data",
        `{"dotfilesProfile":"developer","chezmoi":{"os":"${os}","arch":"arm64"}}`,
        "cat",
        join(temporary, ".config/mise/config.toml"),
      ]);
    const darwinMise = yield* renderedMise("darwin");
    const linuxMise = yield* renderedMise("linux");
    assert.equal(darwinMise.status, 0, darwinMise.stderr);
    assert.equal(linuxMise.status, 0, linuxMise.stderr);
    assert.match(
      darwinMise.stdout,
      /^"github:anthropics\/claude-code" = \{ version = "[^"]+", matching_regex = "\^claude-darwin-/m,
    );
    assert.match(
      linuxMise.stdout,
      /^"github:anthropics\/claude-code" = \{ version = "[^"]+", matching_regex = "\^claude-linux-/m,
    );
    for (const rendered of [darwinMise.stdout, linuxMise.stdout])
      assert.equal(
        rendered.match(/^\[tools\]$/gm)?.length,
        1,
        "one [tools] table per rendered config",
      );
    // Each template part must stay plain TOML so Renovate's mise manager can
    // parse it; a Go-template directive here silently stops every pin update.
    for (const part of ["mise.toml", "darwin/mise.toml", "linux/mise.toml", "mise-tasks.toml"]) {
      const parsed = yield* run("python3", [
        "-c",
        "import sys, tomllib; tomllib.loads(open(sys.argv[1]).read())",
        join(repoRoot, "chezmoi/.chezmoitemplates", part),
      ]);
      assert.equal(parsed.status, 0, `${part} is not plain TOML: ${parsed.stderr}`);
    }
    for (const profile of profiles) {
      const destination = join(temporary, `render-${profile}`);
      yield* fs.makeDirectory(destination);
      const data = JSON.stringify({ dotfilesProfile: profile });
      const rendered = yield* run("chezmoi", [
        "--source",
        join(repoRoot, "chezmoi"),
        "--destination",
        destination,
        "--override-data",
        data,
        "cat",
        join(destination, ".config/dotfiles/profile"),
      ]);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.equal(rendered.stdout.trim(), profile);
    }
    const appliedHome = join(temporary, "devbox-applied");
    yield* fs.makeDirectory(appliedHome);
    yield* fs.makeDirectory(dirname(agentRulesCache(appliedHome)), {
      recursive: true,
      mode: 0o700,
    });
    yield* fs.writeFileString(agentRulesCache(appliedHome), sharedFixtureRules, { mode: 0o600 });
    const applied = runWrapperResult(appliedHome, "devbox");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(
      (yield* fs.readFileString(join(appliedHome, ".config/dotfiles/profile"))).trim(),
      "devbox",
    );
    for (const rejected of ["Library/Application Support/com.mitchellh.ghostty"]) {
      assert.equal(yield* fs.exists(join(appliedHome, rejected)), false);
    }
    const gitconfig = yield* fs.readFileString(join(appliedHome, ".gitconfig"));
    assert.match(gitconfig, /^\[core\]$/m);
    assert.match(gitconfig, /^\[gpg\]$/m);
    assert.match(gitconfig, /^\[include\]$/m);
    yield* Console.log("ok profile layers and applied dotfiles");
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
