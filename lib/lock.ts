// Cooperative directory locks for unattended maintenance jobs.
// This module must stay dependency-free: converge.ts acquires its lock before
// the checkout's locked dependencies are installed.
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

const ownerFileName = "owner.json";
// os.uptime() rounds independently in each process and the kernel clock can
// step (NTP) between the owner's boot-time sample and ours, so only a clearly
// earlier boot marks a stale owner. Empirical limit: an NTP step larger than
// this tolerance during boot misclassifies a live owner from the current boot
// as pre-boot and skips its pid probe.
const bootSkewMs = 300_000;
const initialRetryDelayMs = 5_000;
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

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another Unix user (the devbox checkout
    // lock is shared across users); only ESRCH proves the recorded owner is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// Fail closed: unreadable, malformed, or partial owner metadata keeps the lock.
function ownerFileAlive(path: string, probe: LockProbe): boolean {
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
  if (typeof metadata !== "object" || metadata === null) return true;
  const { pid, bootTime } = metadata as { pid?: unknown; bootTime?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
  if (typeof bootTime !== "number" || !Number.isFinite(bootTime)) return true;
  const currentBoot = (probe.now?.() ?? Date.now()) - (probe.uptimeMs?.() ?? uptime() * 1000);
  // Recorded before the current boot: the pid belongs to an unrelated process by now.
  if (bootTime < currentBoot - bootSkewMs) return false;
  return (probe.processAlive ?? processAlive)(pid);
}

export function lockOwnerAlive(lock: string, probe: LockProbe = {}): boolean {
  return ownerFileAlive(join(lock, ownerFileName), probe);
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Take over a lock whose owner looked dead. Ownership transfers by atomically
// renaming the owner file to a contender-private name inside the lock
// directory: rename is atomic, so exactly one contender moves a given file and
// every other one gets ENOENT. The directory itself stays in place, so no
// mkdir can slip in meanwhile and a lock without an owner file fails closed
// for other readers. The moved file is re-judged race-free: a contender that
// judged an owner file which a faster reclaimer has since replaced moves the
// new holder's live file instead and hands it back through a non-clobbering
// link. Keeping the private name inside the directory means a holder's
// recursive release also discards any in-flight hand-back.
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
  try {
    linkSync(moved, owner);
  } catch {
    // EEXIST: the holder already rewrote its file; ENOENT: the holder released.
  }
  rmSync(moved, { force: true });
  return "lost";
}

// Create `lock`, recording this process as its owner. A held lock whose recorded
// owner is provably gone (dead pid or pre-boot metadata) is reclaimed once;
// remaining contention retries with backoff until `waitMs` elapses, then fails loudly.
export function acquireDirectoryLock(lock: string, options: LockOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const log =
    options.log ??
    ((message: string) => {
      console.error(message);
    });
  const deadline = now() + (options.waitMs ?? 0);
  let reclaimed = false;
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
    } catch (cause) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // Keep the original failure; the owner-less directory stays for inspection.
      }
      throw cause;
    }
    return () => {
      rmSync(lock, { recursive: true, force: true });
    };
  };
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (!reclaimed && !lockOwnerAlive(lock, options)) {
        log(`reclaiming stale lock left by a dead process: ${lock}`);
        if (reclaimOwner(lock, options) === "won") {
          reclaimed = true;
          return writeOwner();
        }
        // Another contender won the reclaim (and now holds the lock) or the
        // holder released; the wait path observes either outcome.
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(`lock is held by an active process: ${lock}`);
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
