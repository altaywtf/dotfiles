import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { sqlitePageStats } from "./codex-storage.ts";

function sqliteHeader(pageCount = 2, freelistCount = 1, pageSize = 4096): Buffer {
  const file = Buffer.alloc(pageCount * pageSize);
  file.write("SQLite format 3\0", 0, "binary");
  file.writeUInt16BE(pageSize, 16);
  file.writeUInt32BE(7, 24);
  file.writeUInt32BE(pageCount, 28);
  file.writeUInt32BE(freelistCount, 36);
  file.writeUInt32BE(7, 92);
  file.writeUInt32BE(3_007_000, 96);

  return file;
}

test("SQLite stats validate the header without opening the database", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-data-"));

  try {
    const path = join(root, "logs.sqlite");
    writeFileSync(path, sqliteHeader());
    assert.deepEqual(sqlitePageStats(path), [4096, 2, 1]);
    writeFileSync(path, sqliteHeader(2, 3));
    assert.throws(() => sqlitePageStats(path), /inconsistent SQLite header/);
    writeFileSync(path, sqliteHeader(2, 0, 256));
    assert.throws(() => sqlitePageStats(path), /invalid SQLite page size/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
