import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vite-plus/test";
import { runProcess } from "./probes.ts";

const processOptions = { cwd: process.cwd(), env: process.env, timeoutMs: 200 };

test("finite probes kill a child that ignores TERM and preserve output", async () => {
  const started = performance.now();
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => {});
    process.stdout.write('progress:' + process.pid);
    process.stderr.write('warning');
    setTimeout(() => process.exit(9), 1600);
  `,
    ],
    processOptions,
  );
  const elapsed = performance.now() - started;
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /^progress:\d+$/);
  const pid = Number(result.stdout.slice("progress:".length));
  // Signal zero only checks existence; never clean fixtures up by a saved PID.
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(result.stderr, "warning");
  assert.ok(elapsed < 1000, `finite probe took ${elapsed}ms`);
  assert.equal(result.status, 1);
});

test("finite probes stop draining inherited pipes and preserve the direct child's exit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "maintenance-pipes-"));
  const done = join(directory, "done");
  t.onTestFinished(async () => {
    try {
      // The descendant self-expires; wait for its exit using only read-only PID existence checks.
      const deadline = performance.now() + 5000;
      while (true) {
        try {
          const pid = Number(await readFile(done, "utf8"));
          process.kill(pid, 0);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error)) {
            throw error;
          }
          if (error.code === "ESRCH") {
            break;
          }
          if (error.code !== "ENOENT") {
            throw error;
          }
        }
        assert.ok(performance.now() < deadline, "descendant did not finish");
        await delay(20);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const descendant = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(done)}, String(process.pid)); process.exit(0); }, 1600)`;
  const started = performance.now();
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] }).unref();
    process.stdout.write('parent output');
    process.stderr.write('parent warning');
    process.exitCode = 7;
  `,
    ],
    processOptions,
  );
  const elapsed = performance.now() - started;
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "parent output");
  assert.equal(result.stderr, "parent warning");
  assert.ok(elapsed < 1000, `inherited pipes took ${elapsed}ms`);
});

test("a TERM handler exiting successfully still reports timeout", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => { process.stdout.write('term'); process.exit(0); });
    setTimeout(() => process.exit(9), 1600);
  `,
    ],
    processOptions,
  );
  assert.deepEqual(result, { status: 0, stdout: "term", stderr: "", timedOut: true });
});

test("ordinary exits and spawn failures retain their result", async () => {
  for (const status of [0, 7]) {
    const result = await runProcess(
      process.execPath,
      [
        "-e",
        `process.stdout.write('out'); process.stderr.write('err'); process.exitCode = ${status};`,
      ],
      { ...processOptions, timeoutMs: 2000 },
    );
    assert.deepEqual(result, { status, stdout: "out", stderr: "err", timedOut: false });
  }
  const result = await runProcess("/nonexistent/maintenance-fixture", [], processOptions);
  assert.equal(result.status, 127);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(result.error instanceof Error);
  assert.ok("code" in result.error);
  assert.equal(result.error.code, "ENOENT");
});

test("null timeout waits for completion without signalling the child", async () => {
  const result = await runProcess(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => process.stderr.write('unexpected TERM'));
    setTimeout(() => { process.stdout.write('finished'); process.exit(7); }, 1200);
  `,
    ],
    { ...processOptions, timeoutMs: null },
  );
  assert.deepEqual(result, { status: 7, stdout: "finished", stderr: "", timedOut: false });
});

test("canceling a probe with no timeout reaps it without reporting timeout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "maintenance-scan-cancel-"));
  const ready = join(directory, "pid");
  const controller = new AbortController();
  const completion = runProcess(
    process.execPath,
    [
      "-e",
      `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setTimeout(() => process.exit(9), 5000);
  `,
    ],
    { ...processOptions, timeoutMs: null, signal: controller.signal },
  );
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = performance.now() + 4000;
  let pid: number | undefined;
  while (pid === undefined) {
    try {
      pid = Number(await readFile(ready, "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      assert.ok(performance.now() < deadline, "probe did not start");
      await delay(20);
    }
  }
  controller.abort();
  const result = await completion;
  assert.equal(result.timedOut, false);
  assert.match(result.error?.message ?? "", /canceled/);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
