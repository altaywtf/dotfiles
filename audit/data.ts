#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { Effect } from "effect";
import { runMain } from "../lib/program.ts";
import { sqlitePageStats } from "./codex-storage.ts";
import { findingLocators, summarizeFindings } from "./secrets/findings.ts";

function usage(): never {
  process.stderr.write(
    "Usage: audit/data.ts sqlite-stats PATH | gitleaks-locators ROOT REPORT | gitleaks-summary POLICY RULE_COUNTS SEVERITY_COUNTS REPORT\n",
  );
  process.exit(2);
}

function main(args: Array<string>): void {
  const [command, ...values] = args;

  if (command === "sqlite-stats" && values.length === 1) {
    process.stdout.write(`${sqlitePageStats(values[0]).join(" ")}\n`);
  } else if (command === "gitleaks-locators" && values.length === 2) {
    const locators = findingLocators(values[0], values[1]);

    if (locators.length > 0) {
      process.stdout.write(`${locators.join("\n")}\n`);
    }
  } else if (command === "gitleaks-summary" && values.length === 4) {
    const result = summarizeFindings(values[1], values[2], values[3], values[0]);
    process.stdout.write(
      `${result.findingCount} ${result.failures} ${result.warnings} ${JSON.stringify(result.rules)} ${JSON.stringify(result.severities)}\n`,
    );
  } else {
    usage();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  runMain(Effect.try({ try: () => main(process.argv.slice(2)), catch: (error) => error }));
}
