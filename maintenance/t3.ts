#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const release = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (name: string) => (release.exec(name) ?? []).slice(1).map(Number);

export function newestT3(home: string): string | undefined {
  const root = join(home, ".t3/runtime/versions");
  let names: Array<string>;
  try {
    names = readdirSync(root);
  } catch {
    return undefined;
  }
  const newest = names
    .filter((name) => release.test(name) && existsSync(join(root, name, "t3")))
    .toSorted((a, b) => {
      const [left, right] = [parts(a), parts(b)];
      return (
        (left[0] ?? 0) - (right[0] ?? 0) ||
        (left[1] ?? 0) - (right[1] ?? 0) ||
        (left[2] ?? 0) - (right[2] ?? 0)
      );
    })
    .at(-1);
  return newest && join(root, newest, "t3");
}

export function stageT3Update(home: string): number {
  const t3 = newestT3(home);
  if (!t3) {
    process.stdout.write("T3 Code: no runtime on this host\n");
    return 0;
  }
  const result = spawnSync(t3, ["update"], { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error) {
    process.stderr.write(`T3 Code update failed to start: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = stageT3Update(homedir());
}
