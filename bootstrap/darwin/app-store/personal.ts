#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";
import { CommandRunner } from "../../../lib/command.ts";
import { fail, runMain } from "../../../lib/program.ts";

const AppId = Schema.String.check(Schema.isPattern(/^\d+$/));
const uninstallAppIds = ["682658836", "408981434"] as const;

const usage = `Usage:
  bootstrap/darwin/app-store/personal.ts [--dry-run] [-h|--help]

Removes bundled Mac App Store apps unused by the personal workstation profile.

This script intentionally lives outside Brewfile because mas discovers installed
apps through Spotlight and removal may require a local administrator password.`;

const parseInstalledIds = Effect.fn("parseInstalledIds")(function* (output: string) {
  const candidates = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/, 1)[0]);

  const ids = yield* Schema.decodeUnknownEffect(Schema.Array(AppId))(candidates).pipe(
    Effect.mapError((error) => new Error(`mas list returned invalid output: ${error.message}`)),
  );

  return new Set(ids);
});

const program = Effect.gen(function* () {
  let dryRun = false;

  for (const argument of process.argv.slice(2)) {
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);

      return;
    } else {
      yield* Console.error(usage);

      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const runner = yield* CommandRunner;

  const listing = yield* runner
    .run("mas", ["list"])
    .pipe(Effect.catch(() => fail("mas is required; install the personal Brewfile first")));

  if (listing.status !== 0) {
    return yield* fail(`mas list exited ${listing.status}`);
  }

  const installed = yield* parseInstalledIds(listing.stdout);

  for (const appId of uninstallAppIds) {
    if (!installed.has(appId)) {
      yield* Console.log(`ok App Store app already absent: ${appId}`);
      continue;
    }

    yield* Console.log(`uninstalling App Store app: ${appId}`);

    if (dryRun) {
      yield* Console.log(`dry-run sudo mas uninstall ${appId}`);
      continue;
    }

    const result = yield* runner.run("sudo", ["mas", "uninstall", appId], { output: "inherit" });

    if (result.status !== 0) {
      return yield* fail(`sudo mas uninstall ${appId} exited ${result.status}`);
    }
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
