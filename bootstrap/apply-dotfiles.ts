#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLocalAgentRules } from "../agents/rules-local.ts";
import { backupPreexistingTargets, type ChezmoiContext } from "./managed-files.ts";
import { convergeUserManager } from "./linux/user-manager.ts";
import { refreshAgentRules } from "../agents/rules.ts";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { resolveProfile } from "../profiles/current.ts";
import { disableDevboxPhotoAnalysis } from "./darwin/photo-analysis.ts";
import { reconcileTemporarySource } from "./temporary-source.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "chezmoi");
const home = process.env.HOME || "";
const configDir = join(home, ".config/dotfiles");
const agentRulesPath = join(
  process.env.XDG_STATE_HOME || join(home, ".local/state"),
  "dotfiles/agent-rules.md",
);
const usage = `Usage:
  bootstrap/apply-dotfiles.ts [--profile PROFILE] [--dry-run] [--verbose]

Applies the repo-local chezmoi source state for the selected profile to $HOME. When --profile is omitted, the stored profile is used,
followed by DOTFILES_PROFILE for first-time setup.`;

const Arguments = Schema.Struct({
  profile: Schema.optional(Schema.String),
  dryRun: Schema.Boolean,
  verbose: Schema.Boolean,
});
type Arguments = typeof Arguments.Type;

const parseArguments = Effect.fn("parseApplyDotfilesArguments")(function* (
  args: readonly string[],
) {
  const parsed: { profile?: string; dryRun: boolean; verbose: boolean } = {
    dryRun: false,
    verbose: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--profile": {
        const profile = args[index + 1];
        if (!profile || parsed.profile !== undefined) return yield* fail("invalid --profile", 2);
        parsed.profile = profile;
        index += 1;
        break;
      }
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      default:
        return yield* fail(`unsupported argument ${args[index]}`, 2);
    }
  }
  return yield* Schema.decodeUnknownEffect(Arguments)(parsed).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
});

// chezmoi and gitleaks are mise tools declared by the very config this script
// renders, so the first apply borrows the pinned releases through `mise x`
// until the shims exist.
const ensureBootstrapTools = Effect.fn("ensureBootstrapTools")(function* () {
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const template = yield* fs.readFileString(join(sourceDir, ".chezmoitemplates/mise.toml"));
  const offline = process.env.DOTFILES_AGENT_RULES_OFFLINE === "1";
  for (const tool of offline ? ["chezmoi"] : ["chezmoi", "gitleaks"]) {
    const onPath = yield* runner
      .run("sh", ["-c", `command -v ${tool}`], { output: "capture" })
      .pipe(Effect.option);
    if (Option.isSome(onPath) && onPath.value.status === 0) continue;
    const pin = new RegExp(`^${tool} = "([^"]+)"$`, "m").exec(template)?.[1];
    if (!pin) return yield* fail(`${tool} is not on PATH and the mise template has no ${tool} pin`);
    const located = yield* runner
      .run(
        "mise",
        ["--no-config", "x", `${tool}@${pin}`, "--", "sh", "-c", `dirname "$(command -v ${tool})"`],
        { output: "capture" },
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new CliFailure({
              exitCode: 1,
              message: `cannot provision ${tool}@${pin} through mise: ${error.message}`,
            }),
        ),
      );
    const directory = located.stdout.trim().split("\n").at(-1) || "";
    if (located.status !== 0 || !directory.startsWith("/"))
      return yield* fail(
        `cannot provision ${tool}@${pin} through mise (exit ${located.status}): ${located.stderr.trim() || "no stderr"}`,
      );
    process.env.PATH = `${directory}:${process.env.PATH || ""}`;
  }
});

const runCommand = Effect.fn("runApplyDotfilesCommand")(function* (
  command: string,
  args: readonly string[],
  output: "capture" | "inherit" = "capture",
) {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run(command, args, { cwd: repoRoot, stdin: "inherit", output })
    .pipe(Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })));
  if (result.status !== 0) return yield* fail(`${command} exited ${result.status}`, result.status);
  return result;
});

const program = Effect.gen(function* () {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 1 && (rawArgs[0] === "-h" || rawArgs[0] === "--help")) {
    yield* Console.log(usage);
    return;
  }
  const args = yield* parseArguments(rawArgs).pipe(Effect.tapError(() => Console.error(usage)));
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(sourceDir)))
    return yield* fail(`missing chezmoi source directory: ${sourceDir}`);
  if (!home) return yield* fail("HOME is required");
  yield* ensureBootstrapTools();
  const profile = yield* resolveProfile(args.profile).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
  const configLink = yield* fs.readLink(configDir).pipe(Effect.option);
  if (Option.isSome(configLink))
    return yield* fail(`canonical config directory must not be a symlink: ${configDir}`);
  const configExists = yield* fs.exists(configDir);
  if (configExists && (yield* fs.stat(configDir)).type !== "Directory") {
    return yield* fail(`canonical config path must be a directory: ${configDir}`);
  }
  const temporarySource = process.env.DOTFILES_TEMPORARY_SOURCE === "1";
  if (temporarySource) yield* reconcileTemporarySource(home, args.dryRun);
  const context: ChezmoiContext = {
    repoRoot,
    home,
    baseArgs: [
      "--source",
      sourceDir,
      "--destination",
      home,
      "--override-data",
      JSON.stringify({
        agentRulesPath,
        dotfilesProfile: profile,
        temporarySource,
      }),
    ],
    dryRun: args.dryRun,
  };
  yield* validateLocalAgentRules(configDir, args.dryRun);
  yield* refreshAgentRules(repoRoot, agentRulesPath, {
    offline: process.env.DOTFILES_AGENT_RULES_OFFLINE === "1",
  });
  yield* backupPreexistingTargets(context);
  // chezmoi writes non-private targets with the process umask; a UMask=0002
  // caller would leave shell startup files writable by the staff group.
  process.umask(0o022);
  const applyArgs = [...context.baseArgs, "--force", "apply"];
  if (args.dryRun) applyArgs.push("--dry-run");
  if (args.verbose) applyArgs.push("--verbose");
  yield* runCommand("chezmoi", applyArgs, "inherit");
  yield* disableDevboxPhotoAnalysis(profile, process.getuid?.() ?? -1, args.dryRun);
  yield* convergeUserManager(home, args.dryRun);
  yield* Console.log(
    `dotfiles ${args.dryRun ? "previewed" : "applied"} for ${profile} with chezmoi source ${sourceDir}`,
  );
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runMain(program);
}
