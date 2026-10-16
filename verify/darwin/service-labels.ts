#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { launchdLabel, resolveLaunchdNamespaceContract } from "../../lib/darwin/launchd.ts";
import { CliFailure, fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const installer = join(repoRoot, "bootstrap/darwin/install-devbox-service-daemons.ts");

const program = Effect.scoped(
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const runInstaller = (args: readonly string[]) =>
      runner.run(process.execPath, [installer, ...args]);
    const expected = "local.dotfiles.colima.example";
    const generic = yield* runInstaller(["--user", "example", "--print-labels"]);
    assert.equal(generic.status, 0);
    assert.equal(generic.stdout.trim(), expected);
    for (const namespace of ["org.example.dotfiles", "org.example_team.dotfiles"]) {
      const custom = yield* runInstaller([
        "--user",
        "example",
        "--namespace",
        namespace,
        "--print-labels",
      ]);
      assert.equal(custom.status, 0);
      assert.equal(custom.stdout.trim(), `${namespace}.colima.example`);
    }
    assert.throws(() => launchdLabel("colima", ""));
    assert.throws(() => launchdLabel("", "example"));

    const invalid = yield* runInstaller([
      "--user",
      "example",
      "--namespace",
      "invalid namespace",
      "--print-labels",
    ]);
    assert.notEqual(invalid.status, 0);
    for (const args of [
      ["--user", "example", "--colima", "--openclaw-port", "18790"],
      ["--user", "example", "--colima", "--openclaw-wrapper", "/tmp/wrapper"],
      ["--user", "example", "--openclaw"],
      ["--user", "example", "--allow-openclaw-restart"],
    ]) {
      const rejected = yield* runInstaller(args);
      assert.equal(rejected.status, 2);
      assert.match(`${rejected.stdout}\n${rejected.stderr}`, /unknown argument:/);
    }

    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-service-labels." });
    const namespaceFile = join(temporary, "launchd-namespace");
    yield* fs.writeFileString(namespaceFile, "org.example.dotfiles\n", { mode: 0o600 });
    assert.equal(yield* resolveLaunchdNamespaceContract("", namespaceFile), "org.example.dotfiles");
    assert.equal(
      yield* resolveLaunchdNamespaceContract("org.example.dotfiles", namespaceFile),
      "org.example.dotfiles",
    );
    const conflicting = yield* resolveLaunchdNamespaceContract(
      "local.dotfiles",
      namespaceFile,
    ).pipe(Effect.flip);
    assert.ok(conflicting instanceof CliFailure);
    assert.equal(conflicting.exitCode, 3);
    yield* fs.chmod(namespaceFile, 0o644);
    assert.equal(
      (yield* resolveLaunchdNamespaceContract("", namespaceFile).pipe(Effect.option))._tag,
      "None",
    );
    yield* fs.chmod(namespaceFile, 0o600);
    yield* fs.writeFileString(namespaceFile, "org.example.dotfiles\nsecond.record\n");
    assert.equal(
      (yield* resolveLaunchdNamespaceContract("", namespaceFile).pipe(Effect.option))._tag,
      "None",
    );
    yield* fs.remove(namespaceFile);
    yield* fs.symlink(join(temporary, "missing"), namespaceFile);
    assert.equal(
      (yield* resolveLaunchdNamespaceContract("local.dotfiles", namespaceFile).pipe(Effect.option))
        ._tag,
      "None",
    );
    yield* Console.log("ok LaunchDaemon labels are vendor-neutral and configurable");
  }).pipe(
    Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
