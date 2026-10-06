import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { logDirectory } from "./logs.ts";
import { hygiene, readState } from "./hygiene.ts";
import { join } from "node:path";
import { test } from "vite-plus/test";

test("applied hygiene retains successive reports when stdout is not redirected", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "hygiene-log-"));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".local/state/dotfiles");
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  for (let pass = 0; pass < 2; pass++) {
    writeFileSync(
      join(directory, "hygiene.json"),
      JSON.stringify({ lastRun: 0, lastCache: now, candidates: {} }),
    );
    await hygiene(home, true, true, now + pass);
  }
  const path = join(logDirectory(home), `hygiene-${new Date(now).toISOString().slice(0, 10)}.log`);
  const log = readFileSync(path, "utf8");
  assert.equal(log.match(/"startedAt"/g)?.length, 2);
  assert.equal(log.match(/Cache cleanup is not due/g)?.length, 2);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  await hygiene(home, true, true, now + 2);
  assert.equal(readFileSync(path, "utf8"), log, "skipped runs do not append");
});
test("undecodable hygiene state is treated as empty so cleanup can continue", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hygiene-state-")));
  try {
    const statePath = join(root, "hygiene.json");
    const empty = { lastRun: 0, lastCache: 0, candidates: {} };
    assert.deepEqual(readState(statePath), { state: empty, recovered: false });
    writeFileSync(statePath, "{ not json");
    assert.deepEqual(readState(statePath), { state: empty, recovered: true });
    writeFileSync(statePath, JSON.stringify({ wrong: "shape" }));
    assert.deepEqual(readState(statePath), { state: empty, recovered: true });
    const valid = {
      lastRun: 5,
      lastCache: 6,
      candidates: { key: { head: "a".repeat(40), since: 7 } },
    };
    writeFileSync(statePath, JSON.stringify(valid));
    assert.deepEqual(readState(statePath), { state: valid, recovered: false });
    // A directory at the state path is neither missing nor undecodable JSON: it must not bypass the scheduled interval.
    const directoryPath = join(root, "state-directory.json");
    mkdirSync(directoryPath);
    assert.throws(() => readState(directoryPath), { code: "EISDIR" });
    if (process.getuid?.() !== 0) {
      chmodSync(statePath, 0o000);
      assert.throws(() => readState(statePath), { code: "EACCES" });
      chmodSync(statePath, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(
    `hygiene ${signal} waits for cache child cancellation and releases its lock`,
    { skip: process.getuid?.() === 0, timeout: 10_000 },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), "hygiene-signal-"));
      const bin = join(home, "bin");
      mkdirSync(bin);
      const ready = join(home, "ready");
      const stopped = join(home, "stopped");
      const lock = join(home, ".local/state/dotfiles/hygiene.lock");
      writeFileSync(
        join(bin, "df"),
        `#!${process.execPath}\n
      const fs = require('node:fs');
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped');
        process.exit(0);
      }, 50));
      fs.writeFileSync(${JSON.stringify(ready + ".tmp")}, String(process.pid));
      fs.renameSync(${JSON.stringify(ready + ".tmp")}, ${JSON.stringify(ready)});
      setInterval(() => {}, 1000);
    `,
        { mode: 0o755 },
      );
      let childPid: number | undefined;
      let watcher: ReturnType<typeof watch> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const childReady = new Promise<void>((resolveReady, reject) => {
        watcher = watch(home, (_event, filename) => {
          if (filename !== "ready") return;
          childPid = Number(readFileSync(ready, "utf8"));
          clearTimeout(timer);
          watcher?.close();
          resolveReady();
        });
        timer = setTimeout(() => reject(new Error("synthetic cache child did not start")), 5000);
      });
      const parent = spawn(
        process.execPath,
        [join(import.meta.dirname, "hygiene.ts"), "--dry-run"],
        {
          env: { ...process.env, HOME: home, PATH: bin },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      parent.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      parent.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveClosed, reject) => {
          parent.once("error", reject);
          parent.once("close", (code, exitSignal) => resolveClosed({ code, signal: exitSignal }));
        },
      );
      t.onTestFinished(() => {
        clearTimeout(timer);
        watcher?.close();
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
        if (childPid !== undefined) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
        rmSync(home, { recursive: true, force: true });
      });
      await childReady;
      assert.equal(existsSync(lock), true);
      parent.kill(signal);
      assert.deepEqual(await closed, { code: null, signal }, output);
      assert.equal(existsSync(stopped), true, "parent waits for the child termination handler");
      assert.equal(
        existsSync(lock),
        false,
        "the hygiene finally block releases the lock before exit",
      );
      const reapedPid = childPid;
      assert.ok(reapedPid !== undefined);
      assert.throws(() => process.kill(reapedPid, 0), { code: "ESRCH" });
      childPid = undefined;
      assert.equal(
        existsSync(join(home, ".local/state/dotfiles/hygiene.json")),
        false,
        "cancellation never marks cleanup successful",
      );
    },
  );
}
