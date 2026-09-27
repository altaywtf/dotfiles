#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Disabling keeps the receipts that interrupted-run recovery needs, so interactive
// shells read this marker to stop warning about a schedule nobody expects to run.
export function recordEnrollment(action: string, home: string): void {
  const directory = join(home, ".local/state/dotfiles/updates");
  const marker = join(directory, "software-update.disabled");
  if (action === "enable") rmSync(marker, { force: true });
  if (action === "disable") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(marker, "", { mode: 0o600 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const implementation =
    process.platform === "darwin" ? "./darwin/schedule.ts" : "./linux/schedule.ts";
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, implementation), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.status === 0) recordEnrollment(process.argv[2] ?? "", homedir());
  process.exit(result.status ?? 1);
}
