#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { guardProfileSwitch, profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile, type InstallStep } from "../profiles/model.ts";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = process.env.DOTFILES_INSTALL_REPO_ROOT || sourceRoot;
const usage = `Usage:
  bootstrap/install.ts --profile developer|devbox|workstation|personal-devbox|personal-workstation [--switch-profile]
  bootstrap/install.ts --print-steps --profile PROFILE
  bootstrap/install.ts --maintenance [--profile PROFILE]

Applies per-user dotfiles and runs only the setup steps owned by the selected
role. An existing ~/.config/dotfiles/profile is used when --profile is omitted;
a different --profile needs --switch-profile to replace it.
--maintenance also installs declared packages and updates agent assets, preserving
Codex, Claude, and Grok logins. Bifrost enrollment preserves unrelated credentials.`;

const execute = Effect.fn("executeInstallCommand")(function* (
  label: string,
  command: string,
  args: readonly string[],
) {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run(command, args, { cwd: repoRoot, stdin: "inherit", output: "inherit" })
    .pipe(
      Effect.mapError(
        (error) => new CliFailure({ exitCode: 1, message: `${label}: ${error.message}` }),
      ),
    );
  if (result.status !== 0) return yield* fail(`${label} exited ${result.status}`, result.status);
});

const runStep = Effect.fn("runInstallStep")(function* (
  step: InstallStep,
  profile: string,
  maintenance: boolean,
) {
  const bootstrap = (name: string) => resolve(repoRoot, "bootstrap", name);
  switch (step) {
    case "apply-dotfiles":
      return yield* execute(step, bootstrap("apply-dotfiles.ts"), ["--profile", profile]);
    case "install-t3-service":
      // Unattended maintenance never installs a new background service.
      if (maintenance) return;
      return yield* execute(step, bootstrap("install-t3-service.ts"), ["--profile", profile]);
    case "install-oh-my-zsh":
      return yield* execute(step, bootstrap("install-oh-my-zsh.ts"), []);
    case "trust-agent-worktrees":
      return yield* execute(step, bootstrap("trust-agent-worktrees.ts"), []);
    case "install-gh-extensions":
      return yield* execute(step, bootstrap("install-gh-extensions.ts"), []);
    case "install-runtimes":
      yield* execute(step, "mise", ["install"]);
      return yield* execute(step, "mise", ["run", "dotfiles:runtime-packages"]);
    case "install-repository-dependencies":
      return yield* execute(step, "mise", [
        "exec",
        "--",
        "pnpm",
        "--dir",
        repoRoot,
        "install",
        "--frozen-lockfile",
      ]);
    case "configure-codex":
      return yield* execute(step, bootstrap("configure-codex.ts"), ["--profile", profile]);
    case "configure-grok":
      return yield* execute(step, bootstrap("configure-grok.ts"), ["--profile", profile]);
    case "configure-llm-gateway":
      return yield* execute(step, bootstrap("configure-llm-gateway.ts"), [
        maintenance ? "--maintenance" : "--setup",
      ]);
    case "sync-agents":
      for (const name of ["sync.ts", "plugins.ts", "mcps.ts"]) {
        yield* execute(`${step} ${name}`, resolve(repoRoot, "agents", name), [
          "--profile",
          profile,
          ...(maintenance && name !== "mcps.ts" ? ["--update"] : []),
        ]);
      }
      return;
    default: {
      const unsupported: never = step;
      return yield* fail(`unsupported install step: ${String(unsupported)}`, 2);
    }
  }
});

// Steps after install-runtimes call tools mise just installed (gh, chezmoi on
// Linux), and the launching shell may predate any mise activation.
const miseShims = join(
  process.env.MISE_DATA_DIR || join(process.env.HOME || "", ".local/share/mise"),
  "shims",
);
if (!(process.env.PATH || "").split(":").includes(miseShims))
  process.env.PATH = `${miseShims}:${process.env.PATH || ""}`;

const program = Effect.gen(function* () {
  let profileInput: string | undefined;
  let printSteps = false;
  let maintenance = false;
  let switchProfile = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value || profileInput !== undefined) {
        yield* Console.error(usage);
        return yield* fail("invalid --profile", 2);
      }
      profileInput = value;
      index += 1;
    } else if (argument === "--print-steps") {
      printSteps = true;
    } else if (argument === "--maintenance") {
      maintenance = true;
    } else if (argument === "--switch-profile") {
      switchProfile = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const profile = yield* resolveProfile(profileInput).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
  const modelPath =
    repoRoot === sourceRoot
      ? profileModelFile()
      : resolve(repoRoot, "chezmoi/.chezmoidata/profiles.json");
  const model = yield* readProfileModelEffect(modelPath).pipe(
    Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
  );
  const selected = requireProfile(model, profile);
  const steps = selected.installSteps;
  if (printSteps) {
    yield* Console.log(steps.join("\n"));
    return;
  }
  if (!switchProfile)
    yield* guardProfileSwitch(profile).pipe(
      Effect.mapError((error) => new CliFailure({ exitCode: 2, message: error.message })),
    );
  if (selected.capabilities.workstation && process.platform !== "darwin") {
    return yield* fail(
      `${profile} configures a macOS desktop; use developer or devbox on ${process.platform}`,
      2,
    );
  }
  if (maintenance && process.platform === "darwin")
    yield* execute("converge packages", resolve(repoRoot, "homebrew/brew-bundle.ts"), [
      "--maintenance",
      profile,
    ]);
  yield* Effect.forEach(steps, (step) => runStep(step, profile, maintenance));
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
