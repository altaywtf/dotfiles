import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

const ownerFileName = "owner.json";

function succeeds(action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    return false;
  }
}
const bootSkewMs = 300_000;
const initialRetryDelayMs = 5000;
const maxRetryDelayMs = 60_000;

export type LockProbe = {
  readonly now?: () => number;
  readonly uptimeMs?: () => number;
  readonly processAlive?: (pid: number) => boolean;
};

export type LockOptions = LockProbe & {
  readonly waitMs?: number;
  readonly sleep?: (ms: number) => void;
  readonly log?: (message: string) => void;
};

const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function ownerFileAlive(path: string, probe: LockProbe): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
  if (typeof metadata !== "object" || metadata === null) {
    return true;
  }
  const { pid, bootTime } = metadata as { pid?: unknown; bootTime?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  if (typeof bootTime !== "number" || !Number.isFinite(bootTime)) {
    return true;
  }
  const currentBoot = (probe.now?.() ?? Date.now()) - (probe.uptimeMs?.() ?? uptime() * 1000);
  if (bootTime < currentBoot - bootSkewMs) {
    return false;
  }
  return (probe.processAlive ?? processAlive)(pid);
}

export function lockOwnerAlive(lock: string, probe: LockProbe = {}): boolean {
  return ownerFileAlive(join(lock, ownerFileName), probe);
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimOwner(lock: string, probe: LockProbe): "won" | "lost" {
  const owner = join(lock, ownerFileName);
  const moved = join(lock, `${ownerFileName}.reclaim.${process.pid}`);
  try {
    renameSync(owner, moved);
  } catch {
    return "lost";
  }
  if (!ownerFileAlive(moved, probe)) {
    rmSync(moved, { force: true });
    return "won";
  }
  succeeds(() => linkSync(moved, owner));
  rmSync(moved, { force: true });
  return "lost";
}

export function acquireDirectoryLock(lock: string, options: LockOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const deadline = now() + (options.waitMs ?? 0);
  let announced = false;
  let delay = initialRetryDelayMs;
  const owner = join(lock, ownerFileName);
  const writeOwner = () => {
    const metadata = {
      pid: process.pid,
      bootTime: now() - (options.uptimeMs?.() ?? uptime() * 1000),
    };
    try {
      writeFileSync(owner, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    } catch (error) {
      succeeds(() => rmSync(lock, { recursive: true, force: true }));
      throw error;
    }
    return () => {
      rmSync(lock, { recursive: true, force: true });
    };
  };
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (!lockOwnerAlive(lock, options)) {
        log(`reclaiming stale lock left by a dead process: ${lock}`);
        if (reclaimOwner(lock, options) === "won") {
          return writeOwner();
        }
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(`lock is held by an active process: ${lock}`, { cause: error });
      }
      if (!announced) {
        announced = true;
        log(`waiting up to ${Math.ceil(remaining / 60_000)} minutes for ${lock}`);
      }
      sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, maxRetryDelayMs);
      continue;
    }
    return writeOwner();
  }
}
