#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "vite-plus/test";

import { auditCommand, runAudit } from "../audit/run.ts";
import { Schema } from "effect";

const repoRoot = resolve(import.meta.dirname, "..");
const TaskListing = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      depends: Schema.Array(Schema.String),
      source: Schema.String,
    }),
  ),
);
const CurrentTools = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ requested_version: Schema.optionalKey(Schema.String) })),
  ),
);
const PackageManifest = Schema.fromJsonString(Schema.Struct({ packageManager: Schema.String }));
function globalMiseConfigPath(env: NodeJS.ProcessEnv): string {
  return (
    env.MISE_GLOBAL_CONFIG_FILE ||
    resolve(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise/config.toml")
  );
}

function globalMiseConfigDirectory(env: NodeJS.ProcessEnv): string {
  return env.MISE_CONFIG_DIR || resolve(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise");
}

const globalMiseConfig = globalMiseConfigPath(process.env);
const globalMiseConfigDir = globalMiseConfigDirectory(process.env);
const miseEnv = {
  ...process.env,
  MISE_IGNORED_CONFIG_PATHS: [
    process.env.MISE_IGNORED_CONFIG_PATHS,
    globalMiseConfig,
    globalMiseConfigDir,
  ]
    .filter(Boolean)
    .join(delimiter),
  MISE_TRUSTED_CONFIG_PATHS: [process.env.MISE_TRUSTED_CONFIG_PATHS, repoRoot]
    .filter(Boolean)
    .join(delimiter),
  MISE_TASK_RUN_AUTO_INSTALL: "false",
};
function run(command: string, args: Array<string>, env: NodeJS.ProcessEnv = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "dotfiles-mise-config-"));
  try {
    return spawnSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...miseEnv, MISE_CONFIG_DIR: configDir, ...env },
    });
  } finally {
    rmSync(configDir, { force: true, recursive: true });
  }
}

test("mise exposes one validated task graph", () => {
  const validation = run("mise", ["tasks", "validate", "--errors-only"]);
  assert.equal(validation.status, 0, validation.stderr);

  const listing = run("mise", ["tasks", "--hidden", "--json"]);
  assert.equal(listing.status, 0, listing.stderr);
  const tasks = Schema.decodeUnknownSync(TaskListing)(listing.stdout);
  assert.ok(tasks.every((task) => task.source === resolve(repoRoot, "mise.toml")));
  assert.ok(tasks.find((task) => task.name === "verify")?.depends.includes("verify:history"));
});

test("tasks resolve the repository Node and pnpm pins without a global config", () => {
  const listing = run("mise", ["ls", "--current", "--json"]);
  assert.equal(listing.status, 0, listing.stderr);
  const current = Schema.decodeUnknownSync(CurrentTools)(listing.stdout);
  const packageManager = Schema.decodeUnknownSync(PackageManifest)(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ).packageManager;
  assert.equal(
    current.node?.[0]?.requested_version,
    readFileSync(resolve(repoRoot, ".node-version"), "utf8").trim(),
  );
  assert.equal(`pnpm@${current.pnpm?.[0]?.requested_version}`, packageManager);
});

test("task arguments fail before live commands run", () => {
  assert.notEqual(run("mise", ["run", "audit", "unknown"]).status, 0);
  assert.notEqual(run("mise", ["run", "verify:bootstrap", "unknown"]).status, 0);
});

test("focused verification preserves the delegated failure code", () => {
  const bin = mkdtempSync(join(tmpdir(), "dotfiles-mise-bin-"));
  try {
    const node = join(bin, "node");
    writeFileSync(node, '#!/bin/sh\n[ "${1:-}" = --version ] && exit 0\nexit 23\n');
    chmodSync(node, 0o755);
    const result = run("mise", ["run", "verify:domain", "static"], {
      MISE_DISABLE_TOOLS: "node,pnpm",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    assert.equal(result.status, 23, result.stderr);
  } finally {
    rmSync(bin, { force: true, recursive: true });
  }
});

test("audit routing is explicit and preserves failures", () => {
  assert.equal(auditCommand("repo", "json")[0], process.execPath);
  assert.match(auditCommand("repo", "json")[1][0], /audit\/repo\.ts$/);
  assert.deepEqual(auditCommand("repo", "json")[1].slice(1), ["--skip-mscp", "--json"]);
  assert.deepEqual(auditCommand("mscp", "text")[1].slice(1), []);
  assert.match(auditCommand("host", "text")[1][0], /audit\/host\.ts$/);
  assert.equal(auditCommand("workstation", "text")[0], process.execPath);
  assert.match(auditCommand("workstation", "text")[1][0], /audit\/workstation\.ts$/);
  assert.equal(auditCommand("devbox", "text")[0], process.execPath);
  assert.match(auditCommand("devbox", "json")[1][0], /audit\/devbox\.ts$/);
  assert.equal(
    runAudit("host", "text", () => ({ status: 29 })),
    29,
  );
});
