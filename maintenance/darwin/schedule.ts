#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner, runChecked } from "../../lib/command.ts";
import { launchdLabel, resolveLaunchdNamespaceContract } from "../../lib/darwin/launchd.ts";
import { fail, runMain } from "../../lib/program.ts";
import { readPersistedProfile } from "../../profiles/current.ts";

export const updateLabel = "local.dotfiles.software-update";
const usage = "Usage: maintenance/darwin/schedule.ts <enable|disable|run|status>";
// Two six-hour schedule slots plus jitter: an older receipt means the wrapper
// is not running even though the job is loaded (for example a broken node shim).
const staleReceiptMs = 13 * 3600_000;

export type LoadedJob = {
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
};

// Extract ProgramArguments and EnvironmentVariables from `launchctl print` text.
// The format is undocumented, so parsing is defensive: an unrecognized layout
// yields an empty result and the caller reports the comparison as unavailable.
export function parseLaunchdPrint(output: string): LoadedJob {
  const lines = output.split("\n");
  const job: { arguments?: string[]; environment?: Record<string, string> } = {};
  for (let index = 0; index < lines.length; index += 1) {
    // Anchored so "default environment = {" and "inherited environment = {" do not match.
    const open = /^(\s*)(arguments|environment) = {$/.exec(lines[index] ?? "");
    if (!open) continue;
    const [, indent = "", section] = open;
    const items: string[] = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index] === `${indent}}`) {
        closed = true;
        break;
      }
      items.push((lines[index] ?? "").trim());
    }
    if (!closed) return {};
    if (section === "arguments") job.arguments = items;
    else {
      job.environment = Object.fromEntries(
        items.flatMap((item) => {
          const entry = /^(\S+) => (.*)$/.exec(item);
          return entry ? [[entry[1], entry[2]] as const] : [];
        }),
      );
    }
  }
  return job;
}

// launchd injects variables (XPC_SERVICE_NAME, OSLogRateLimit) into a loaded
// job, so the environment check requires every plist variable to be loaded with
// the same value rather than exact equality. Only ProgramArguments and
// EnvironmentVariables are compared; schedule and working-directory drift is
// outside this check, and the status message says so.
export function comparePlist(
  loaded: LoadedJob,
  plist: unknown,
): { comparable: boolean; drift: string[] } {
  const record =
    typeof plist === "object" && plist !== null ? (plist as Record<string, unknown>) : undefined;
  const args = record?.ProgramArguments;
  const loadedArguments = loaded.arguments;
  if (
    !loadedArguments ||
    !Array.isArray(args) ||
    !args.every((argument) => typeof argument === "string")
  ) {
    return { comparable: false, drift: [] };
  }
  const drift: string[] = [];
  if (
    args.length !== loadedArguments.length ||
    args.some((argument, index) => argument !== loadedArguments[index])
  ) {
    drift.push("ProgramArguments differ between the loaded job and the on-disk plist");
  }
  const environment = record?.EnvironmentVariables;
  if (typeof environment === "object" && environment !== null && loaded.environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string" && loaded.environment[key] !== value) {
        drift.push(
          `EnvironmentVariables.${key} differs between the loaded job and the on-disk plist`,
        );
      }
    }
  }
  return { comparable: true, drift };
}

export function receiptWarning(receipt: string | undefined, now: number): string | undefined {
  if (receipt === undefined) {
    return "no update receipt exists; if the job has been loaded past a schedule slot, the wrapper may be failing before it starts (inspect the log and the node shim)";
  }
  let reference: number | undefined;
  try {
    const parsed: unknown = JSON.parse(receipt);
    if (typeof parsed === "object" && parsed !== null) {
      const { startedAt, finishedAt } = parsed as { startedAt?: unknown; finishedAt?: unknown };
      const raw =
        typeof finishedAt === "string"
          ? finishedAt
          : typeof startedAt === "string"
            ? startedAt
            : undefined;
      if (raw !== undefined) reference = Date.parse(raw);
    }
  } catch {
    /* reported below */
  }
  if (reference === undefined || Number.isNaN(reference))
    return "update receipt is unreadable; inspect the log";
  if (now - reference > staleReceiptMs) {
    return `update receipt is older than ${Math.round(staleReceiptMs / 3600_000)} hours; the scheduler may be failing before the wrapper runs (inspect the log and the node shim)`;
  }
  return undefined;
}

const sudoHelper = resolve(
  fileURLToPath(new URL("../../identity/sops-devbox-sudo.ts", import.meta.url)),
);

const systemUpdater = Effect.fn("systemSoftwareUpdater")(function* (home: string, uid: number) {
  const user = (yield* runChecked("id", ["-un", String(uid)])).stdout.trim();
  const namespace = yield* resolveLaunchdNamespaceContract(
    "",
    join(home, ".config/dotfiles/launchd-namespace"),
    uid,
  );
  const label = launchdLabel("software-update", user, namespace);
  return { service: `system/${label}`, plist: `/Library/LaunchDaemons/${label}.plist` };
});

// Starting a system-domain job needs root. Devboxes enrolled in the SOPS sudo
// helper start it unattended; otherwise sudo prompts on a terminal or fails.
const kickstartSystemUpdater = Effect.fn("kickstartSystemSoftwareUpdater")(function* (
  home: string,
  service: string,
  interactive: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* CommandRunner;
  const kickstart = ["/bin/launchctl", "kickstart", service];
  const config = yield* fs
    .readFileString(process.env.DEVBOX_CONFIG || join(home, ".config/dotfiles/devbox.env"))
    .pipe(Effect.orElseSucceed(() => ""));
  const result = /^\s*SOPS_SUDO_SECRET_FILE=\S/m.test(config)
    ? yield* runner.run(process.execPath, [sudoHelper, "--", ...kickstart], {
        stdin: interactive ? "inherit" : "ignore",
        output: "inherit",
      })
    : yield* runner.run("/usr/bin/sudo", [...(interactive ? [] : ["-n"]), "--", ...kickstart], {
        stdin: interactive ? "inherit" : "ignore",
        output: "inherit",
      });
  if (result.status !== 0) {
    return yield* fail(
      `the system updater needs an administrator; run: sudo ${kickstart.join(" ")}`,
      result.status,
    );
  }
});

export const manageSchedule = Effect.fn("manageSoftwareUpdateSchedule")(function* (
  action: string,
  home: string,
  uid: number,
  interactive = process.stdin.isTTY === true,
) {
  if (!["enable", "disable", "run", "status"].includes(action)) return yield* fail(usage, 2);
  if (!home || !home.startsWith("/") || uid <= 0)
    return yield* fail("a non-root macOS user home is required");
  const domain = `gui/${uid}`;
  let service = `${domain}/${updateLabel}`;
  let plist = join(home, `Library/LaunchAgents/${updateLabel}.plist`);
  const logs = join(home, "Library/Logs/dotfiles");
  const log = join(logs, "software-update.log");
  const runner = yield* CommandRunner;
  let current = yield* runner.run("launchctl", ["print", service]);

  if (action === "status") {
    if (current.status !== 0) {
      ({ service, plist } = yield* systemUpdater(home, uid));
      current = yield* runner.run("launchctl", ["print", service]);
    }
    yield* Console.log(`Scheduler: ${service}`);
    yield* Console.log(`Log: ${log}`);
    const fs = yield* FileSystem.FileSystem;
    const receiptPath = join(home, ".local/state/dotfiles/updates/software-update.json");
    const receipt = (yield* fs.exists(receiptPath))
      ? yield* fs.readFileString(receiptPath)
      : undefined;
    if (receipt !== undefined) yield* Console.log(receipt);
    if (current.status !== 0)
      return yield* fail("software maintenance is not loaded in the GUI or system domain");
    yield* Console.log(current.stdout);
    const warning = receiptWarning(receipt, Date.now());
    if (warning) yield* Console.log(`WARNING: ${warning}`);
    if (yield* fs.exists(plist)) {
      const rendered = yield* runner.run("plutil", ["-convert", "json", "-o", "-", plist]);
      const parsed =
        rendered.status === 0
          ? yield* Effect.try(() => JSON.parse(rendered.stdout) as unknown).pipe(Effect.option)
          : Option.none();
      const comparison = Option.isSome(parsed)
        ? comparePlist(parseLaunchdPrint(current.stdout), parsed.value)
        : { comparable: false, drift: [] };
      if (!comparison.comparable) {
        yield* Console.log(
          "Could not compare the loaded job with the on-disk plist; inspect both manually.",
        );
      } else if (comparison.drift.length > 0) {
        for (const entry of comparison.drift) yield* Console.log(`WARNING: ${entry}`);
        yield* Console.log(
          service.startsWith("system/")
            ? "Reload required: wait for the job to be idle, then have an administrator re-enroll the system updater."
            : "Reload required: wait for the job to be idle, then run mise run maintenance:disable and mise run maintenance:enable.",
        );
      } else {
        yield* Console.log(
          "Loaded job arguments and environment match the on-disk plist (schedule and working directory are not compared).",
        );
      }
    } else {
      yield* Console.log(
        `WARNING: managed plist missing at ${plist}; apply dotfiles to render it.`,
      );
    }
    return;
  }
  if (action === "run") {
    // Without -k, kickstart never terminates or replaces an already-running update.
    if (current.status === 0) {
      yield* runChecked("launchctl", ["kickstart", service]);
    } else {
      ({ service } = yield* systemUpdater(home, uid));
      if ((yield* runner.run("launchctl", ["print", service])).status !== 0)
        return yield* fail("enable the scheduler first with mise run maintenance:enable");
      yield* kickstartSystemUpdater(home, service, interactive);
    }
    yield* Console.log(`Update requested; launchd keeps one instance. Log: ${log}`);
    return;
  }
  if (action === "disable") {
    yield* runChecked("launchctl", ["disable", service]);
    if (current.status === 0) yield* runChecked("launchctl", ["bootout", service]);
    // Only an administrator can stop the system updater, and a success here
    // tells shells to stop watching for stalled runs.
    const system = yield* systemUpdater(home, uid);
    if ((yield* runner.run("launchctl", ["print", system.service])).status === 0)
      return yield* fail(
        `system updater still enrolled: ${system.service}; have an administrator disable it`,
      );
    yield* Console.log("Software maintenance disabled; any running update was stopped.");
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  yield* readPersistedProfile(join(home, ".config/dotfiles/profile"), uid);
  const system = yield* systemUpdater(home, uid);
  if (yield* fs.exists(system.plist)) {
    return yield* fail(
      `system updater already enrolled: ${system.service}; use its launchctl commands`,
    );
  }
  const link = yield* fs.readLink(plist).pipe(Effect.option);
  if (Option.isSome(link)) return yield* fail("the managed scheduler plist must not be a symlink");
  const info = yield* fs.stat(plist);
  if (
    info.type !== "File" ||
    Option.getOrUndefined(info.uid) !== uid ||
    (info.mode & 0o022) !== 0
  ) {
    return yield* fail("apply the managed scheduler plist as its owning user first");
  }
  yield* runChecked("plutil", ["-lint", plist]);
  yield* fs.makeDirectory(logs, { recursive: true, mode: 0o700 });
  yield* runChecked("launchctl", ["enable", service]);
  if (current.status !== 0) yield* runChecked("launchctl", ["bootstrap", domain, plist]);
  yield* runChecked("launchctl", ["print", service]);
  yield* Console.log(
    "Software maintenance enabled: every six hours on the hour, local time, and on login/load.",
  );
  if (current.status === 0)
    yield* Console.log(
      "Existing job retained. To load changed plist settings, disable then enable after updates finish.",
    );
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function* () {
    if (process.platform !== "darwin")
      return yield* fail("software maintenance scheduling requires macOS");
    if (process.argv.length !== 3) return yield* fail(usage, 2);
    yield* manageSchedule(process.argv[2], process.env.HOME || "", process.getuid?.() ?? -1);
  }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
  runMain(program);
}
