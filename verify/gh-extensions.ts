#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain, isCliFailure } from "../lib/program.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const installer = join(repoRoot, "bootstrap/install-gh-extensions.ts");
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
printf 'arg=%s\\n' "$@" >>"$FAKE_GH_LOG"
case "\${1:-} \${2:-}" in
  "--version "|"extension install"|"stack --help") ;;
  *) exit 64 ;;
esac
`;

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-gh-extensions." });
    const bin = join(temporary, "bin");
    const empty = join(temporary, "empty");
    const log = join(temporary, "gh.log");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.makeDirectory(empty, { recursive: true });
    yield* fs.writeFileString(join(bin, "gh"), fakeGh);
    yield* fs.chmod(join(bin, "gh"), 0o755);
    yield* fs.writeFileString(log, "");
    const installed = yield* runner.run(process.execPath, [installer], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_LOG: log },
      extendEnv: true,
    });
    if (installed.status !== 0) {
      return yield* fail(installed.stderr || "GitHub extension installer failed");
    }
    const expected = [
      "arg=--version",
      "arg=extension",
      "arg=install",
      "arg=github/gh-stack",
      "arg=--force",
      "arg=stack",
      "arg=--help",
      "",
    ].join("\n");
    if ((yield* fs.readFileString(log)) !== expected) {
      return yield* fail("installer did not install and verify github/gh-stack");
    }
    const missing = yield* runner.run(process.execPath, [installer], {
      env: { PATH: empty },
      extendEnv: true,
    });
    if (missing.status !== 1) {
      return yield* fail(`missing gh returned ${missing.status} instead of 1`);
    }
    if (!missing.stderr.includes("gh is required; run ./dotfiles apply so mise installs gh")) {
      return yield* fail("missing gh failure was not actionable");
    }
    yield* Console.log("ok GitHub CLI extension installer is idempotent and validates gh-stack");
  }).pipe(
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
    Effect.mapError((error) =>
      isCliFailure(error) ? error : new CliFailure({ exitCode: 1, message: String(error) }),
    ),
  ),
);

runMain(program);
