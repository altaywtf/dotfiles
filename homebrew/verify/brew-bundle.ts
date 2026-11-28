#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-brew-bundle." });
    const bin = join(temporary, "bin");
    const prefix = join(temporary, "prefix");
    const external = join(temporary, "external-homebrew.plist");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(prefix);
    yield* fs.writeFileString(
      external,
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>version</key><integer>1</integer><key>capabilities</key><array/></dict></plist>\n',
      { mode: 0o600 },
    );
    yield* fs.writeFileString(
      join(bin, "brew"),
      `#!/bin/sh
if [ "\${1:-}" = --prefix ]; then printf '%s\\n' "$FAKE_BREW_PREFIX"; exit 0; fi
{ printf 'umask=%s\\n' "$(umask)"; printf 'no_auto_update=%s\\n' "\${HOMEBREW_NO_AUTO_UPDATE:-}"; [ -z "\${HOMEBREW_BUNDLE_DOTFILES_PROFILE:-}" ] || printf 'profile=%s\\n' "$HOMEBREW_BUNDLE_DOTFILES_PROFILE"; printf 'arg=%s\\n' "$@"; } >> "$FAKE_BREW_LOG"
if [ -n "\${FAKE_BREW_OUTPUT_DIR:-}" ]; then mkdir "$FAKE_BREW_OUTPUT_DIR/directory"; : > "$FAKE_BREW_OUTPUT_DIR/file"; : > "$FAKE_BREW_OUTPUT_DIR/executable"; chmod a+x "$FAKE_BREW_OUTPUT_DIR/executable"; fi
if [ "\${1:-}" = bundle ] && [ "\${2:-}" = cleanup ]; then while [ "$#" -gt 0 ]; do if [ "$1" = --file ]; then sed -n -E 's/^((brew|cask|tap) ".*")$/cleanup_entry=\\1/p' "$2" >> "$FAKE_BREW_LOG"; break; fi; shift; done; fi
if [ "\${1:-}" = bundle ] && [ "\${2:-}" = check ]; then exit "\${FAKE_BREW_CHECK_EXIT:-0}"; fi
exit "\${FAKE_BREW_EXIT:-0}"
`,
      { mode: 0o755 },
    );
    const path = `${bin}:${process.env.PATH || "/usr/bin:/bin"}`;
    const missingLocal = join(temporary, "missing/Brewfile.local");

    const execute = (
      script: string,
      args: ReadonlyArray<string>,
      log: string,
      extra: Readonly<Record<string, string>> = {},
      home = process.env.HOME || temporary,
    ) =>
      runner.run(process.execPath, [join(repoRoot, script), ...args], {
        env: {
          HOME: home,
          PATH: path,
          FAKE_BREW_LOG: log,
          FAKE_BREW_PREFIX: prefix,
          DOTFILES_EXTERNAL_HOMEBREW_FILE: external,
          DOTFILES_BREWFILE_LOCAL: missingLocal,
          ...extra,
        },
      });

    const directLog = join(temporary, "direct.log");
    const privateFile = join(prefix, "private-file");
    yield* fs.writeFileString(privateFile, "fixture", { mode: 0o600 });

    const bundle = Effect.fn("runBrewBundleFixture")(function* (
      profile: string,
      args: ReadonlyArray<string> = [],
    ) {
      const bundleLog = join(temporary, `${profile}-${args.join("-") || "bundle"}.log`);
      yield* fs.writeFileString(bundleLog, "");
      const result = yield* execute("homebrew/brew-bundle.ts", [...args, profile], bundleLog);
      assert.equal(result.status, 0, result.stderr);

      return yield* fs.readFileString(bundleLog);
    });

    const devbox = yield* bundle("devbox");
    assert.equal(devbox.includes("arg=uinaf/tap\n"), false);
    assert.equal((yield* bundle("workstation")).includes("arg=uinaf/tap\n"), false);
    assert.equal((devbox.match(/^arg=bundle$/gm) || []).length, 2);
    assert.equal((devbox.match(/^profile=devbox$/gm) || []).length, 2);

    for (const file of ["homebrew/Brewfile", "homebrew/Brewfile.devbox"]) {
      assert.ok(devbox.includes(`arg=${join(repoRoot, file)}`));
    }

    const personal = yield* bundle("personal-devbox");
    assert.equal((yield* fs.stat(privateFile)).mode & 0o777, 0o600);
    assert.ok(personal.includes("arg=uinaf/tap\n"));
    assert.ok((yield* bundle("personal-workstation")).includes("arg=uinaf/tap\n"));
    assert.equal((personal.match(/^arg=bundle$/gm) || []).length, 3);

    for (const file of [
      "homebrew/Brewfile",
      "homebrew/Brewfile.devbox",
      "homebrew/Brewfile.personal",
    ]) {
      assert.ok(personal.includes(`arg=${join(repoRoot, file)}`));
    }

    const shared = yield* bundle("devbox", ["--shared-only"]);
    assert.equal((shared.match(/^arg=bundle$/gm) || []).length, 1);
    const maintenance = yield* bundle("personal-devbox", ["--maintenance"]);
    assert.equal((maintenance.match(/^arg=--no-upgrade$/gm) || []).length, 3);
    assert.doesNotMatch(maintenance, /^arg=(cleanup|trust)$/m);
    assert.equal((maintenance.match(/^arg=check$/gm) || []).length, 3);
    const missingLog = join(temporary, "missing-packages.log");

    const missing = yield* execute(
      "homebrew/brew-bundle.ts",
      ["--maintenance", "devbox"],
      missingLog,
      { FAKE_BREW_CHECK_EXIT: "1" },
    );

    assert.equal(missing.status, 0, missing.stderr);
    const missingCommands = yield* fs.readFileString(missingLog);
    assert.equal((missingCommands.match(/^arg=--no-upgrade$/gm) || []).length, 4);
    assert.equal((missingCommands.match(/^arg=check$/gm) || []).length, 2);

    const failedInstall = yield* execute(
      "homebrew/brew-bundle.ts",
      ["--maintenance", "personal-devbox"],
      join(temporary, "failed-install.log"),
      { FAKE_BREW_CHECK_EXIT: "1", FAKE_BREW_EXIT: "19" },
    );

    assert.notEqual(failedInstall.status, 0);
    assert.match(failedInstall.stderr, /exited 19/);
    const cleanup = yield* bundle("devbox", ["--cleanup"]);
    assert.match(cleanup, /^arg=cleanup$/m);
    assert.match(cleanup, /^arg=--force$/m);
    assert.doesNotMatch(cleanup, /^cleanup_entry=brew "asc"$/m);
    assert.equal((yield* fs.glob("Brewfile.composed.*", { root: repoRoot })).length, 0);
    assert.equal(
      (yield* execute(
        "homebrew/brew-bundle.ts",
        ["--cleanup", "--shared-only", "devbox"],
        directLog,
      )).status,
      2,
    );
    assert.equal(
      (yield* execute("homebrew/brew-bundle.ts", ["--shared-only"], directLog)).status,
      2,
    );

    const local = join(temporary, "Brewfile.local");
    yield* fs.writeFileString(local, 'brew "local-tool"\ncask "local-app"', { mode: 0o600 });

    const withLocal = Effect.fn("runLocalBrewfileFixture")(function* (
      profile: string,
      args: ReadonlyArray<string> = [],
      extra: Readonly<Record<string, string>> = {},
    ) {
      const localLog = join(temporary, `local-${profile}-${args.join("-") || "bundle"}.log`);
      yield* fs.writeFileString(localLog, "");

      const result = yield* execute("homebrew/brew-bundle.ts", [...args, profile], localLog, {
        DOTFILES_BREWFILE_LOCAL: local,
        ...extra,
      });

      return { result, log: yield* fs.readFileString(localLog) };
    });

    const printed = yield* withLocal("devbox", ["--print-files"]);
    assert.equal(printed.result.status, 0, printed.result.stderr);
    assert.deepEqual(printed.result.stdout.trim().split("\n"), [
      join(repoRoot, "homebrew/Brewfile"),
      join(repoRoot, "homebrew/Brewfile.devbox"),
      local,
    ]);
    const localInstall = yield* withLocal("devbox");
    assert.equal(localInstall.result.status, 0, localInstall.result.stderr);
    assert.equal((localInstall.log.match(/^arg=bundle$/gm) || []).length, 3);
    assert.ok(
      localInstall.log.indexOf(`arg=${local}\n`) >
        localInstall.log.indexOf(`arg=${join(repoRoot, "homebrew/Brewfile.devbox")}\n`),
    );
    const localShared = yield* withLocal("devbox", ["--shared-only"]);
    assert.equal(localShared.result.status, 0, localShared.result.stderr);
    assert.equal((localShared.log.match(/^arg=bundle$/gm) || []).length, 1);
    assert.equal(localShared.log.includes(local), false);
    const localMaintenance = yield* withLocal("devbox", ["--maintenance"]);
    assert.equal(localMaintenance.result.status, 0, localMaintenance.result.stderr);
    assert.equal((localMaintenance.log.match(/^arg=check$/gm) || []).length, 3);
    assert.ok(localMaintenance.log.includes(`arg=${local}`));
    const localCleanup = yield* withLocal("devbox", ["--cleanup"]);
    assert.equal(localCleanup.result.status, 0, localCleanup.result.stderr);
    assert.doesNotMatch(localCleanup.log, /^cleanup_entry=brew "asc"$/m);
    assert.match(localCleanup.log, /^cleanup_entry=brew "local-tool"$/m);
    assert.match(localCleanup.log, /^cleanup_entry=cask "local-app"$/m);
    assert.equal((yield* fs.glob("Brewfile.composed.*", { root: repoRoot })).length, 0);
    yield* fs.chmod(local, 0o644);
    const worldReadable = yield* withLocal("devbox");
    assert.equal(worldReadable.result.status, 0, worldReadable.result.stderr);
    yield* fs.chmod(local, 0o666);
    const writableLocal = yield* withLocal("devbox");
    assert.equal(writableLocal.result.status, 1);
    assert.match(
      writableLocal.result.stderr,
      /unsafe local Brewfile: .* must not be group or world writable/,
    );
    assert.equal(writableLocal.log.includes("arg=bundle"), false);
    yield* fs.chmod(local, 0o600);
    const localLink = join(temporary, "Brewfile.local.link");
    yield* fs.symlink(local, localLink);
    const linked = yield* withLocal("devbox", [], { DOTFILES_BREWFILE_LOCAL: localLink });
    assert.equal(linked.result.status, 1);
    assert.match(linked.result.stderr, /invalid local Brewfile: .* must be a regular file/);
    const directory = yield* withLocal("devbox", [], { DOTFILES_BREWFILE_LOCAL: temporary });
    assert.equal(directory.result.status, 1);
    assert.match(directory.result.stderr, /invalid local Brewfile: .* must be a regular file/);
    yield* Console.log(
      "ok Homebrew bundles preserve profile boundaries, local declarations, and maintenance failures",
    );
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
