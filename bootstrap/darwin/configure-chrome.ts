#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { dirname, resolve } from "node:path";
import {
  updateChromeLocalStatePreferencesEffect,
  updateChromeProfilesEffect,
} from "./chrome-state.ts";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../../lib/command.ts";
import { fail, runMain } from "../../lib/program.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyDomain = "com.google.Chrome";
const flagOverrides = [{ name: "vertical-tabs", value: "vertical-tabs@1" }] as const;
// Chrome reads this preference domain as mandatory platform policy on macOS, so
// these apply to every Chrome profile without an MDM. The chrome://flags override
// for the Lens "Ask Google" chip expired in Chrome 145 and is ignored since.
// SearchContentSharingSettings replaced LensOverlaySettings in Chrome 147; the
// older policies stay set for Chrome builds that still honor them.
const policies = [
  { key: "SearchContentSharingSettings", type: "-int", value: "1" },
  { key: "LensOverlaySettings", type: "-int", value: "1" },
  { key: "LensRegionSearchEnabled", type: "-bool", value: "false" },
  { key: "LensDesktopNTPSearchEnabled", type: "-bool", value: "false" },
] as const;
const usage = `Usage:
  bootstrap/darwin/configure-chrome.ts [options]

Disables Google Lens and its "Ask Google" toolbar chip for every Chrome profile
through macOS-managed Chrome policy, and enables Chrome's native vertical tabs
in the local Chrome "Local State" file and in every profile's Preferences
file, where it also unpins the Tab groups and Tab search buttons, and turns
off the hold-Command-Q-to-quit prompt. It seeds
Default when no profile exists yet. Quit Chrome before running this script
so Chrome does not overwrite the Local State change on exit; policies refresh
in a running Chrome.

Options:
  --state PATH       Chrome Local State path
  --disable          remove the flag override, Chrome settings, and Lens policies
  --allow-running    write even when Chrome appears to be running
  -h, --help`;

const program = Effect.gen(function* () {
  let statePath =
    process.env.CHROME_LOCAL_STATE ||
    `${process.env.HOME || ""}/Library/Application Support/Google/Chrome/Local State`;
  let mode: "disable" | "enable" = "enable";
  let allowRunning = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--state") {
      const value = args[index + 1];
      if (!value) return yield* fail("--state requires a value", 2);
      statePath = value;
      index += 1;
    } else if (argument === "--disable") {
      mode = "disable";
    } else if (argument === "--allow-running") {
      allowRunning = true;
    } else if (argument === "-h" || argument === "--help") {
      yield* Console.log(usage);
      return;
    } else {
      yield* Console.error(usage);
      return yield* fail(`unsupported argument ${argument}`, 2);
    }
  }

  const runner = yield* CommandRunner;
  for (const policy of policies) {
    const args =
      mode === "enable"
        ? ["write", policyDomain, policy.key, policy.type, policy.value]
        : ["delete", policyDomain, policy.key];
    const result = yield* runner.run("defaults", args, {
      output: mode === "enable" ? "inherit" : "ignore",
    });
    if (mode === "enable" && result.status !== 0) {
      return yield* fail(`defaults write ${policyDomain} ${policy.key} exited ${result.status}`);
    }
  }
  const policySummary = policies
    .map((policy) => (mode === "enable" ? `${policy.key}=${policy.value}` : policy.key))
    .join(", ");
  yield* Console.log(
    mode === "enable"
      ? `configured Chrome policies: ${policySummary}`
      : `removed Chrome policies: ${policySummary}`,
  );
  if (!allowRunning) {
    const running = yield* runner.run("pgrep", ["-x", "Google Chrome"]);
    if (running.status === 0) {
      return yield* fail(
        "quit Google Chrome before changing Local State, or rerun with --allow-running",
      );
    }
  }
  for (const flag of flagOverrides) {
    const result = yield* runner.run(
      process.execPath,
      [
        resolve(repoRoot, "bootstrap/darwin/chrome-state.ts"),
        statePath,
        mode,
        flag.name,
        flag.value,
      ],
      { output: "inherit" },
    );
    if (result.status !== 0) {
      return yield* fail(`Chrome Local State update for ${flag.name} exited ${result.status}`);
    }
  }
  const quitPrompt = yield* updateChromeLocalStatePreferencesEffect(statePath, mode);
  yield* Console.log(
    `${mode === "enable" ? "disabled" : "restored"} Chrome hold-to-quit prompt${quitPrompt ? "" : " (unchanged)"}`,
  );
  const profiles = yield* updateChromeProfilesEffect(dirname(statePath), mode);
  yield* Console.log(
    `${mode === "enable" ? "applied" : "cleared"} vertical tabs and tab search pin in ${profiles.updated} of ${profiles.checked} Chrome profiles`,
  );
  const summary = flagOverrides
    .map((flag) => (mode === "enable" ? flag.value : flag.name))
    .join(", ");
  yield* Console.log(
    mode === "enable"
      ? `configured Chrome flags: ${summary} in ${statePath}`
      : `removed Chrome flag overrides: ${summary} in ${statePath}`,
  );
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

runMain(program);
