#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Option, Schema } from "effect";
import { resolve } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";

const ProcessRow = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  ppid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ageSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  command: Schema.NonEmptyString,
});

type ProcessRow = typeof ProcessRow.Type;

type Finding = {
  readonly pid: number;
  readonly ageSeconds: number;
  readonly name: string;
  readonly evidence: string;
};

function elapsedSeconds(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);

  if (!match) {
    return Number.NaN;
  }

  const [, days, hours, minutes, seconds] = match;

  if (Number(minutes) > 59 || Number(seconds) > 59) {
    return Number.NaN;
  }

  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

export const parseProcesses = Effect.fn("parseProcesses")(function* (output: string) {
  const rows: Array<ProcessRow> = [];
  let skipped = 0;

  for (const line of output.split("\n").filter((value) => value.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);

    const decoded = yield* Schema.decodeUnknownEffect(ProcessRow)({
      pid: Number(match?.[1]),
      ppid: Number(match?.[2]),
      ageSeconds: elapsedSeconds(match?.[3] ?? ""),
      command: match?.[4],
    }).pipe(Effect.option);

    if (Option.isSome(decoded)) {
      rows.push(decoded.value);
    } else {
      skipped++;
    }
  }

  return { rows, skipped };
});

export function classifyWorkloads(rows: ReadonlyArray<ProcessRow>): Array<Finding> {
  const findings: Array<Finding> = [];

  for (const row of rows) {
    const executable = /^(?:\S*\/)?([^/\s]+)(?:\s|$)/.exec(row.command)?.[1];
    const arguments_ = row.command.split(/\s+/).slice(1);
    const scriptIndex = executable === "bun" && arguments_[0] === "run" ? 1 : 0;
    const script = arguments_[scriptIndex] ?? "";
    const testMarker = /(?:^|[/_.-])(?:tests?|testing)(?=$|[/_.-])/i;
    const dataDirectory = /(?:^|\s)-D\s+(\S+)/.exec(row.command)?.[1] ?? "";
    let name: string | undefined;
    let evidence = "";

    if (
      executable === "java" &&
      row.ppid === 1 &&
      /\bGradleWorkerMain\b/.test(row.command) &&
      /Gradle Test Executor/.test(row.command)
    ) {
      name = "Gradle test worker";
      evidence = "candidate: test worker adopted by launchd; confirm the test run ended";
    } else if (
      ["bun", "node"].includes(executable ?? "") &&
      row.ppid === 1 &&
      /^(?:\/private)?\/tmp\/.+\.(?:[cm]?js|tsx?)$/.test(script) &&
      (testMarker.test(script) || ["test", "daemon"].includes(arguments_[scriptIndex + 1] ?? ""))
    ) {
      name = "temporary Bun/Node worker";
      evidence =
        "candidate: adopted by launchd with a temporary test/daemon argument; owner and current use unknown";
    } else if (
      executable === "postgres" &&
      (testMarker.test(dataDirectory) || /^(?:\/private)?\/tmp\//.test(dataDirectory))
    ) {
      name = "test PostgreSQL";
      evidence =
        "candidate: data-directory argument resembles a test/temporary database; connected clients unknown";
    } else if (
      (executable === "limactl" || executable === "qemu-system-aarch64") &&
      /(?:colima|\.colima)/.test(row.command)
    ) {
      name = "Colima VM helper";
      evidence = "observed: Colima-related VM process; container count and VM utilization unknown";
    } else if (executable === "adb" && /(?:fork-server|server)/.test(row.command)) {
      name = "ADB server";
      evidence = "observed: background server; attached devices and client use unknown";
    } else if (executable === "watchman") {
      name = "Watchman";
      evidence = "observed: file watcher; watched roots and client use unknown";
    }

    if (name) {
      findings.push({ pid: row.pid, ageSeconds: row.ageSeconds, name, evidence });
    }
  }

  return findings;
}

export const inspectWorkloads = Effect.fn("inspectWorkloads")(function* (
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? -1,
) {
  if (platform !== "darwin") {
    return {
      lines: ["unsupported: workload diagnostics currently require macOS"],
      complete: false,
    };
  }

  if (!Number.isSafeInteger(uid) || uid <= 0) {
    return { lines: ["unknown: run workload diagnostics as a non-root user"], complete: false };
  }

  const runner = yield* CommandRunner;

  const result = yield* runner
    .run("/bin/ps", ["-U", String(uid), "-ww", "-o", "pid=,ppid=,etime=,args="], {
      output: "capture",
      timeoutMs: 5000,
    })
    .pipe(Effect.option);

  if (Option.isNone(result) || result.value.status !== 0) {
    return {
      lines: ["unknown: process inspection failed; no workload conclusion available"],
      complete: false,
    };
  }

  const { rows, skipped } = yield* parseProcesses(result.value.stdout);
  const findings = classifyWorkloads(rows);

  const lines = findings.map(
    (finding) =>
      `${finding.name}: PID ${finding.pid}, age ${Math.floor(finding.ageSeconds / 60)}m — ${finding.evidence}`,
  );

  if (!rows.length) {
    lines.push("unknown: no usable process rows returned");
  } else if (!findings.length) {
    lines.push("No matching development workload processes observed.");
  }

  if (skipped) {
    lines.push(`unknown: ${skipped} process rows could not be inspected`);
  }

  lines.push(
    "Current-user process snapshot only; age does not prove abandonment. No daemon clients contacted, services started, or processes stopped. Container/device/client state remains unknown.",
  );

  return { lines, complete: skipped === 0 && rows.length > 0 };
});

const program = Effect.gen(function* () {
  if (process.argv.length > 2) {
    return yield* fail("Usage: node maintenance/workloads.ts", 2);
  }

  const report = yield* inspectWorkloads();

  for (const line of report.lines) {
    yield* Console.log(line);
  }

  if (!report.complete) {
    return yield* fail("workload inspection incomplete");
  }
}).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  runMain(program);
}
