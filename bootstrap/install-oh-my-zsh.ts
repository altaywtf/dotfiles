#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

// oh-my-zsh is a git checkout every shell sources, so it is pinned like any
// other dependency: Renovate moves the revision, maintenance converges to it,
// and the framework's own updater stays disabled in .zshrc.
// renovate: datasource=git-refs depName=https://github.com/ohmyzsh/ohmyzsh branch=master
const OH_MY_ZSH_REVISION = "868da9cfd537266951a79e8d9fa132f6d5f276d8";

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = process.env.HOME || "";
  if (!home && !process.env.OH_MY_ZSH_DIR) return yield* fail("HOME is required");
  const target = process.env.OH_MY_ZSH_DIR || join(home, ".oh-my-zsh");
  const remote = process.env.OH_MY_ZSH_REMOTE || "https://github.com/ohmyzsh/ohmyzsh.git";
  const revision = process.env.OH_MY_ZSH_REVISION || OH_MY_ZSH_REVISION;
  const git = (...args: string[]) =>
    runner.run("git", ["-C", target, ...args], { output: "capture" });

  if (!(yield* fs.exists(join(target, ".git")))) {
    if (yield* fs.exists(target))
      return yield* fail(`${target} exists but is not a git checkout; move it aside`);
    yield* Console.log("installing oh-my-zsh");
    const init = yield* runner.run("git", ["init", "--quiet", target], { output: "capture" });
    if (init.status !== 0)
      return yield* fail(`git init exited ${init.status}: ${init.stderr.trim()}`);
  }
  // The remote is converged too, so a checkout seeded elsewhere still follows the pin.
  const origin = yield* git("remote", "set-url", "origin", remote);
  if (origin.status !== 0) {
    const added = yield* git("remote", "add", "origin", remote);
    if (added.status !== 0)
      return yield* fail(`git remote add exited ${added.status}: ${added.stderr.trim()}`);
  }
  const current = yield* git("rev-parse", "HEAD");
  if (
    current.status === 0 &&
    current.stdout.trim() === revision &&
    (yield* fs.exists(join(target, "oh-my-zsh.sh")))
  )
    return;
  yield* Console.log(`converging oh-my-zsh to ${revision.slice(0, 12)}`);
  const fetched = yield* git("fetch", "--depth", "1", "--quiet", "origin", revision);
  if (fetched.status !== 0)
    return yield* fail(`git fetch exited ${fetched.status}: ${fetched.stderr.trim()}`);
  const checkout = yield* git("checkout", "--detach", "--quiet", "FETCH_HEAD");
  if (checkout.status !== 0)
    return yield* fail(`git checkout exited ${checkout.status}: ${checkout.stderr.trim()}`);
  if (!(yield* fs.exists(join(target, "oh-my-zsh.sh"))))
    return yield* fail(`${target} does not contain oh-my-zsh.sh after checkout`);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
