import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit } from "effect";
import { test, type TestContext } from "vite-plus/test";
import { CommandRunner } from "../lib/command.ts";
import { BoundedCommand, type BoundedCommandOptions } from "./bounded-command.ts";

type Runner = Parameters<typeof CommandRunner.of>[0];

// Runs `command` under the real layers; `wrap` may replace the process inventory runner.
const bounded = (
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
  wrap: (real: Runner) => Runner = (real) => real,
) =>
  Effect.gen(function* () {
    const real = yield* CommandRunner;
    return yield* Effect.gen(function* () {
      return yield* (yield* BoundedCommand).run(command, args, options);
    }).pipe(
      Effect.provide(BoundedCommand.layer),
      Effect.provideService(CommandRunner, CommandRunner.of(wrap(real))),
    );
  }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
const execute = (script: string, options: BoundedCommandOptions, wrap?: (real: Runner) => Runner) =>
  bounded(process.execPath, ["-e", script], options, wrap);

async function diagnostics(t: TestContext, prefix = "dotfiles-bounded-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "diagnostics");
}

const clean = { timedOut: false, diagnosticPath: undefined, cleanupComplete: true };

async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Fixture did not start");
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// The fixtures ignore SIGTERM; they exit once the test worker is gone so a
// failed cleanup cannot outlive the run and hold the runner's process group open.
const untilWorkerExits = `setInterval(()=>{try{process.kill(${process.pid},0)}catch{process.exit(0)}},500)`;
const treeScript = (path: string) => `
const {spawn}=require('node:child_process');
const script = "require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(path)}) + ",String(process.pid)); process.on('SIGTERM',()=>{}); " + ${JSON.stringify(untilWorkerExits)};
spawn(process.execPath,['-e',script],{detached:true,stdio:'ignore'}).unref();
process.on('SIGTERM',()=>{}); ${untilWorkerExits};
`;

for (const status of [0, 23]) {
  test(`bounded updates preserve exit ${status}`, async (t) => {
    const diagnosticDirectory = await diagnostics(t);
    assert.deepEqual(
      await Effect.runPromise(
        execute(`process.exit(${status})`, { diagnosticDirectory, timeoutMs: 2_000 }),
      ),
      { status, ...clean },
    );
  });
}

test("a command that exits before the first inventory still proves cleanup", async (t) => {
  const diagnosticDirectory = await diagnostics(t);
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await Effect.runPromise(
      bounded("/bin/sh", ["-c", "exit 0"], { diagnosticDirectory, timeoutMs: 2_000 }),
    );
    assert.deepEqual(result, { status: 0, ...clean });
  }
});

test("a command that dies before release still returns", { timeout: 10_000 }, async (t) => {
  const diagnosticDirectory = await diagnostics(t);
  // Kill the gate shell during the first inventory, before it is released.
  let armed = true;
  const exit = await Effect.runPromise(
    bounded(
      "/bin/sh",
      ["-c", "exit 0"],
      { diagnosticDirectory, timeoutMs: 2_000, termGraceMs: 50 },
      (real) => ({
        run: (command, args, options) =>
          armed && command === "/bin/ps"
            ? Effect.gen(function* () {
                armed = false;
                const gates = yield* real.run("pgrep", ["-x", "-P", String(process.pid), "sh"]);
                for (const pid of gates.stdout.split("\n").filter(Boolean))
                  process.kill(Number(pid), "SIGKILL");
                yield* Effect.sleep(200);
                return yield* real.run(command, args, options);
              })
            : real.run(command, args, options),
      }),
    ).pipe(Effect.exit),
  );
  assert.ok(Exit.isFailure(exit) || exit.value.status !== 0);
});

for (const diagnosticFailure of [false, true]) {
  test(`timeout cleans a detached TERM-resistant child with diagnostics ${diagnosticFailure ? "unavailable" : "available"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dotfiles-bounded-"));
    const pidFile = join(directory, "child.pid");
    const diagnosticDirectory = join(directory, "diagnostics");
    if (diagnosticFailure) await writeFile(diagnosticDirectory, "blocked");
    const unrelated = spawn(process.execPath, ["-e", untilWorkerExits], {
      stdio: "ignore",
    });
    t.onTestFinished(async () => {
      unrelated.kill("SIGKILL");
      try {
        process.kill(await waitForPid(pidFile), "SIGKILL");
      } catch {}
      await rm(directory, { recursive: true, force: true });
    });
    const completion = Effect.runPromise(
      execute(treeScript(pidFile), {
        diagnosticDirectory,
        timeoutMs: 700,
        termGraceMs: 50,
        pollIntervalMs: 30,
      }),
    );
    const child = await waitForPid(pidFile);
    const result = await completion;
    assert.equal(result.status, 124);
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(alive(child), false);
    assert.equal(unrelated.exitCode, null);
    assert.ok(unrelated.pid && alive(unrelated.pid));
    if (diagnosticFailure) assert.equal(result.diagnosticPath, undefined);
    else {
      assert.ok(result.diagnosticPath);
      const content = await readFile(result.diagnosticPath, "utf8");
      assert.ok(JSON.parse(content).processes.some((row: { pid: number }) => row.pid === child));
      assert.doesNotMatch(content, /setInterval|SIGTERM|child.pid|PATH=/);
      if (process.platform === "darwin") {
        const stacks = JSON.parse(content).stacks;
        assert.ok(stacks.length > 0);
        assert.match(stacks[0].callGraph, /^Call graph:/);
        assert.doesNotMatch(stacks[0].callGraph, /Binary Images:/);
      }
      assert.equal((await stat(result.diagnosticPath)).mode & 0o777, 0o600);
    }
    const next = await Effect.runPromise(
      execute("process.exit(0)", { diagnosticDirectory, timeoutMs: 2_000 }),
    );
    assert.equal(next.status, 0);
  });
}

test("cancellation cleans a detached child before returning", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dotfiles-bounded-"));
  const pidFile = join(directory, "child.pid");
  const controller = new AbortController();
  const completion = Effect.runPromiseExit(
    execute(treeScript(pidFile), {
      diagnosticDirectory: join(directory, "diagnostics"),
      timeoutMs: 10_000,
      termGraceMs: 50,
      pollIntervalMs: 30,
    }),
    { signal: controller.signal },
  );
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    try {
      process.kill(await waitForPid(pidFile), "SIGKILL");
    } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  const child = await waitForPid(pidFile);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  assert.equal(Exit.isFailure(await completion), true);
  assert.equal(alive(child), false);
});

const invalidRow = () => Effect.succeed({ status: 0, stdout: "invalid process row", stderr: "" });

test("unavailable process inventory reports incomplete cleanup", async (t) => {
  const result = await Effect.runPromise(
    execute(
      "setInterval(()=>{},1000)",
      {
        diagnosticDirectory: await diagnostics(t),
        timeoutMs: 100,
        termGraceMs: 10,
        pollIntervalMs: 10,
      },
      () => ({ run: invalidRow }),
    ),
  );
  assert.equal(result.status, 124);
  assert.equal(result.cleanupComplete, false);
  assert.equal(result.diagnosticPath, undefined);
});

test("a transient inventory failure does not void cleanup proof", async (t) => {
  let first = true;
  const result = await Effect.runPromise(
    execute(
      "process.exit(0)",
      { diagnosticDirectory: await diagnostics(t), timeoutMs: 2_000 },
      (real) => ({
        run: (command, args, options) =>
          Effect.suspend(() => {
            if (command !== "/bin/ps" || !first) return real.run(command, args, options);
            first = false;
            return invalidRow();
          }),
      }),
    ),
  );
  assert.deepEqual(result, { status: 0, ...clean });
});

test("a missed root identity cannot certify cleanup even when the command exits normally", async (t) => {
  const result = await Effect.runPromise(
    execute(
      "process.exit(0)",
      { diagnosticDirectory: await diagnostics(t), timeoutMs: 2_000 },
      () => ({ run: () => Effect.succeed({ status: 0, stdout: "", stderr: "" }) }),
    ),
  );
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupComplete, false);
});

test("a system account reported with a negative UID does not invalidate the update inventory", async (t) => {
  const result = await Effect.runPromise(
    execute(
      "setTimeout(() => {}, 100)",
      { diagnosticDirectory: await diagnostics(t), timeoutMs: 2_000 },
      (real) => ({
        run: (command, args, options) =>
          real.run(command, args, options).pipe(
            Effect.map((result) =>
              command === "/bin/ps"
                ? {
                    ...result,
                    stdout: `${result.stdout}\n999999 1 -2 Sun Sep 20 10:53:05 2026 S 0.0\n`,
                  }
                : result,
            ),
          ),
      }),
    ),
  );
  assert.equal(result.status, 0);
  assert.equal(result.cleanupComplete, true);
});
