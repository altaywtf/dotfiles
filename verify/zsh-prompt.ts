#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-zsh-prompt." });
    yield* fs.makeDirectory(join(home, ".config/dotfiles"), { recursive: true });
    yield* fs.writeFileString(join(home, ".config/dotfiles/devbox.env"), "");
    yield* fs.symlink(join(repoRoot, "chezmoi/dot_zprofile"), join(home, ".zprofile"));
    const rendered = yield* runner.run("chezmoi", [
      "--source",
      join(repoRoot, "chezmoi"),
      "--destination",
      home,
      "--override-data",
      '{"dotfilesProfile":"personal-devbox"}',
      "cat",
      join(home, ".zshrc"),
    ]);
    if (rendered.status !== 0) return yield* fail(rendered.stderr);
    const zshrc = join(home, ".zshrc.rendered");
    yield* fs.writeFileString(zshrc, rendered.stdout);
    for (const path of [
      ".local/bin",
      "Library/Android/sdk/platform-tools",
      "Library/Android/sdk/emulator",
      "Library/Android/sdk/cmdline-tools/latest/bin",
      ".local/share/mise/shims",
      "fake-tools",
      "repo",
    ])
      yield* fs.makeDirectory(join(home, path), { recursive: true });
    yield* fs.writeFileString(join(home, "fake-tools/mise"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    yield* runner.run("git", ["-C", join(home, "repo"), "init", "-q"]);
    yield* runner.run("git", ["-C", join(home, "repo"), "symbolic-ref", "HEAD", "refs/heads/demo"]);
    const check = Effect.fn("zshPromptCheck")(function* (
      code: string,
      env: Readonly<Record<string, string>>,
      args: readonly string[] = [],
    ) {
      const result = yield* runner.run("/usr/bin/env", [
        "-i",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        "/bin/zsh",
        ...args,
        code,
        "zsh",
        zshrc,
      ]);
      if (result.status !== 0) return yield* fail(result.stderr || code);
    });
    yield* check("(( ${path[(Ie)$HOME/.local/bin]} > 0 ))", { HOME: home, PATH: "/usr/bin:/bin" }, [
      "-dlc",
    ]);
    const inheritedPath = `${home}/fake-tools:/opt/homebrew/bin:/usr/bin:/bin:${home}/.local/share/mise/shims`;
    yield* check(
      'shims="$HOME/.local/share/mise/shims"; (( ${path[(Ie)$shims]} == 1 )); (( ${path[(Ie)/opt/homebrew/bin]} > 1 ))',
      { HOME: home, PATH: inheritedPath },
      ["-dlc"],
    );
    yield* check(
      'source "$1" 2>/dev/null; [[ -o promptsubst ]]; cd "$HOME/repo"; helper="$(devbox_git_prompt_info)"; [[ "$helper" == *demo* ]]; rendered="$(print -P -- "$PROMPT")"; [[ "$rendered" == *demo* ]]; [[ "$rendered" != *"\\$(devbox_git_prompt_info)"* ]]',
      { HOME: home, PATH: "/usr/bin:/bin", SSH_CONNECTION: "test", TERM: "xterm-256color" },
      ["-dfc"],
    );
    yield* check(
      'source "$1" 2>/dev/null; expected="$HOME/Library/Android/sdk"; [[ "$ANDROID_HOME" == "$expected" ]]; [[ "$path[1]" == "$expected/platform-tools" ]]; [[ "$path[2]" == "$expected/emulator" ]]; [[ "$path[3]" == "$expected/cmdline-tools/latest/bin" ]]; [[ -z "${ANDROID_SDK_ROOT:-}" ]]',
      { HOME: home, PATH: "/usr/bin:/bin" },
      ["-dfc"],
    );
    yield* check(
      'source "$1" 2>/dev/null; shims_index=${path[(Ie)$HOME/.local/share/mise/shims]}; brew_index=${path[(Ie)/opt/homebrew/bin]}; (( shims_index > 0 )); (( brew_index == 0 || shims_index < brew_index ))',
      { HOME: home, PATH: inheritedPath },
      ["-dfc"],
    );
    const receipt = join(home, ".local/state/dotfiles/updates/software-update.json");
    yield* fs.makeDirectory(join(home, ".local/state/dotfiles/updates"), { recursive: true });
    yield* fs.writeFileString(receipt, "{}");
    const warning = '"$(source "$1" 2>&1 >/dev/null)"';
    yield* check(
      `[[ ${warning} != *"no software update"* ]]`,
      { HOME: home, PATH: "/usr/bin:/bin" },
      ["-dfc"],
    );
    yield* runner.run("touch", ["-t", "202001010000", receipt]);
    yield* check(
      `[[ ${warning} == *"no software update"* ]]`,
      { HOME: home, PATH: "/usr/bin:/bin" },
      ["-dfc"],
    );
    const disabled = join(home, ".local/state/dotfiles/updates/software-update.disabled");
    yield* fs.writeFileString(disabled, "");
    yield* check(
      `[[ ${warning} != *"no software update"* ]]`,
      { HOME: home, PATH: "/usr/bin:/bin" },
      ["-dfc"],
    );
    yield* Console.log(
      "ok login PATH, mise shim precedence, devbox zsh prompt substitution, Android SDK environment, and stale updater warning",
    );
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);
runMain(program);
