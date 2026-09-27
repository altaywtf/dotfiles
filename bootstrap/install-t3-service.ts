#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail, runMain } from "../lib/program.ts";
import { profileModelFile, resolveProfile } from "../profiles/current.ts";
import { readProfileModelEffect, requireProfile } from "../profiles/model.ts";

// T3 owns the launchd/systemd plumbing and the service's later updates; this
// step installs the service when absent, removes it after an explicit opt-out,
// and proves either state under --check.
function t3ServiceUnit(home: string, platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? join(home, "Library/LaunchAgents/com.t3tools.t3code.service.plist")
    : join(home, ".config/systemd/user/t3code.service");
}

const t3ServiceSetting = Effect.fn("t3ServiceSetting")(function* (devboxEnv: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(devboxEnv).pipe(Effect.catch(() => Effect.succeed("")));
  return [...contents.matchAll(/^T3_SERVICE=([01])\r?$/gm)].at(-1)?.[1];
});

// Durable personal devboxes serve T3 by default; scoped devboxes are on-demand
// and workstations run the desktop app instead.
function t3ServiceByDefault(capabilities: { personal: boolean; devbox: boolean }): boolean {
  return capabilities.personal && capabilities.devbox;
}

export const installT3Service = Effect.fn("installT3Service")(function* (
  home: string,
  check: boolean,
  byDefault: boolean,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? -1,
  baseDir: string = process.env.T3_BASE_DIR || join(home, ".t3"),
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const unit = t3ServiceUnit(home, platform);
  // T3_SERVICE in devbox.env overrides the profile default either way; only an
  // explicit T3_SERVICE=0 removes a service, so a manual install survives.
  const setting = yield* t3ServiceSetting(join(home, ".config/dotfiles/devbox.env"));
  const present = yield* fs.exists(unit);
  if (setting === "0" && present) {
    if (check) return yield* fail(`T3_SERVICE=0 but the T3 Code service is installed: ${unit}`);
    yield* Console.log(`removing the T3 Code service (T3_SERVICE=0) with base dir ${baseDir}`);
    const uninstall = yield* runner.run("t3", ["service", "uninstall", "--base-dir", baseDir], {
      output: "inherit",
    });
    if (uninstall.status !== 0)
      return yield* fail(`t3 service uninstall exited ${uninstall.status}`, uninstall.status);
    if (yield* fs.exists(unit))
      return yield* fail(`t3 service uninstall finished but ${unit} remains`);
    return;
  }
  if (setting === "0" || (setting === undefined && !byDefault)) {
    return check
      ? undefined
      : yield* Console.log(
          "T3 Code service not requested (set T3_SERVICE=1 in ~/.config/dotfiles/devbox.env)",
        );
  }
  if (check && !present) return yield* fail(`T3 Code service is not installed: ${unit}`);
  if (check && present && platform === "linux") {
    // The service inherits the user manager's environment, not the shell's:
    // prove the running process can reach the mise shims, or providers show
    // as "not found" in T3 while every shell finds them.
    const pid = yield* runner.run(
      "systemctl",
      ["--user", "show", "-p", "MainPID", "--value", "t3code.service"],
      { output: "capture" },
    );
    const mainPid = pid.stdout.trim();
    if (pid.status !== 0 || !/^[1-9]\d*$/.test(mainPid))
      return yield* fail("t3code.service is installed but not running");
    const environ = yield* fs
      .readFileString(`/proc/${mainPid}/environ`)
      .pipe(Effect.catch(() => Effect.succeed("")));
    const servicePath =
      environ
        .split("\0")
        .find((entry) => entry.startsWith("PATH="))
        ?.slice(5) ?? "";
    if (!servicePath.split(":").includes(join(home, ".local/share/mise/shims"))) {
      return yield* fail(
        "t3code.service PATH lacks the mise shims; rerun ./dotfiles apply and restart the service",
      );
    }
  }
  if (present && platform !== "linux")
    return check ? undefined : yield* Console.log(`T3 Code service present: ${unit}`);
  if (platform === "linux") {
    // Without lingering the user manager, and the service with it, stops at logout.
    const linger = yield* runner
      .run("loginctl", ["show-user", String(uid), "--property=Linger", "--value"], {
        output: "capture",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new CliFailure({
              exitCode: 1,
              message: `cannot query systemd-logind: ${error.message}`,
            }),
        ),
      );
    if (linger.status !== 0)
      return yield* fail(`loginctl show-user exited ${linger.status}: ${linger.stderr.trim()}`);
    if (linger.stdout.trim() !== "yes") {
      return yield* fail(
        "T3 Code needs systemd lingering; have an administrator run: sudo loginctl enable-linger $(id -un)",
      );
    }
  }
  if (check) return;
  if (present) return yield* Console.log(`T3 Code service present: ${unit}`);
  yield* Console.log(`installing the T3 Code service with base dir ${baseDir}`);
  const install = yield* runner.run("t3", ["service", "install", "--base-dir", baseDir], {
    output: "inherit",
  });
  const installed = yield* fs.exists(unit);
  // Over SSH with nobody at the Mac's screen, T3 writes the LaunchAgent and then
  // fails to start it in the GUI domain; upstream documents that the service
  // starts at the next login.
  if (install.status !== 0 && installed && platform === "darwin") {
    // t3 exits a generic 1 for the headless start failure, so T3's own status
    // is the evidence: a partial or corrupt install does not report installed.
    const status = yield* runner.run("t3", ["service", "status", "--base-dir", baseDir], {
      output: "capture",
    });
    if (status.status === 0 && /^\s*Status:\s*installed\b/m.test(status.stdout)) {
      return yield* Console.log(
        `T3 Code service installed at ${unit}; start deferred to the next GUI login (t3 exited ${install.status})`,
      );
    }
  }
  if (install.status !== 0)
    return yield* fail(`t3 service install exited ${install.status}`, install.status);
  if (!installed) return yield* fail(`t3 service install finished but ${unit} is missing`);
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function* () {
    let check = false;
    let requested: string | undefined;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--check") check = true;
      else if (args[index] === "--profile" && args[index + 1]) requested = args[++index];
      else return yield* fail("usage: install-t3-service.ts [--profile PROFILE] [--check]", 2);
    }
    const profile = yield* resolveProfile(requested);
    const model = yield* readProfileModelEffect(profileModelFile());
    const { capabilities } = requireProfile(model, profile);
    return yield* installT3Service(process.env.HOME || "", check, t3ServiceByDefault(capabilities));
  });
  runMain(program.pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
}
