import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail } from "../lib/program.ts";

export const resolveZsh = Effect.fn("resolveProbeZsh")(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const candidate of [
    process.env.DOTFILES_ZSH_BIN,
    process.env.SHELL?.endsWith("/zsh") ? process.env.SHELL : undefined,
    "/opt/homebrew/bin/zsh",
    "/usr/local/bin/zsh",
    "/usr/bin/zsh",
    "/bin/zsh",
  ]) {
    if (!candidate) {
      continue;
    }
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
      return candidate;
    }
  }
  return yield* fail("no zsh found for PATH probe; set DOTFILES_ZSH_BIN");
});

const cleanLoginPath = Effect.fn("cleanLoginPath")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths: Array<string> = [];
  const prefix = process.env.HOMEBREW_PREFIX?.replace(/\/$/, "");
  for (const directory of [prefix, "/opt/homebrew", "/usr/local"]) {
    if (!directory || paths.includes(join(directory, "bin"))) {
      continue;
    }
    if (yield* fs.exists(join(directory, "bin"))) {
      paths.push(join(directory, "bin"), join(directory, "sbin"));
    }
  }
  return [...paths, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
});

export const runCleanZsh = Effect.fn("runCleanZsh")(function* (
  flags: "-lic" | "-ic",
  command: string,
) {
  const zsh = yield* resolveZsh();
  const runner = yield* CommandRunner;
  const user = process.env.USER || "unknown";
  const environment = new Map([
    ["HOME", process.env.HOME || ""],
    ["USER", user],
    ["LOGNAME", process.env.LOGNAME || user],
    ["SHELL", zsh],
    ["TMPDIR", process.env.TMPDIR || "/tmp"],
    ["PATH", yield* cleanLoginPath()],
  ]);
  for (const key of [
    "TERM",
    "LANG",
    "LC_ALL",
    "HOMEBREW_PREFIX",
    "ZDOTDIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "MISE_CONFIG_DIR",
    "MISE_DATA_DIR",
    "MISE_GLOBAL_CONFIG_FILE",
    "MISE_TRUSTED_CONFIG_PATHS",
    "MISE_ENV",
  ] as const) {
    const value = process.env[key];
    if (value) {
      environment.set(key, value);
    }
  }
  return yield* runner.run(
    "/usr/bin/env",
    ["-i", ...[...environment].map(([key, value]) => `${key}=${value}`), zsh, flags, command],
    { extendEnv: false },
  );
});

export const checkMiseDoctor = Effect.fn("checkMiseDoctor")(function* (
  label: string,
  flags: "-lic" | "-ic",
) {
  const result = yield* runCleanZsh(flags, "mise doctor");
  const output = `${result.stdout}${result.stderr}`;
  if (output.includes("tool paths are not first in PATH")) {
    return yield* fail(`mise tool paths are not first in PATH (${label})`);
  }
  if (result.status !== 0) {
    return yield* fail(`mise doctor probe exited non-zero (${label})`);
  }
  return output;
});
