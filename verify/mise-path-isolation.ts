#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem } from "effect";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import { checkMiseDoctor, resolveZsh, runCleanZsh } from "./shell-probe.ts";

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "dotfiles-mise-path." });
    const home = join(temporary, "home");
    const bin = join(temporary, "bin");
    yield* fs.makeDirectory(home);
    yield* fs.makeDirectory(bin);
    const fakeZsh = join(bin, "zsh");
    yield* fs.writeFileString(
      fakeZsh,
      `#!/bin/sh
{
printf 'flags=%s\\n' "$*"; printf 'path=%s\\n' "\${PATH:-}"; printf 'user=%s\\n' "\${USER:-}"; printf 'logname=%s\\n' "\${LOGNAME:-}"
printf 'zdotdir=%s\\n' "\${ZDOTDIR:-}"; printf 'xdg_config=%s\\n' "\${XDG_CONFIG_HOME:-}"; printf 'mise_config=%s\\n' "\${MISE_CONFIG_DIR:-}"
printf 'mise_shell=%s\\n' "\${MISE_SHELL:-}"; printf 'mise_session=%s\\n' "\${__MISE_SESSION:-}"; printf 'mise_orig_path=%s\\n' "\${__MISE_ORIG_PATH:-}"; printf 'mise_activate_path=%s\\n' "\${__MISE_ZSH_ACTIVATE_PATH:-}"
} > "$HOME/.probe.log"
case "$*" in
 *'mise doctor'*) if [ -f "$HOME/.warn" ]; then printf 'mise tool paths are not first in PATH\\n'; else printf 'activated: yes\\n'; fi; [ ! -f "$HOME/.fail" ] ;;
 *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: home,
      DOTFILES_ZSH_BIN: fakeZsh,
      ZDOTDIR: join(temporary, "zdot"),
      XDG_CONFIG_HOME: join(temporary, "xdg-config"),
      MISE_CONFIG_DIR: join(temporary, "mise-config"),
      PATH: "/Users/fixture/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin:/usr/bin:/bin",
      MISE_SHELL: "zsh",
      __MISE_SESSION: "session-token",
      __MISE_ORIG_PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      __MISE_ZSH_ACTIVATE_PATH:
        "/Users/fixture/.local/share/mise/installs/node/24.18.0/bin:/opt/homebrew/bin",
    });
    const result = yield* runCleanZsh("-lic", "mise doctor");
    assert.equal(result.status, 0, result.stderr);
    const log = yield* fs.readFileString(join(home, ".probe.log"));

    for (const expected of [
      `flags=-lic mise doctor`,
      `zdotdir=${join(temporary, "zdot")}`,
      `xdg_config=${join(temporary, "xdg-config")}`,
      `mise_config=${join(temporary, "mise-config")}`,
      "mise_shell=",
      "mise_session=",
      "mise_orig_path=",
      "mise_activate_path=",
    ]) {
      assert.ok(log.split("\n").includes(expected), expected);
    }

    assert.equal(log.includes("/Users/fixture/.local/share/mise"), false);
    const observedPath = /^path=(.*)$/m.exec(log)?.[1] || "";
    assert.ok(observedPath.endsWith("/usr/bin:/bin:/usr/sbin:/sbin"));
    yield* fs.writeFileString(join(home, ".warn"), "");
    const warning = yield* checkMiseDoctor("login interactive", "-lic").pipe(Effect.flip);
    assert.match(warning.message, /tool paths are not first in PATH/);
    yield* fs.writeFileString(join(home, ".fail"), "");
    const orderedFailure = yield* checkMiseDoctor("login interactive", "-lic").pipe(Effect.flip);
    assert.match(orderedFailure.message, /tool paths are not first in PATH/);
    yield* fs.remove(join(home, ".warn"));
    const generic = yield* checkMiseDoctor("interactive", "-ic").pipe(Effect.flip);
    assert.match(generic.message, /probe exited non-zero/);
    yield* fs.remove(join(home, ".fail"));
    yield* checkMiseDoctor("interactive", "-ic");
    delete process.env.DOTFILES_ZSH_BIN;
    process.env.SHELL = fakeZsh;
    process.env.PATH = `${join(temporary, "shim-bin")}:/usr/bin:/bin`;
    assert.equal(yield* resolveZsh(), fakeZsh);

    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, saved);
    yield* Console.log("ok mise PATH probes are isolated from an activated caller shell");
  }).pipe(
    Effect.catchCause((cause) => fail(Cause.pretty(cause))),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  ),
);

runMain(program);
