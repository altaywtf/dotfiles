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

export function managedLockPath(env: NodeJS.ProcessEnv, repoDir: string, kind: LockKind): string {
  const path = managedLockLocation(env, kind);
  const legacy = join(repoDir, "agents", `${kind}.lock.json`);
  if (!existsSync(path) && existsSync(legacy)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, readFileSync(legacy), { mode: 0o600, flag: "wx" });
    rmSync(legacy, { force: true });
  }
  return path;
}

export type OverlayOwnership = { readonly checkout: string; readonly names: readonly string[] };

export function readOverlayOwnership(lockPath: string): OverlayOwnership | undefined {
  const parsed = readLockFile(lockPath, "overlay");
  if (typeof parsed !== "object" || parsed === null || !("overlay" in parsed)) return undefined;
  const overlay = parsed.overlay;
  if (
    typeof overlay !== "object" ||
    overlay === null ||
    !("checkout" in overlay) ||
    typeof overlay.checkout !== "string" ||
    !("names" in overlay) ||
    !Array.isArray(overlay.names) ||
    !overlay.names.every((name: unknown) => typeof name === "string")
  ) {
    throw new Error(`Invalid managed lock at ${lockPath}: overlay needs a checkout and names`);
  }
  return { checkout: overlay.checkout, names: overlay.names };
}

// The local overlay is checkout-local while the lock is per user, so another
// checkout without an overlay must not prune what the owning checkout's overlay installed.
export function guardOverlay(
  previous: OverlayOwnership | undefined,
  repoDir: string,
  overlayNames: readonly string[] | undefined,
): { readonly kept: ReadonlySet<string>; readonly next: OverlayOwnership | undefined } {
  const checkout = realpathSync(repoDir);
  if (overlayNames !== undefined)
    return { kept: new Set(), next: { checkout, names: [...overlayNames] } };
  if (previous === undefined || previous.checkout === checkout)
    return { kept: new Set(), next: undefined };
  return { kept: new Set(previous.names), next: previous };
}
