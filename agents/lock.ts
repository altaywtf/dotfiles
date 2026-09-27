import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "./runtime.ts";

export function readLockFile(lockPath: string, label: string): unknown {
  if (!existsSync(lockPath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid managed ${label} lock at ${lockPath}: ${errorMessage(error)}`);
  }
}

export function writeLockFile(lockPath: string, value: unknown): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(lockPath), ".lock-"));
  const temporaryLock = join(temporaryDirectory, "lock.json");

  try {
    writeFileSync(temporaryLock, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryLock, lockPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

// Ownership outlives the checkout: provisioning can apply from a temporary clone
// that is deleted afterwards, and a lost lock would strand retired assets.
export function managedLockPath(
  env: NodeJS.ProcessEnv,
  repoDir: string,
  kind: "skills" | "plugins" | "mcps",
): string {
  if (!env.HOME) throw new Error(`HOME is required to locate the managed ${kind} lock`);
  const name = `${kind}.lock.json`;
  const path = join(env.XDG_STATE_HOME || join(env.HOME, ".local/state"), "dotfiles/agents", name);
  const legacy = join(repoDir, "agents", name);
  if (!existsSync(path) && existsSync(legacy)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, readFileSync(legacy), { mode: 0o600, flag: "wx" });
    rmSync(legacy, { force: true });
  }
  return path;
}
