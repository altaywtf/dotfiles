#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureDefaults } from "../agents/codex/config.ts";
import { runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const args = process.argv.slice(2);
    const profileIndex = args.indexOf("--profile");
    if (args.length > 2 || (args.length > 0 && (profileIndex !== 0 || !args[1]))) {
      return yield* Effect.fail(new Error("usage: configure-codex.ts [--profile PROFILE]"));
    }
    const profile = yield* resolveProfile(profileIndex === 0 ? args[1] : undefined);
    const model = yield* readProfileModelEffect(profileModelFile());
    const { capabilities } = requireProfile(model, profile);
    const projectRoot =
      capabilities.personal || capabilities.devbox ? join(homedir(), "projects") : undefined;
    const gateway = capabilities.personal && (capabilities.workstation || capabilities.devbox);
    const { configPath, restricted } = yield* Effect.tryPromise({
      try: () => configureDefaults(projectRoot, gateway),
      catch: (error) => error,
    });
    yield* Console.log(`configured Codex defaults in ${configPath}`);
    for (const path of restricted) yield* Console.log(`restricted Codex state: ${path}`);
  });
  runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
