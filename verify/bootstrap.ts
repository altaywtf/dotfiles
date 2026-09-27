#!/usr/bin/env node

import { configureExternalCapabilities } from "../homebrew/external-capabilities.ts";

import { checkDevboxPhotoAnalysis } from "../bootstrap/darwin/photo-analysis.ts";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import {
  brewfilePath,
  bundleDrift,
  profileBrewfiles,
  runHomebrewRaw,
  withLocalBrewfile,
} from "../homebrew/homebrew.ts";
import { fail, runMain } from "../lib/program.ts";
import { checkMiseDoctor, resolveZsh, runCleanZsh } from "./shell-probe.ts";
import { resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const usage = "Usage:\n  verify/bootstrap.ts [--profile PROFILE] [--desktop] [--verbose]";
// renovate: datasource=pypi depName=PyYAML
const PYYAML_VERSION = "6.0.3";

const program = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  let requested: string | undefined;
  let desktop = false;
  let verbose = false;
  while (argv.length > 0) {
    const argument = argv.shift()!;
    if (argument === "--profile") {
      if (requested || argv.length === 0) return yield* fail(usage, 2);
      requested = argv.shift();
    } else if (argument === "--desktop") desktop = true;
    else if (argument === "--verbose") verbose = true;
    else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else if (argument.startsWith("-") || requested) return yield* fail(usage, 2);
    else requested = argument;
  }
  const profile = yield* resolveProfile(requested).pipe(Effect.mapError(() => new Error(usage)));
  const model = yield* readProfileModelEffect(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));
  const config = requireProfile(model, profile);
  if (desktop && !config.capabilities.devbox)
    return yield* fail("--desktop requires a devbox profile", 2);
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const home = process.env.HOME || "";
  const darwin = process.platform === "darwin";
  const zsh = yield* resolveZsh();
  const shell = Effect.fn("bootstrapShellCheck")(function* (
    command: string,
    flags: "-lic" | "-ic" = "-lic",
  ) {
    const result = yield* runCleanZsh(flags, command);
    if (result.status !== 0) return yield* fail(command);
    return result.stdout.trim();
  });
  const command = Effect.fn("bootstrapCommandCheck")(function* (
    binary: string,
    args: readonly string[] = [],
  ) {
    const result = yield* runner.run(binary, args, { output: "capture" });
    if (result.status !== 0) return yield* fail(`${binary} ${args.join(" ")}`);
    return result.stdout.trim();
  });
  const shellChecks = (checks: readonly string[]) =>
    Effect.forEach(checks, (check) => shell(check), { concurrency: "unbounded", discard: true });
  const commonTools = shellChecks([
    "age --version",
    ...(darwin ? ["brew --version"] : []),
    "chezmoi --version",
    "gh --version",
    "git --version",
    "mise --version",
    "sops --version",
    "jq --version",
    "rg --version",
  ]);
  const environment = Effect.gen(function* () {
    yield* checkMiseDoctor("login interactive", "-lic");
    yield* checkMiseDoctor("interactive", "-ic");
    const trust = yield* runner.run(process.execPath, [
      join(repoRoot, "bootstrap/trust-agent-worktrees.ts"),
      "--check",
    ]);
    if (trust.status !== 0) return yield* fail("trusted agent worktrees");
    const truecolor = yield* runner.run("/usr/bin/env", [
      "TERM=xterm-ghostty",
      zsh,
      "-ic",
      '[[ "$COLORTERM" = truecolor ]]',
    ]);
    if (truecolor.status !== 0)
      return yield* fail(
        "interactive zsh does not set COLORTERM=truecolor for Ghostty SSH sessions",
      );
    if (config.capabilities.devbox) {
      const prompt = yield* runner.run("/usr/bin/env", [
        zsh,
        "-ic",
        '[[ "$PROMPT" == *"%n@%m"* ]] && [[ -d "$ZSH" ]]',
      ]);
      if (prompt.status !== 0)
        return yield* fail(
          "devbox shells do not show user@host in PROMPT with oh-my-zsh installed",
        );
    }
    if (config.capabilities.workstation && darwin) {
      const ghostty = yield* fs.readFileString(
        join(home, "Library/Application Support/com.mitchellh.ghostty/config"),
      );
      if (!ghostty.split(/\r?\n/).includes("shell-integration-features = ssh-env,ssh-terminfo"))
        return yield* fail("Ghostty SSH integration is not configured");
    }
  });
  const runtime = Effect.gen(function* () {
    if (yield* shell("mise ls --current --missing --no-header"))
      return yield* fail("mise still reports missing configured tools");
    yield* shell("node --version");
    const nodePath = yield* shell("mise which node");
    const nodeRoot = yield* shell("mise where node");
    if (!nodePath.startsWith(`${nodeRoot}/`)) return yield* fail("Node is not owned by mise");
    yield* shellChecks([
      "pnpm --version",
      "npm --version",
      "playwright-cli --version",
      "ruby --version",
    ]);
    if ((yield* shell("command -v vp >/dev/null 2>&1; printf %s $?")) === "0")
      return yield* fail("vp is available globally; Vite+ must resolve from each repository");
    if ((yield* shell("npm config get prefix")) !== nodeRoot)
      return yield* fail("npm prefix is outside mise Node");
    if ((yield* shell("npm root --global")) !== `${nodeRoot}/lib/node_modules`)
      return yield* fail("npm global root is outside mise Node");
    if ((yield* shell("npm exec --yes -- node -p process.execPath")) !== `${nodeRoot}/bin/node`)
      return yield* fail("npm exec child Node is outside mise Node");
  });
  const developerTools = Effect.gen(function* () {
    yield* shellChecks([
      "python --version",
      `python -c 'import yaml; assert yaml.__version__ == "${PYYAML_VERSION}"'`,
      "uv --version",
      "gh auth status",
      "gh stack --help",
      "bun --version",
      "java -version",
      "codex --version",
      "claude --version",
      "glab --version",
      "aws --version",
      "topgrade --version",
      "slopguard version",
      ...(darwin ? ["mole --version"] : []),
    ]);
    // Homebrew supplies the Android command-line tools on macOS; a Linux user installs the SDK.
    const androidHome = yield* shell('printf %s "$ANDROID_HOME"');
    if (!androidHome && !darwin) return;
    if (!androidHome || !(yield* fs.exists(androidHome)))
      return yield* fail("ANDROID_HOME is missing");
    for (const [name, path] of [
      ["adb", "platform-tools/adb"],
      ["emulator", "emulator/emulator"],
      ["sdkmanager", "cmdline-tools/latest/bin/sdkmanager"],
    ]) {
      if ((yield* shell(`command -v ${name}`)) !== join(androidHome, path))
        return yield* fail(`${name} does not resolve from ANDROID_HOME`);
    }
  });
  const profileTools = Effect.gen(function* () {
    if (config.capabilities.personal)
      yield* shellChecks(["asc --version", "crabbox --version", "gitcrawl --version"]);
    if (config.capabilities.workstation) yield* shell("op --version");
    if (config.capabilities.personal && config.capabilities.workstation)
      yield* shellChecks(["grok --version", "tailscale status --peers=false"]);
    if (darwin)
      yield* command(process.execPath, [join(repoRoot, "bootstrap/darwin/xcode.ts"), "--check"]);
    if (config.capabilities.devbox) {
      yield* shellChecks([
        "tmux -V",
        "tailscale status --peers=false",
        ...(darwin ? ["xcodes version"] : []),
      ]);
      yield* command(process.execPath, [
        join(repoRoot, "bootstrap/install-t3-service.ts"),
        "--profile",
        profile,
        "--check",
      ]);
    }
  });
  const homebrew = Effect.gen(function* () {
    if (!darwin) return;
    const external = yield* configureExternalCapabilities(repoRoot, model, profile);
    for (const file of yield* withLocalBrewfile(repoRoot, profileBrewfiles(model, profile))) {
      const result = yield* runHomebrewRaw(
        "brew",
        ["bundle", "check", "--file", brewfilePath(repoRoot, file)],
        {
          env: {
            ...external,
            HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile,
            HOMEBREW_NO_AUTO_UPDATE: "1",
          },
        },
      );
      if (result.status !== 0)
        return yield* fail(
          `missing Homebrew dependencies from ${file}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`,
        );
    }
    const drift = yield* bundleDrift(repoRoot, model, profile);
    if (drift.trim())
      return yield* fail(
        `installed Homebrew packages drift from the profile manifests and local Brewfile:\n${drift}`,
      );
  });
  const configuration = Effect.gen(function* () {
    const paths = [
      join(home, ".config/dotfiles/profile"),
      join(home, ".config/mise/config.toml"),
      join(home, ".gitconfig"),
      join(home, ".config/git/allowed_signers"),
      join(home, ".codex/config.toml"),
      join(home, ".gitconfig.local"),
      join(home, ".ssh/config"),
    ];
    if (config.capabilities.workstation)
      paths.push(join(home, "Library/Application Support/com.mitchellh.ghostty/config"));
    for (const path of paths) if (!(yield* fs.exists(path))) return yield* fail(`missing ${path}`);
    if ((yield* resolveProfile(undefined)) !== profile)
      return yield* fail(`installed profile does not match ${profile}`);
    if (config.capabilities.requiresSopsIdentity)
      yield* command(process.execPath, [
        join(repoRoot, "identity/configure-sops-age-identity.ts"),
        "--check",
      ]);
    const codex = yield* fs.readFileString(join(home, ".codex/config.toml"));
    if (/^forced_login_method\s*=/m.test(codex.split(/^\s*\[/m)[0] || ""))
      return yield* fail("Codex forced_login_method must be absent");
  });
  const host = Effect.gen(function* () {
    if (!darwin) return;
    yield* checkDevboxPhotoAnalysis(profile, process.getuid?.() ?? -1);
    yield* command(process.execPath, [
      join(repoRoot, "bootstrap/darwin/configure-spotlight.ts"),
      "--check",
    ]);
    if (desktop)
      yield* command(process.execPath, [
        join(repoRoot, "bootstrap/darwin/configure-desktop.ts"),
        "--check",
      ]);
  });
  const groups: readonly [
    string,
    Effect.Effect<void, unknown, CommandRunner | FileSystem.FileSystem>,
  ][] = [
    ["environment", environment],
    ["runtime", runtime],
    ["common-tools", commonTools],
    ["homebrew", homebrew],
    ["configuration", configuration],
    ["developer-tools", developerTools],
    ["profile-tools", profileTools],
    ["host", host],
  ];
  const started = Date.now();
  yield* Effect.forEach(
    groups,
    ([name, effect]) =>
      effect.pipe(
        Effect.tap(() => Console.log(`ok ${name}`)),
        Effect.tapError((error) =>
          Console.error(
            `FAILED: ${name}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
  if (verbose) yield* Console.log("all live probes completed");
  yield* Console.log(
    `bootstrap verification ok (${profile}, ${Math.floor((Date.now() - started) / 1000)}s)`,
  );
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
