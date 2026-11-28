#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const extension = "github/gh-stack";

const program = Effect.gen(function* () {
  const runner = yield* CommandRunner;

  const probe = yield* runner
    .run("gh", ["--version"])
    .pipe(
      Effect.catch(() => fail("gh is required; run ./dotfiles apply so mise installs gh first")),
    );

  if (probe.status !== 0) {
    return yield* fail("gh is required; run ./dotfiles apply so mise installs gh first");
  }

  yield* Console.log(`installing GitHub CLI extension ${extension}`);

  const install = yield* runner.run("gh", ["extension", "install", extension, "--force"], {
    output: "inherit",
  });

  if (install.status !== 0) {
    return yield* fail(`gh extension install exited ${install.status}`);
  }

  const verify = yield* runner.run("gh", ["stack", "--help"], { output: "ignore" });

  if (verify.status !== 0) {
    return yield* fail(`gh stack --help exited ${verify.status}`);
  }

  yield* Console.log("ok gh-stack is installed");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
