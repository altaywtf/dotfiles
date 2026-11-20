import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { acquireDirectoryLock } from "../lib/lock.ts";
import { dirname, join } from "node:path";
import { Option, Schema } from "effect";

import { decodeOr, readJsonFile } from "./decode.ts";

export function readLockFile(lockPath: string, label: string): Schema.Json | undefined {
  if (!existsSync(lockPath)) {
    return undefined;
  }
  return readJsonFile(lockPath, `Invalid managed ${label} lock at ${lockPath}`);
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

export function managedLockLocation(env: NodeJS.ProcessEnv, kind: LockKind): string {
  if (!env.HOME) {
    throw new Error(`HOME is required to locate the managed ${kind} lock`);
  }
  return join(env.HOME, ".local/state/dotfiles/agents", `${kind}.lock.json`);
}

type LockKind = "skills" | "plugins" | "mcps";

export function withManagedLock<T>(env: NodeJS.ProcessEnv, kind: LockKind, sync: () => T): T {
  const directory = dirname(managedLockLocation(env, kind));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireDirectoryLock(join(directory, `${kind}.sync.lock`), {
    waitMs: 15 * 60_000,
  });
  try {
    return sync();
  } finally {
    release();
  }
}

const OverlayOwnership = Schema.Record(Schema.String, Schema.Array(Schema.String));
export type OverlayOwnership = typeof OverlayOwnership.Type;

const OverlayLock = Schema.Struct({ overlays: Schema.Unknown });

export function readOverlayOwnership(lockPath: string): OverlayOwnership | undefined {
  return Schema.decodeUnknownOption(OverlayLock)(readLockFile(lockPath, "overlay")).pipe(
    Option.map(({ overlays }) =>
      decodeOr(
        OverlayOwnership,
        overlays,
        `Invalid managed lock at ${lockPath}: overlays must map checkouts to names`,
      ),
    ),
    Option.getOrUndefined,
  );
}

type OverlayGuard = {
  readonly kept: ReadonlySet<string>;
  readonly next: OverlayOwnership | undefined;
};

export function guardOverlay(
  previous: OverlayOwnership | undefined,
  repoDir: string,
  overlayNames: ReadonlyArray<string> | undefined,
): OverlayGuard {
  const checkout = realpathSync(repoDir);
  const others = Object.entries(previous ?? {}).filter(
    ([path]) => path !== checkout && existsSync(path),
  );
  const entries =
    overlayNames === undefined ? others : others.concat([[checkout, [...overlayNames]]]);
  return {
    kept: new Set(others.flatMap(([, names]) => names)),
    next: entries.length > 0 ? Object.fromEntries(entries) : undefined,
  };
}
