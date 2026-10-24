import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const day = 86_400_000;

export function logDirectory(home: string): string {
  const directory =
    process.platform === "darwin"
      ? join(home, "Library/Logs/dotfiles")
      : join(home, ".local/state/dotfiles/logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function pruneLogs(directory: string, now = Date.now()): void {
  const cutoff = new Date(now - 6 * day).toISOString().slice(0, 10);
  for (const name of readdirSync(directory)) {
    const date =
      /^(?:software-update|hygiene)(?:-history)?-(\d{4}-\d{2}-\d{2})(?:T[\d.-]+Z)?\.log$/.exec(
        name,
      )?.[1];
    const path = join(directory, name);
    if (date && date < cutoff && lstatSync(path).isFile()) unlinkSync(path);
  }
}

export function dailyLog(
  home: string,
  name: "software-update-history" | "hygiene",
  now = Date.now(),
): string {
  const directory = logDirectory(home);
  pruneLogs(directory, now);
  return join(directory, `${name}-${new Date(now).toISOString().slice(0, 10)}.log`);
}

export function rotateUpdateLog(home: string, job: "software-update", now = Date.now()): void {
  const directory = logDirectory(home);
  const path = join(directory, `${job}.log`);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("update log must be a regular file");
    if (info.size > 0) {
      const timestamp = info.mtime.toISOString().replaceAll(":", "-");
      copyFileSync(path, join(directory, `${job}-${timestamp}.log`));
      // launchd already holds this inode open for append in the new run.
      truncateSync(path, 0);
    }
  }
  pruneLogs(directory, now);
}

type Entry = { target: string; result: string };

const logCapBytes = 2 * 1024 * 1024;

// launchd opens each job's StandardOutPath/StandardErrorPath with O_APPEND and
// holds that descriptor for the whole run, so the logs append across runs.
// That O_APPEND assumption is empirical: it was
// verified with lsof against a live job, not taken from documentation.
// Rotation must reuse the same inode: a rename or unlink would orphan the live
// descriptor and silently discard all later output. Because writers append,
// the tail is written back through an O_APPEND descriptor too, so a concurrent
// append that lands between our truncate and our write is interleaved rather
// than overwritten (a positional write at offset 0 would clobber it).
// Residual caveat: lines appended
// between the tail read and the truncate are lost.
export function capLogs(
  directory: string,
  cap = logCapBytes,
  between: () => void = () => {},
): Entry[] {
  const entries: Entry[] = [];
  if (!existsSync(directory)) return entries;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".log")) continue;
    const path = join(directory, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size <= cap) continue;
      const fd = openSync(path, "r+");
      try {
        const tail = Buffer.alloc(cap);
        const read = readSync(fd, tail, 0, cap, info.size - cap);
        const newline = tail.indexOf(0x0a);
        const start = newline >= 0 && newline + 1 < read ? newline + 1 : 0; // drop the leading partial line
        ftruncateSync(fd, 0);
        between(); // test hook: a concurrent O_APPEND write landing here must survive
        const appender = openSync(path, "a");
        try {
          writeSync(appender, tail, start, read - start, null);
        } finally {
          closeSync(appender);
        }
      } finally {
        closeSync(fd);
      }
      entries.push({
        target: path,
        result: `capped from ${info.size} to ${lstatSync(path).size} bytes`,
      });
    } catch (error) {
      entries.push({
        target: path,
        result: `log cap failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return entries;
}
