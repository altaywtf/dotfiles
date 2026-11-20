#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Option } from "effect";
import { isAbsolute, join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain, isCliFailure } from "../lib/program.ts";

const sourceRoot = resolve(import.meta.dirname, "..");
const repoRoot = process.env.DOTFILES_PRE_PUSH_REPO_ROOT || sourceRoot;
const hookContents = `#!/usr/bin/env bash
set -euo pipefail

# dotfiles: pre-push
repo_root="$(git rev-parse --show-toplevel)"
node_binary="$(command -v node 2>/dev/null || true)"
if [ -z "$node_binary" ] || [ ! -x "$node_binary" ] \\
  || ! "$node_binary" --version >/dev/null 2>&1; then
  printf 'FAILED: missing node; run mise install in %s before pushing\\n' "$repo_root" >&2
  exit 1
fi
if ! (cd "$repo_root" && "$node_binary" -e 'import("effect")') >/dev/null 2>&1; then
  printf 'FAILED: missing repository dependencies; run pnpm install --frozen-lockfile in %s before pushing\\n' "$repo_root" >&2
  exit 1
fi
exec "$node_binary" "$repo_root/verify/pre-push.ts" "$@"
`;

const program = Effect.gen(function* () {
  const runner = yield* CommandRunner;
  const commonDirResult = yield* runner.run("git", [
    "-C",
    repoRoot,
    "rev-parse",
    "--git-common-dir",
  ]);
  if (commonDirResult.status !== 0 || !commonDirResult.stdout.trim())
    return yield* fail(`not a Git checkout: ${repoRoot}`);
  const commonDir = commonDirResult.stdout.trim();
  const hooksDir = join(isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir), "hooks");
  const prePush = join(hooksDir, "pre-push");
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(hooksDir, { recursive: true });
  const link = yield* fs.readLink(prePush).pipe(Effect.option);
  const exists = yield* fs.exists(prePush);
  if (exists || Option.isSome(link)) {
    const contents = yield* fs.readFileString(prePush).pipe(Effect.option);
    if (Option.isNone(contents) || !contents.value.split("\n").includes("# dotfiles: pre-push")) {
      const now = yield* DateTime.now;
      const timestamp = DateTime.formatIso(now).replaceAll(/\D/g, "").slice(0, 14);
      const backup = `${prePush}.backup.${timestamp}`;
      yield* fs.rename(prePush, backup);
      yield* Console.log(`backed up existing pre-push hook to ${backup}`);
    }
  }
  yield* fs.writeFileString(prePush, hookContents);
  yield* fs.chmod(prePush, 0o755);
  yield* Console.log(`installed ${prePush}`);
}).pipe(
  Effect.provide(CommandRunner.layer),
  Effect.provide(NodeServices.layer),
  Effect.mapError((error) =>
    isCliFailure(error) ? error : new CliFailure({ exitCode: 1, message: String(error) }),
  ),
);

runMain(program);
