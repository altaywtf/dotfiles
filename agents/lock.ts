import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
export function managedLockLocation(env: NodeJS.ProcessEnv, kind: LockKind): string {
  if (!env.HOME) throw new Error(`HOME is required to locate the managed ${kind} lock`);
  return join(
    env.XDG_STATE_HOME || join(env.HOME, ".local/state"),
    "dotfiles/agents",
    `${kind}.lock.json`,
  );
}

type LockKind = "skills" | "plugins" | "mcps";

// A checkout's main worktree holds the lock older syncs wrote there, so the
// first sync from a linked worktree still imports that ownership.
function legacyCheckouts(repoDir: string): string[] {
  const common = spawnSync(
    "git",
    ["-C", repoDir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const main = common.status === 0 ? common.stdout.trim() : "";
  return main.endsWith("/.git") ? [repoDir, dirname(main)] : [repoDir];
}

export function managedLockPath(env: NodeJS.ProcessEnv, repoDir: string, kind: LockKind): string {
  const path = managedLockLocation(env, kind);
  const legacy = legacyCheckouts(repoDir)
    .map((checkout) => join(checkout, "agents", `${kind}.lock.json`))
    .find((candidate) => existsSync(candidate));
  if (!existsSync(path) && legacy !== undefined) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, readFileSync(legacy), { mode: 0o600, flag: "wx" });
    rmSync(legacy, { force: true });
  }
  return path;
}

// Overlay-owned names per checkout that installed them.
export type OverlayOwnership = Readonly<Record<string, readonly string[]>>;

export function readOverlayOwnership(lockPath: string): OverlayOwnership | undefined {
  const parsed = readLockFile(lockPath, "overlay");
  if (typeof parsed !== "object" || parsed === null || !("overlays" in parsed)) return undefined;
  const overlays = parsed.overlays;
  if (
    typeof overlays !== "object" ||
    overlays === null ||
    Array.isArray(overlays) ||
    !Object.values(overlays).every(
      (names) => Array.isArray(names) && names.every((name) => typeof name === "string"),
    )
  ) {
    throw new Error(`Invalid managed lock at ${lockPath}: overlays must map checkouts to names`);
  }
  return overlays as OverlayOwnership;
}

// The local overlay is checkout-local while the lock is per user: a sync keeps
// what other existing checkouts' overlays installed and owns only its own.
export function guardOverlay(
  previous: OverlayOwnership | undefined,
  repoDir: string,
  overlayNames: readonly string[] | undefined,
): { readonly kept: ReadonlySet<string>; readonly next: OverlayOwnership | undefined } {
  const checkout = realpathSync(repoDir);
  const others = Object.entries(previous ?? {}).filter(
    ([path]) => path !== checkout && existsSync(path),
  );
  const entries = overlayNames === undefined ? others : [...others, [checkout, [...overlayNames]]];
  return {
    kept: new Set(others.flatMap(([, names]) => names)),
    next: entries.length > 0 ? Object.fromEntries(entries) : undefined,
  };
}
