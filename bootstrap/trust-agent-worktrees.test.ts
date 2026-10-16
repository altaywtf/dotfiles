import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { Effect, FileSystem } from "effect";

import { discoverMiseConfigs } from "./trust-agent-worktrees.ts";

const script = resolve(import.meta.dirname, "trust-agent-worktrees.ts");

test("mise config discovery bounds filesystem traversal at depth three", async () => {
  const calls: Array<{ pattern: string; root: string | undefined }> = [];
  const fs = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(path === "/worktrees"),
    glob: (pattern, options) => {
      calls.push({ pattern, root: options?.root });
      return Effect.succeed(pattern === "*/mise.toml" ? ["project/mise.toml"] : []);
    },
  });

  const paths = await Effect.runPromise(
    discoverMiseConfigs(["/worktrees", "/missing"]).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    ),
  );

  assert.deepEqual(paths, ["/worktrees/project/mise.toml"]);
  assert.deepEqual(calls, [
    { pattern: "mise.toml", root: "/worktrees" },
    { pattern: ".mise.toml", root: "/worktrees" },
    { pattern: "*/mise.toml", root: "/worktrees" },
    { pattern: "*/.mise.toml", root: "/worktrees" },
    { pattern: "*/*/mise.toml", root: "/worktrees" },
    { pattern: "*/*/.mise.toml", root: "/worktrees" },
  ]);
});

test("trusts configs through depth three and ignores a deep dependency tree", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agent-worktree-trust-"));
  const codexHome = join(root, "codex");
  const claudeHome = join(root, "claude");
  const worktrees = join(codexHome, "worktrees");
  const bin = join(root, "bin");
  const log = join(root, "mise.log");
  const expected = [
    join(worktrees, "mise.toml"),
    join(worktrees, "project", ".mise.toml"),
    join(worktrees, "project", "checkout", "mise.toml"),
  ].sort();
  const excluded = join(
    worktrees,
    "project",
    "checkout",
    "node_modules",
    "dependency",
    "mise.toml",
  );

  try {
    mkdirSync(join(worktrees, "project", "checkout", "node_modules", "dependency"), {
      recursive: true,
    });
    mkdirSync(bin);
    for (const path of [...expected, excluded]) writeFileSync(path, "[tools]\n");
    const mise = join(bin, "mise");
    writeFileSync(
      mise,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 0
fi
if [ "$1" = "trust" ] && [ "$2" = "--yes" ]; then
  printf '%s\\n' "$3" >> "$MISE_LOG"
  exit 0
fi
exit 1
`,
    );
    chmodSync(mise, 0o755);

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH || ""}`,
        HOME: root,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        MISE_LOG: log,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").sort(), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
