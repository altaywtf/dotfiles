import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cwd = fileURLToPath(new URL("..", import.meta.url));

function run(program: string) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Effect } from "effect";
    import { fail, runMain } from "./lib/program.ts";
    ${program}
  `,
    ],
    { cwd, encoding: "utf8", timeout: 10_000 },
  );
}

test("typed CLI failures retain their message and exit code", () => {
  const result = run('runMain(fail("invalid command", 2));');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "FAILED: invalid command\n");
});

test("unexpected defects produce a failure diagnostic", () => {
  const result = run('runMain(Effect.sync(() => { throw new Error("unexpected defect"); }));');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED:.*unexpected defect/s);
});

test("SIGTERM interrupts the CLI and completes finalizers without reporting a defect", () => {
  const result = run(`
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
    runMain(Effect.never.pipe(Effect.ensuring(Effect.sync(() => process.stdout.write("finalized")))));
  `);

  assert.equal(result.status, 130);
  assert.equal(result.stdout, "finalized");
  assert.equal(result.stderr, "");
});
