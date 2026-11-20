import assert from "node:assert/strict";

import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { capLogs } from "./logs.ts";
import { join } from "node:path";
import { test } from "vite-plus/test";

test("log capping rewrites the same inode at a line boundary and keeps append descriptors valid", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "log-cap-")));
  try {
    const logs = join(root, "logs");
    mkdirSync(logs);
    const cap = 4096;
    const big = join(logs, "software-update.log");
    const content =
      Array.from(
        { length: 600 },
        (_, index) => `line ${String(index).padStart(4, "0")} of the update log`,
      ).join("\n") + "\n";
    writeFileSync(big, content);
    writeFileSync(join(logs, "worker.log"), "short\n");
    writeFileSync(join(logs, "notes.txt"), "x".repeat(cap * 2));
    symlinkSync(big, join(logs, "linked.log"));
    const before = statSync(big).ino;
    const appender = openSync(big, "a"); // simulates launchd's held O_APPEND descriptor
    const entries = capLogs(logs, cap);
    assert.deepEqual(
      entries.map((entry) => entry.target),
      [big],
    );
    assert.match(entries[0].result, /^capped from \d+ to \d+ bytes$/);
    const after = statSync(big);
    assert.equal(after.ino, before, "rotation must not replace the inode");
    assert.ok(after.size <= cap);
    const text = readFileSync(big, "utf8");
    assert.ok(content.endsWith(text), "the retained content must be the log tail");
    assert.match(text, /^line \d{4} of the update log/, "the tail must start on a line boundary");
    writeSync(appender, Buffer.from("appended after cap\n"));
    closeSync(appender);
    assert.ok(readFileSync(big, "utf8").endsWith("appended after cap\n"));
    assert.equal(readFileSync(join(logs, "worker.log"), "utf8"), "short\n");
    assert.equal(statSync(join(logs, "notes.txt")).size, cap * 2);
    assert.deepEqual(capLogs(join(root, "missing")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a concurrent append between truncate and the tail write is interleaved, not overwritten", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hygiene-logs-")));
  try {
    const cap = 512;
    const log = join(root, "worker.log");
    writeFileSync(
      log,
      Array.from({ length: 100 }, (_, index) => `line ${String(index).padStart(3, "0")}`).join(
        "\n",
      ) + "\n",
    );
    const appender = openSync(log, "a"); // the other user's live launchd descriptor
    const entries = capLogs(root, cap, () => {
      writeSync(appender, Buffer.from("concurrent append\n"));
    });
    closeSync(appender);
    assert.equal(entries.length, 1);
    const text = readFileSync(log, "utf8");
    assert.ok(
      text.startsWith("concurrent append\n"),
      `the concurrent line must survive: ${JSON.stringify(text.slice(0, 40))}`,
    );
    assert.ok(text.endsWith("line 099\n"), "the retained tail follows the concurrent line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
