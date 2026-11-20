#!/usr/bin/env node

import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { runMain } from "../lib/program.ts";
import { AuditReport } from "./report.ts";
import type { AuditFormat } from "./report.ts";
import { canAccess, runCommand } from "./runtime.ts";
import type { AuditDependencies, CommandResult } from "./runtime.ts";

export type HostAuditOptions = {
  format: AuditFormat;
  allowSudoPrompt: boolean;
  minHardeningIndex?: number;
  keepArtifacts?: string;
};

const usage = `Usage:
  node audit/host.ts [options]

Runs a non-destructive host security audit with Lynis.

Options:
  --allow-sudo-prompt        run Lynis through sudo for deeper OS checks
  --min-hardening-index N    fail when Lynis reports a lower hardening index
  --keep-artifacts DIR       copy the Lynis report/log there for manual review
  --json                     print a machine-readable summary instead of prose
  -h, --help
`;

function reportValue(report: string, key: string): string {
  return (
    report
      .split("\n")
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? ""
  );
}

function reportEntries(report: string, key: string): Array<{ id: string; text: string }> {
  return report
    .split("\n")
    .filter((line) => line.startsWith(`${key}[]=`))
    .map((line) => {
      const [id = "unknown", text = ""] = line.slice(key.length + 3).split("|");
      return { id, text };
    });
}

function positiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`invalid ${option}: ${value}`);
  }
  return Number(value);
}

export function parseHostArgs(args: readonly string[]): HostAuditOptions | "help" {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      "allow-sudo-prompt": { type: "boolean" },
      "min-hardening-index": { type: "string" },
      "keep-artifacts": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    return "help";
  }
  return {
    format: values.json ? "json" : "text",
    allowSudoPrompt: values["allow-sudo-prompt"] ?? false,
    minHardeningIndex:
      values["min-hardening-index"] === undefined
        ? undefined
        : positiveInteger(values["min-hardening-index"], "--min-hardening-index"),
    keepArtifacts: values["keep-artifacts"],
  };
}

export function runHostAudit(options: HostAuditOptions, dependencies: AuditDependencies = {}) {
  const env = { ...process.env, ...dependencies.env };
  const command = dependencies.command ?? runCommand;
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value: string) => process.stderr.write(value));
  const report = new AuditReport(options.format, stdout, stderr);
  const uid = dependencies.uid ?? process.getuid?.() ?? 1;
  let lynisVersion = "";
  let hardeningIndex = 0;
  let testsPerformed = 0;
  let warningEntries: Array<{ id: string; text: string }> = [];
  let suggestionEntries: Array<{ id: string; text: string }> = [];
  let privileged = false;

  report.section("host security audit");
  let temporaryDirectory = "";
  try {
    const temporaryRoot = env.TMPDIR || tmpdir();
    mkdirSync(temporaryRoot, { recursive: true });
    temporaryDirectory = mkdtempSync(join(temporaryRoot, "dotfiles-lynis."));
    chmodSync(temporaryDirectory, 0o700);
    const reportFile = join(temporaryDirectory, "lynis-report.dat");
    const logFile = join(temporaryDirectory, "lynis.log");
    writeFileSync(reportFile, "", { mode: 0o600 });
    writeFileSync(logFile, "", { mode: 0o600 });
    const args = [
      "audit",
      "system",
      "--quick",
      "--no-colors",
      "--report-file",
      reportFile,
      "--log-file",
      logFile,
    ];
    const commandOptions = {
      output: options.format === "json" ? ("discard" as const) : ("capture" as const),
      timeoutMs: 600_000,
    };
    let result: CommandResult | undefined;
    let executable = "lynis";
    if (uid !== 0 && options.allowSudoPrompt) {
      const availability = command("lynis", ["--version"], { output: "discard" });
      if (availability.error?.message.includes("ENOENT")) {
        report.fail("lynis is missing");
      } else {
        privileged = true;
        executable = "sudo";
        result = command("sudo", ["lynis", ...args], commandOptions);
      }
    } else {
      result = command("lynis", args, commandOptions);
      privileged = uid === 0 && !result.error?.message.includes("ENOENT");
    }

    const started = result?.error === undefined && result !== undefined;
    if (result) {
      if (result.error?.message.includes("ENOENT")) {
        report.fail(`${executable} is missing`);
      } else if (result.error) {
        report.fail(`lynis could not start: ${result.error.message}`);
      } else {
        if (uid !== 0 && !options.allowSudoPrompt) {
          report.warn(
            "running Lynis without sudo; rerun with --allow-sudo-prompt for deeper OS checks",
          );
        }
        if (result.status !== 0) {
          report.fail(`lynis exited with status ${result.status ?? "unknown"}`);
          if (options.format === "text") {
            stderr(`${result.stdout}\n${result.stderr}`.split("\n").slice(0, 40).join("\n") + "\n");
          }
        }
      }
    }

    if (started && !canAccess(reportFile, constants.R_OK)) {
      report.fail("lynis did not write a report file");
    } else if (started) {
      const contents = readFileSync(reportFile, "utf8");
      if (!contents) {
        report.fail("lynis did not write a report file");
      } else {
        lynisVersion = reportValue(contents, "lynis_version") || "unknown";
        hardeningIndex = Number(reportValue(contents, "hardening_index")) || 0;
        testsPerformed = Number(reportValue(contents, "lynis_tests_done")) || 0;
        warningEntries = reportEntries(contents, "warning");
        suggestionEntries = reportEntries(contents, "suggestion");
        if (warningEntries.length > 0) {
          report.warn(`lynis reported ${warningEntries.length} warnings`);
        } else {
          report.ok("lynis reported no warnings");
        }
        if (options.minHardeningIndex !== undefined && hardeningIndex < options.minHardeningIndex) {
          report.fail(
            `lynis hardening index ${hardeningIndex} is below ${options.minHardeningIndex}`,
          );
        } else {
          report.ok(`lynis hardening index ${hardeningIndex}`);
        }
        if (options.format === "text") {
          stdout(
            `lynis tests performed: ${testsPerformed}\nlynis suggestions: ${suggestionEntries.length}\n`,
          );
          for (const [title, entries] of [
            ["Lynis warnings", warningEntries],
            ["Top Lynis suggestions", suggestionEntries],
          ] as const) {
            if (entries.length === 0) {
              continue;
            }
            stdout(`\n${title}:\n`);
            for (const entry of entries.slice(0, 10)) {
              stdout(`  - ${entry.id}: ${entry.text}\n`);
            }
          }
        }
      }
    }

    if (options.keepArtifacts) {
      mkdirSync(options.keepArtifacts, { recursive: true, mode: 0o700 });
      chmodSync(options.keepArtifacts, 0o700);
      if (canAccess(reportFile, constants.R_OK)) {
        copyFileSync(reportFile, join(options.keepArtifacts, "lynis-report.dat"));
      }
      if (canAccess(logFile, constants.R_OK)) {
        copyFileSync(logFile, join(options.keepArtifacts, "lynis.log"));
      }
      if (options.format === "text") {
        report.warn(
          `kept full Lynis artifacts under ${options.keepArtifacts}; review before sharing`,
        );
      }
    }
  } catch (error) {
    report.fail(`host audit failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  return report.finish("host-security", "host security audit summary", {
    lynis_version: lynisVersion,
    hardening_index: hardeningIndex,
    tests_performed: testsPerformed,
    lynis_warnings: warningEntries.length,
    lynis_suggestions: suggestionEntries.length,
    privileged,
  });
}

function main(args: readonly string[]): number {
  try {
    const options = parseHostArgs(args);
    if (options === "help") {
      process.stdout.write(usage);
      return 0;
    }
    return runHostAudit(options).status;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runMain(
    Effect.try({ try: () => main(process.argv.slice(2)), catch: (error) => error }).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          process.exitCode = status;
        }),
      ),
      Effect.asVoid,
    ),
  );
}
