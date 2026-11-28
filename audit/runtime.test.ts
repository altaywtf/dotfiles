import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runCommand, runPolicyCommand } from "./runtime.ts";

test("audit capture handles verbose output and fails explicitly beyond its limit", () => {
  const command = ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'];
  const result = runCommand(process.execPath, command);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 2 * 1024 * 1024);
  const limited = runCommand(process.execPath, command, { maxBuffer: 1024 });
  assert.ok(limited.error);
  assert.notEqual(limited.status, 0);

  const discarded = runPolicyCommand(process.execPath, command, {
    output: "discard",
    maxBuffer: 1024,
  });

  assert.equal(discarded.status, 0);
  assert.equal(discarded.stdout, "");
});

test("audit deadlines terminate even children that ignore SIGTERM", () => {
  const started = performance.now();

  const result = runPolicyCommand(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { timeoutMs: 150 },
  );

  assert.equal(result.status, null);
  assert.ok(result.error);
  assert.ok(performance.now() - started < 3000);
});
