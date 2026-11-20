import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Option } from "effect";
import type { AuditReport } from "./report.ts";
import { walkFiles } from "./paths.ts";

export function sqlitePageStats(path: string): [number, number, number] {
  const header = Buffer.alloc(100);
  const descriptor = openSync(path, "r");
  let bytesRead: number;
  try {
    bytesRead = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const fileSize = statSync(path).size;
  if (bytesRead < 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") {
    throw new Error("invalid SQLite header");
  }
  let pageSize = header.readUInt16BE(16);
  if (pageSize === 1) {
    pageSize = 65_536;
  }
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error("invalid SQLite page size");
  }
  const changeCounter = header.readUInt32BE(24);
  const pageCount = header.readUInt32BE(28);
  const freelistCount = header.readUInt32BE(36);
  const validFor = header.readUInt32BE(92);
  const version = header.readUInt32BE(96);
  const expectedSize = pageCount * pageSize;
  if (
    changeCounter !== validFor ||
    version < 3_007_000 ||
    pageCount === 0 ||
    freelistCount > pageCount ||
    expectedSize > fileSize ||
    fileSize > expectedSize + pageSize
  ) {
    throw new Error("inconsistent SQLite header");
  }
  return [pageSize, pageCount, freelistCount];
}

function humanBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount < 10 && unit > 0 ? amount.toFixed(1).replace(/\.0$/, "") : Math.floor(amount)}${units[unit]}`;
}

function numericEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function checkLogFile(path: string, env: NodeJS.ProcessEnv, report: AuditReport): void {
  const physical = statSync(path).size;
  const failBytes = numericEnv(env, "CODEX_LOG_FAIL_BYTES", 524_288_000);
  const warnBytes = numericEnv(env, "CODEX_LOG_WARN_BYTES", 209_715_200);
  const stats = Option.getOrUndefined(Option.liftThrowable(sqlitePageStats)(path));
  if (!stats) {
    report.finding(
      physical >= failBytes ? "fail" : physical >= warnBytes ? "warn" : "ok",
      physical >= warnBytes
        ? `${path} is larger than ${humanBytes(physical >= failBytes ? failBytes : warnBytes)} (physical size; SQLite stats unavailable)`
        : `${path} size is under ${humanBytes(warnBytes)} (physical size; SQLite stats unavailable)`,
    );
    return;
  }
  const [pageSize, pageCount, freelistCount] = stats;
  const live = (pageCount - freelistCount) * pageSize;
  const reclaimable = freelistCount * pageSize;
  const ratio = Math.floor((freelistCount * 100) / pageCount);
  const detail = `physical=${humanBytes(physical)} live=${humanBytes(live)} reclaimable=${humanBytes(reclaimable)} freelist=${ratio}%`;
  if (live >= failBytes) {
    return report.finding(
      "fail",
      `${path} live data is larger than ${humanBytes(failBytes)} (${detail})`,
    );
  }
  if (live >= warnBytes) {
    report.finding("warn", `${path} live data is larger than ${humanBytes(warnBytes)} (${detail})`);
  }
  const reclaimWarn = numericEnv(env, "CODEX_LOG_RECLAIM_WARN_BYTES", 209_715_200);
  const ratioWarn = numericEnv(env, "CODEX_LOG_FREELIST_WARN_RATIO", 50);
  const floor = numericEnv(env, "CODEX_LOG_RECLAIM_FLOOR_BYTES", 52_428_800);
  const highReclaim = reclaimable >= reclaimWarn || (ratio >= ratioWarn && reclaimable >= floor);
  if (highReclaim) {
    report.finding("warn", `${path} has high reclaimable SQLite space (${detail})`);
  }
  if (live < warnBytes && !highReclaim) {
    report.finding("ok", `${path} size is healthy (${detail})`);
  }
}

export function checkCodexStorage(root: string, env: NodeJS.ProcessEnv, report: AuditReport): void {
  if (!existsSync(root)) {
    return;
  }
  for (const path of walkFiles(root, 0, (path) =>
    report.warn(`audit coverage skipped: ${path}`),
  ).filter((value) => /^logs.*\.sqlite(?:-wal)?$/.test(basename(value)))) {
    checkLogFile(path, env, report);
  }
}
