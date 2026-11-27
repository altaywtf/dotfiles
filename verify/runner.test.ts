import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { CommandRunner } from "../lib/command.ts";
import { runChecks } from "./run.ts";

test("verification reports completed checks before a stalled child and cleans it up", async () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-runner-"));
  const pidFile = join(root, "pid");
  const output: Array<string> = [];
  let failedBeforeTermination = false;
  const errorWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      const text = String(chunk);
      output.push(text);
      if (text.includes("FAILED: quick")) {
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), 0);
            failedBeforeTermination = true;
          } catch {
            failedBeforeTermination = false;
          }
        }
      }
      return true;
    });
  try {
    const started = Date.now();
    const result = await Effect.runPromise(
      runChecks(
        [
          {
            id: "quick",
            domain: "static",
            command: [
              process.execPath,
              "-e",
              `
        const fs = require('node:fs');
        setInterval(() => { if (fs.existsSync(${JSON.stringify(pidFile)})) process.exit(7); }, 20);
        setTimeout(() => process.exit(8), 9000);
      `,
            ],
            output: "failure",
          },
          {
            id: "success",
            domain: "static",
            command: [process.execPath, "-e", ""],
            output: "success",
          },
          {
            id: "stalled",
            domain: "static",
            command: [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); require('node:fs').renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)}); process.stdout.write('progress before stall\\n'); process.stderr.write('warning before stall\\n'); setTimeout(() => process.exit(8), 9000)`,
            ],
            output: "timeout",
          },
        ],
        1500,
        3,
      ).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
    );
    assert.equal(result, false);
    assert.equal(failedBeforeTermination, true);
    assert.ok(
      output.join("").indexOf("FAILED: quick") < output.join("").indexOf("FAILED: stalled"),
    );
    assert.match(output.join(""), /progress before stall\n/);
    assert.match(output.join(""), /warning before stall\n/);
    assert.match(output.join(""), /timed out after 1500ms/);
    assert.ok(Date.now() - started < 7000);
    assert.ok(existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    errorWrite.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification bounds active checks and drains queued checks after failure", async () => {
  let active = 0;
  let peak = 0;
  const completed: Array<string> = [];
  const runner = CommandRunner.of({
    run: (command) =>
      Effect.gen(function* () {
        active += 1;
        peak = Math.max(peak, active);
        yield* Effect.yieldNow;
        active -= 1;
        completed.push(command);
        return { status: command === "first" ? 7 : 0, stdout: "", stderr: "" };
      }),
  });
  const checks = ["first", "second", "third", "fourth"].map((id) => ({
    id,
    domain: "static",
    command: [id] as [string],
    output: id,
  }));
  const result = await Effect.runPromise(
    runChecks(checks, 300_000, 2).pipe(Effect.provideService(CommandRunner, runner)),
  );
  assert.equal(result, false);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(completed.sort(), ["first", "fourth", "second", "third"]);
});
