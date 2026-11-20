#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";
import { normalizeProfile } from "../../profiles/current.ts";

const usage = `Usage:
  bootstrap/darwin/configure-power.ts [--profile developer|devbox|workstation|personal-devbox|personal-workstation] [--check]

Configures plugged-in macOS power policy for managed Macs:
  - disables system sleep on AC power
  - disables display sleep on AC power
  - disables disk sleep on AC power

Battery settings are intentionally left unchanged.`;
const keys = ["sleep", "displaysleep", "disksleep"] as const;

function readAcSettings(output: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let inAc = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("AC Power:")) {
      inAc = true;
      continue;
    }
    if (/^[A-Za-z].*:$/.test(line)) {
      inAc = false;
    }
    if (inAc) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match) {
        values.set(match[1], match[2]);
      }
    }
  }
  return values;
}

const checkPolicy = Effect.fn("checkPowerPolicy")(function* () {
  const runner = yield* CommandRunner;
  const result = yield* runner.run("pmset", ["-g", "custom"]);
  if (result.status !== 0) {
    return yield* fail(`pmset -g custom exited ${result.status}`);
  }
  const settings = readAcSettings(result.stdout);
  let failed = false;
  for (const key of keys) {
    const value = settings.get(key);
    if (value === "0") {
      yield* Console.log(`ok AC ${key}=0`);
    } else {
      yield* Console.error(`FAILED: AC ${key}=${value || "missing"}, expected 0`);
      failed = true;
    }
  }
  if (failed) {
    return yield* fail("plugged-in power policy drift detected");
  }
});

const program = Effect.gen(function* () {
  let profileInput = "personal-workstation";
  let profileSet = false;
  let checkOnly = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value || profileSet) {
        return yield* fail("invalid --profile", 2);
      }
      profileInput = value;
      profileSet = true;
      index += 1;
    } else if (argument === "--check") {
      checkOnly = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else if (!argument.startsWith("-") && !profileSet) {
      profileInput = argument;
      profileSet = true;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }
  const profile = yield* normalizeProfile(profileInput).pipe(
    Effect.mapError(() => new Error("unsupported profile")),
  );
  if (process.platform !== "darwin") {
    return yield* fail("configure-power is macOS-only");
  }
  if (checkOnly) {
    yield* checkPolicy();
    return;
  }
  const runner = yield* CommandRunner;
  const command = process.getuid?.() === 0 ? "pmset" : "sudo";
  const commandArgs =
    process.getuid?.() === 0
      ? ["-c", "sleep", "0", "displaysleep", "0", "disksleep", "0"]
      : ["pmset", "-c", "sleep", "0", "displaysleep", "0", "disksleep", "0"];
  if (command === "sudo") {
    yield* Console.error("configure-power needs sudo to update system power settings");
  }
  const result = yield* runner.run(command, commandArgs, { output: "inherit" });
  if (result.status !== 0) {
    return yield* fail(`${command} exited ${result.status}`);
  }
  yield* checkPolicy();
  yield* Console.log(`plugged-in power policy configured (${profile})`);
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
