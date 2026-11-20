#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

// chezmoi renders the unit and timer; this script only flips their state.
const updateUnit = "dotfiles-software-update";
const usage = "Usage: maintenance/linux/schedule.ts <enable|disable|run|status>";

export const manageSchedule = Effect.fn("manageSchedule")(function* (
  action: string,
  home: string,
  uid: number,
) {
  if (!["enable", "disable", "run", "status"].includes(action)) {
    return yield* fail(usage, 2);
  }
  const runner = yield* CommandRunner;
  const fs = yield* FileSystem.FileSystem;
  const systemctl = (...args: Array<string>) =>
    runner.run("systemctl", ["--user", ...args], { output: "capture" });
  // disable, run, and status address units systemd already loaded, even after
  // the files are gone.
  if (action === "enable") {
    for (const suffix of ["timer", "service"]) {
      const unitFile = join(home, ".config/systemd/user", `${updateUnit}.${suffix}`);
      if (!(yield* fs.exists(unitFile))) {
        return yield* fail(`missing ${unitFile}; run ./dotfiles apply first`);
      }
    }
  }
  // Without lingering the user manager, and this timer with it, stops at logout.
  const linger = Effect.gen(function* () {
    const result = yield* runner.run(
      "loginctl",
      ["show-user", String(uid), "--property=Linger", "--value"],
      { output: "capture" },
    );
    if (result.status !== 0) {
      return yield* fail(`loginctl show-user exited ${result.status}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim() === "yes";
  });

  switch (action) {
    case "enable": {
      if (!(yield* linger)) {
        return yield* fail(
          "unattended maintenance needs systemd lingering; have an administrator run: sudo loginctl enable-linger $(id -un)",
        );
      }
      for (const args of [["daemon-reload"], ["enable", "--now", `${updateUnit}.timer`]]) {
        const result = yield* systemctl(...args);
        if (result.status !== 0) {
          return yield* fail(
            `systemctl --user ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
          );
        }
      }
      return yield* Console.log(
        `Software maintenance enabled: ${updateUnit}.timer runs every six hours.`,
      );
    }
    case "disable": {
      // disable is a unit-file operation and stop a loaded-unit one; a missing
      // timer file must not keep a running update alive, so both always run.
      const failures: Array<string> = [];
      for (const args of [
        ["disable", "--now", `${updateUnit}.timer`],
        ["stop", `${updateUnit}.service`],
      ]) {
        const result = yield* systemctl(...args).pipe(
          Effect.catch((error) => Effect.succeed({ status: 1, stdout: "", stderr: error.message })),
        );
        if (result.status !== 0) {
          failures.push(
            `systemctl --user ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
          );
        }
      }
      if (failures.length > 0) {
        return yield* fail(failures.join("\n"));
      }
      return yield* Console.log("Software maintenance disabled; any running update was stopped.");
    }
    case "run": {
      const result = yield* systemctl("start", "--no-block", `${updateUnit}.service`);
      if (result.status !== 0) {
        return yield* fail(
          `systemctl --user start exited ${result.status}: ${result.stderr.trim()}`,
        );
      }
      return yield* Console.log(
        `Update requested; systemd keeps one instance. Log: journalctl --user -u ${updateUnit}`,
      );
    }
    case "status": {
      const enabled = yield* systemctl("is-enabled", `${updateUnit}.timer`);
      const active = yield* systemctl("is-active", `${updateUnit}.timer`);
      const next = yield* systemctl(
        "list-timers",
        "--no-pager",
        "--no-legend",
        `${updateUnit}.timer`,
      );
      const lastRun = yield* systemctl(
        "show",
        "-p",
        "ExecMainStatus",
        "-p",
        "ExecMainExitTimestamp",
        `${updateUnit}.service`,
      );
      yield* Console.log(
        `timer: ${enabled.stdout.trim() || "unknown"} (${active.stdout.trim() || "unknown"})`,
      );
      if (next.stdout.trim()) {
        yield* Console.log(`next: ${next.stdout.trim()}`);
      }
      yield* Console.log(
        lastRun.stdout
          .trim()
          .split("\n")
          .map((line) => `last ${line}`)
          .join("\n"),
      );
      const receipt = join(home, ".local/state/dotfiles/updates/software-update.json");
      if (yield* fs.exists(receipt)) {
        yield* Console.log(`receipt: ${(yield* fs.readFileString(receipt)).trim()}`);
      }
      yield* Console.log(`log: journalctl --user -u ${updateUnit}`);
      if (enabled.status !== 0 || active.status !== 0) {
        return yield* fail(
          `${updateUnit}.timer is ${enabled.stdout.trim() || "not enabled"} and ${active.stdout.trim() || "not active"}`,
        );
      }
      if (!(yield* linger)) {
        return yield* fail("systemd lingering is off; the timer stops at logout");
      }
      return;
    }
  }
});

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const program =
    process.argv.length === 3
      ? manageSchedule(process.argv[2] ?? "", process.env.HOME || "", process.getuid?.() ?? -1)
      : fail(usage, 2);
  runMain(program.pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)));
}
