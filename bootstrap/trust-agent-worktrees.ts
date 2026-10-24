#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { dirname, join, resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const usage = `Usage:
  bootstrap/trust-agent-worktrees.ts [--check]

Trusts existing mise config files near the roots of Codex and Claude
generated worktrees. With --check, verifies that any discovered config files are already
trusted.`;

const configNames = ["mise.toml", ".mise.toml"] as const;

const discoverMiseConfigs = Effect.fn("discoverMiseConfigs")(function* (
  roots: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const configs: string[] = [];
  for (const root of roots) {
    if (!(yield* fs.exists(root))) {
      continue;
    }
    for (let depth = 1; depth <= 3; depth += 1) {
      const prefix = "*/".repeat(depth - 1);
      for (const name of configNames) {
        const matches = yield* fs.glob(`${prefix}${name}`, { root });
        configs.push(...matches.map((path) => resolve(root, path)));
      }
    }
  }
  return [...new Set(configs)].sort();
});

const program = Effect.gen(function* () {
  let mode: "check" | "trust" = "trust";
  for (const argument of process.argv.slice(2)) {
    if (argument === "--check") {
      mode = "check";
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  yield* runner
    .run("mise", ["--version"])
    .pipe(Effect.catch(() => fail("missing required command: mise")));
  const home = process.env.HOME || "";
  const roots = [
    join(process.env.CODEX_HOME || join(home, ".codex"), "worktrees"),
    join(process.env.CLAUDE_HOME || join(home, ".claude"), "worktrees"),
  ];
  const paths = yield* discoverMiseConfigs(roots);

  if (mode === "check") {
    yield* Console.log("\n## agent worktree mise trust");
  }
  let failed = false;
  for (const configPath of paths) {
    if (mode === "trust") {
      const result = yield* runner.run("mise", ["trust", "--yes", configPath], {
        output: "inherit",
      });
      if (result.status !== 0) {
        return yield* fail(`mise trust exited ${result.status}: ${configPath}`);
      }
      continue;
    }
    const configDirectory = yield* fs.realPath(dirname(configPath));
    const displayDirectory = configDirectory.startsWith(home)
      ? `~${configDirectory.slice(home.length)}`
      : configDirectory;
    const result = yield* runner.run("mise", ["trust", "--show", "-C", configDirectory]);
    const trusted =
      result.status === 0 &&
      result.stdout.split(/\r?\n/).some((line) => {
        const [path, state] = line.split(": ", 2);
        return (path === configDirectory || path === displayDirectory) && state === "trusted";
      });
    if (trusted) {
      yield* Console.log(`ok trusted ${configPath}`);
    } else {
      yield* Console.error(`FAILED: untrusted mise config: ${configPath}`);
      failed = true;
    }
  }
  if (paths.length === 0) {
    yield* Console.log(
      mode === "check"
        ? "ok no agent worktree mise configs found"
        : "no agent worktree mise configs found",
    );
  }
  if (failed) {
    return yield* fail("run bootstrap/trust-agent-worktrees.ts");
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (import.meta.main) {
  runMain(program);
}
