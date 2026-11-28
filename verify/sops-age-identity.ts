#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(repoRoot, "identity/configure-sops-age-identity.ts");

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-sops-age-test." });
    const bin = join(temporary, "bin");
    const home = join(temporary, "home");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(
      join(bin, "age-keygen"),
      `#!/bin/sh
case "\${1:-}" in
  -o) [ "$#" -eq 2 ] || exit 2; if [ "\${AGE_KEYGEN_FAIL:-0}" = 1 ]; then : > "$2"; exit 1; fi; printf '%s%s\\n' AGE-SECRET- KEY-1FIXTURE > "$2"
      if [ -n "\${AGE_CONCURRENT_IDENTITY:-}" ]; then
        if [ -n "\${AGE_CONCURRENT_SYMLINK:-}" ]; then
          ln -s "$AGE_CONCURRENT_SYMLINK" "$AGE_CONCURRENT_IDENTITY"
        else
          printf 'concurrent-fixture-key\\n' > "$AGE_CONCURRENT_IDENTITY"
          chmod 600 "$AGE_CONCURRENT_IDENTITY"
        fi
      fi ;;
  -y) [ "$#" -eq 2 ] && [ -s "$2" ] || exit 2; printf 'age1fixtureidentity\\n' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    yield* fs.writeFileString(
      join(bin, "sops"),
      `#!/bin/sh
if [ "\${1:-}" = --version ]; then printf 'sops %s\\n' "\${SOPS_FIXTURE_VERSION:-3.13.3}"; exit 0; fi
case "\${1:-}" in
  encrypt) case "$*" in *'--age age1fixtureidentity'*) ;; *) exit 3 ;; esac ;;
  decrypt) [ -n "\${SOPS_AGE_KEY_FILE:-}" ] && [ -f "$SOPS_AGE_KEY_FILE" ] || exit 3 ;;
  *) exit 3 ;;
esac
for arg in "$@"; do [ ! -f "$arg" ] || input="$arg"; done
[ -n "\${input:-}" ] || exit 2
cat "$input"
`,
      { mode: 0o700 },
    );
    const path = `${bin}:${process.env.PATH || "/usr/bin:/bin"}`;
    const base = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: path };

    const execute = (
      args: ReadonlyArray<string> = [],
      extra: Readonly<Record<string, string>> = {},
    ) => runner.run(process.execPath, [script, ...args], { env: { ...base, ...extra } });

    const provision = yield* execute();
    assert.equal(provision.status, 0, provision.stderr);
    const identity = join(home, ".config/sops/age/keys.txt");
    const directoryInfo = yield* fs.stat(dirname(identity));
    const identityInfo = yield* fs.stat(identity);
    assert.equal(directoryInfo.mode & 0o777, 0o700);
    assert.equal(identityInfo.mode & 0o777, 0o600);
    assert.match(
      provision.stdout,
      new RegExp(
        `^SOPS age identity ready: ${identity.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`,
        "m",
      ),
    );
    assert.match(provision.stdout, /^public recipient: age1fixtureidentity$/m);
    assert.match(
      provision.stdout,
      /^backup required: save the private identity in the approved human recovery system before use$/m,
    );
    const before = digest(yield* fs.readFile(identity));
    assert.equal((yield* execute()).status, 0);
    assert.equal(digest(yield* fs.readFile(identity)), before);
    const check = yield* execute(["--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /^ok owner, permissions, recipient, and SOPS round trip$/m);
    const recipient = yield* execute(["--print-recipient"]);
    assert.equal(recipient.status, 0);
    assert.equal(recipient.stdout.trim(), "age1fixtureidentity");

    const explicit = join(temporary, "explicit/identity.txt");
    assert.equal((yield* execute([], { SOPS_AGE_KEY_FILE: explicit })).status, 0);
    assert.equal(yield* fs.exists(explicit), true);
    const concurrent = join(temporary, "concurrent/keys.txt");

    const concurrentResult = yield* execute([], {
      SOPS_AGE_KEY_FILE: concurrent,
      AGE_CONCURRENT_IDENTITY: concurrent,
    });

    assert.equal(concurrentResult.status, 0, concurrentResult.stderr);
    assert.equal(yield* fs.readFileString(concurrent), "concurrent-fixture-key\n");
    const racedLink = join(temporary, "raced-link/keys.txt");
    const linkTarget = join(temporary, "untouched.txt");
    yield* fs.writeFileString(linkTarget, "untouched", { mode: 0o644 });

    const racedResult = yield* execute([], {
      SOPS_AGE_KEY_FILE: racedLink,
      AGE_CONCURRENT_IDENTITY: racedLink,
      AGE_CONCURRENT_SYMLINK: linkTarget,
    });

    assert.notEqual(racedResult.status, 0);
    assert.equal(yield* fs.readLink(racedLink), linkTarget);
    assert.equal(yield* fs.readFileString(linkTarget), "untouched");
    assert.equal((yield* fs.stat(linkTarget)).mode & 0o777, 0o644);
    const failed = join(temporary, "failed/identity.txt");
    assert.notEqual(
      (yield* execute([], { SOPS_AGE_KEY_FILE: failed, AGE_KEYGEN_FAIL: "1" })).status,
      0,
    );
    assert.equal(yield* fs.exists(failed), false);
    assert.notEqual((yield* execute(["--check"], { SOPS_FIXTURE_VERSION: "3.8.1" })).status, 0);
    yield* fs.chmod(identity, 0o644);
    assert.notEqual((yield* execute(["--check"])).status, 0);
    yield* fs.chmod(identity, 0o600);

    const missing = join(temporary, "missing");
    yield* fs.makeDirectory(missing);

    const missingResult = yield* runner.run(process.execPath, [script, "--check"], {
      env: { HOME: missing, XDG_CONFIG_HOME: join(missing, ".config"), PATH: path },
    });

    assert.notEqual(missingResult.status, 0);
    assert.equal(yield* fs.exists(join(missing, ".config/sops/age/keys.txt")), false);

    const symlinkHome = join(temporary, "symlink");
    const symlinkTarget = join(temporary, "symlink-target");
    yield* fs.makeDirectory(join(symlinkHome, ".config/sops"), { recursive: true });
    yield* fs.makeDirectory(symlinkTarget);
    yield* fs.symlink(symlinkTarget, join(symlinkHome, ".config/sops/age"));

    const symlinkResult = yield* runner.run(process.execPath, [script], {
      env: { HOME: symlinkHome, XDG_CONFIG_HOME: join(symlinkHome, ".config"), PATH: path },
    });

    assert.notEqual(symlinkResult.status, 0);
    assert.notEqual((yield* execute(["--check", "--print-recipient"])).status, 0);
    yield* Console.log(
      "ok SOPS age identity provisioning, recovery output, path overrides, and rejection cases",
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: 1,
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
