#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function containsAny(content: string, values: readonly string[]): boolean {
  return values.some((value) => content.includes(value));
}

function allowed(file: string, content: string): boolean {
  switch (file) {
    case "chezmoi/.chezmoitemplates/linux/mise.toml":
      return content.startsWith('"github:uinaf/ffss" =');
    case "chezmoi/private_dot_config/mise/config.toml.tmpl":
      return content.trim() === '"github:uinaf/ffss",';
    case "homebrew/Brewfile.personal":
    case "homebrew/Brewfile.personal-workstation":
      return content.includes("uinaf/tap");
    case "LICENSE":
      return content.includes("Copyright (c) 2026 uinaf");
    case "renovate.json":
      return containsAny(content, [
        "github>uinaf/renovate-config",
        '"uinaf/ffss"',
        '"github:uinaf/ffss"',
      ]);
    case ".github/workflows/verify.yml":
      return containsAny(content, [
        "mise exec github:uinaf/ffss -- slopguard version",
        "uses: uinaf/.github/.github/actions/scan@",
        "client-id: ${{ vars.UINAF_CI_APP_CLIENT_ID }}",
        "private-key: ${{ secrets.UINAF_CI_APP_PRIVATE_KEY }}",
      ]);
    case "docs/identities.md":
      return content.includes("github.com/uinaf/sops-vault-template");
    case "agents/plugins/developer.json":
      return content.includes("uinaf/ffss");
    case "agents/rules.json":
      return content.includes("githubusercontent.com/uinaf/ffss");
    case "agents/mcps/personal.json":
      return content.includes("uinaf-executor");
    case "verify/profiles.ts":
    case "homebrew/verify/brew-bundle.ts":
    case "homebrew/verify/external-homebrew.ts":
    case "chezmoi/.chezmoidata/profiles.json":
      return content.includes("uinaf/tap");
    default:
      return false;
  }
}

const program = Effect.gen(function* () {
  const runner = yield* CommandRunner;
  const contentScan = yield* runner.run("git", [
    "-C",
    repoRoot,
    "grep",
    "--untracked",
    "-n",
    "-i",
    "uinaf",
    "--",
    ":!verify/vendor-neutral.ts",
  ]);
  if (contentScan.status !== 0 && contentScan.status !== 1) {
    return yield* fail(
      `vendor-neutral scan failed with git grep status ${contentScan.status}`,
      contentScan.status,
    );
  }
  const pathScan = yield* runner.run("git", [
    "-C",
    repoRoot,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (pathScan.status !== 0) {
    return yield* fail(
      `vendor-neutral path scan failed with status ${pathScan.status}`,
      pathScan.status,
    );
  }

  let unexpected = false;
  for (const path of pathScan.stdout.split(/\r?\n/).filter((value) => /uinaf/i.test(value))) {
    yield* Console.error(`unexpected vendor branding in path: ${path}`);
    unexpected = true;
  }
  for (const line of contentScan.stdout.split(/\r?\n/).filter(Boolean)) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    const file = line.slice(0, first);
    const lineNumber = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!allowed(file, content)) {
      yield* Console.error(`unexpected vendor branding: ${file}:${lineNumber}:${content}`);
      unexpected = true;
    }
  }
  if (unexpected) return yield* fail("owner-name boundary failed");
  yield* Console.log("ok owner names are limited to external coordinates");
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
