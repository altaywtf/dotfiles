#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

const usage = `Usage:
  bootstrap/darwin/configure-spotlight.ts [--check]

Disables Spotlight indexing on all mounted macOS volumes.

This is a deliberate sudo step because mdutil changes system indexing policy.
It does not delete existing Spotlight index data.

Set DOTFILES_SKIP_SPOTLIGHT_CHECK=1 to skip --check when indexing is intentional.
This does not affect an explicit configuration run.`;

const checkPolicy = Effect.fn("checkSpotlightPolicy")(function* () {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("mdutil", ["-sa"]);
  yield* Effect.sync(() => {
    process.stdout.write(result.stdout);
    process.stdout.write(result.stderr);
  });
  if (result.status !== 0) {
    return yield* fail(`mdutil -sa exited ${result.status}`);
  }
  if (result.stdout.includes("Indexing enabled") || result.stderr.includes("Indexing enabled")) {
    return yield* fail("Spotlight indexing is enabled on at least one volume");
  }
  yield* Console.log("ok Spotlight indexing disabled");
});

const program = Effect.gen(function* () {
  let checkOnly = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--check") {
      checkOnly = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }
  if (process.platform !== "darwin") {
    return yield* fail("configure-spotlight is macOS-only");
  }
  if (checkOnly) {
    if (process.env.DOTFILES_SKIP_SPOTLIGHT_CHECK === "1") {
      yield* Console.log(
        "skipped Spotlight indexing policy check (DOTFILES_SKIP_SPOTLIGHT_CHECK=1)",
      );
      return;
    }
    yield* checkPolicy();
    return;
  }
  const runner = yield* CommandRunner;
  const command = process.getuid?.() === 0 ? "mdutil" : "sudo";
  const args = process.getuid?.() === 0 ? ["-a", "-i", "off"] : ["mdutil", "-a", "-i", "off"];
  if (command === "sudo") {
    yield* Console.error("configure-spotlight needs sudo to update Spotlight indexing policy");
  }
  const result = yield* runner.run(command, args, { output: "inherit" });
  if (result.status !== 0) {
    return yield* fail(`${command} exited ${result.status}`);
  }
  yield* checkPolicy();
  yield* Console.log("Spotlight indexing disabled");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
