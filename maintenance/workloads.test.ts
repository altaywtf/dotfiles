import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vite-plus/test";
import { CommandError, CommandRunner } from "../lib/command.ts";
import { classifyWorkloads, inspectWorkloads, parseProcesses } from "./workloads.ts";

test("workload classification needs specific evidence and never emits argv", async () => {
  const { rows, skipped } = await Effect.runPromise(
    parseProcesses(`
11 1 21-01:02:03 /sdk/bin/java GradleWorkerMain 'Gradle Test Executor 1' secret-value
12 99 21-01:02:03 /sdk/bin/java GradleWorkerMain 'Gradle Test Executor 2'
13 1 02:00 /bin/node /private/tmp/test-daemon.ts --token=secret-value
14 1 02:00 /bin/node /app/t3/server.js --token=secret-value
15 1 02:00 /bin/node /app/codex/server.js
16 1 02:00 /bin/bun /app/production.ts
17 1 02:00 /bin/postgres -D /tmp/test-db
18 1 02:00 /bin/postgres -D /data/production
19 1 02:00 /bin/adb -L tcp:localhost:5037 fork-server server
20 1 02:00 /bin/watchman --statefile=secret-value
21 1 02:00 /bin/limactl hostagent /home/example/.colima/_lima/colima/config.yaml
22 1 02:00 /bin/limactl hostagent /home/example/.lima/other/config.yaml
23 1 24-02:00:00 /bin/node /app/long-running.js
24 1 00:01 /bin/postgres -D /opt/postgres/latest/data
25 1 00:01 /bin/node /app/server.js --socket /tmp/app.sock --token=unrelated-test-value
26 1 00:01 /bin/postgres -D /Users/example/.pg0/instances/app-test/data
27 1 00:01 /bin/bun /private/tmp/executor-family.x/apps/cli/src/main.ts daemon run
28 1 00:01 /bin/node /tmp/server.js --token=unrelated-test-value
`),
  );
  assert.equal(skipped, 0);
  const findings = classifyWorkloads(rows);
  assert.deepEqual(
    findings.map((finding) => finding.pid),
    [11, 13, 17, 19, 20, 21, 26, 27],
  );
  assert.equal(findings[0]?.ageSeconds, 21 * 86400 + 3723);
  assert.doesNotMatch(JSON.stringify(findings), /secret-value|\/home|\/tmp|\/sdk|token/);
});

test("partial parse retains safe findings and reports incomplete inspection", async () => {
  const calls: string[][] = [];
  const runner = CommandRunner.of({
    run: (command, args = [], options) => {
      calls.push([command, ...args]);
      assert.equal(options?.timeoutMs, 5000);
      return Effect.succeed({
        status: 0,
        stdout: "11 1 00:01 /bin/watchman\nmalformed secret-value\n12 1 00:99 /bin/adb server",
        stderr: "secret-value",
      });
    },
  });
  const report = await Effect.runPromise(
    inspectWorkloads("darwin", 501).pipe(Effect.provideService(CommandRunner, runner)),
  );
  assert.equal(report.complete, false);
  assert.match(report.lines.join("\n"), /Watchman: PID 11/);
  assert.match(report.lines.join("\n"), /2 process rows/);
  assert.doesNotMatch(report.lines.join("\n"), /secret-value/);
  assert.deepEqual(calls, [["/bin/ps", "-U", "501", "-ww", "-o", "pid=,ppid=,etime=,args="]]);
});
for (const failure of ["spawn", "exit"] as const) {
  test(`failed ps ${failure} is unknown and sanitized`, async () => {
    const runner = CommandRunner.of({
      run: () =>
        failure === "spawn"
          ? Effect.fail(new CommandError({ command: "ps", message: "secret-value" }))
          : Effect.succeed({ status: 1, stdout: "secret-value", stderr: "secret-value" }),
    });
    const report = await Effect.runPromise(
      inspectWorkloads("darwin", 501).pipe(Effect.provideService(CommandRunner, runner)),
    );
    assert.equal(report.complete, false);
    assert.match(report.lines.join("\n"), /unknown/);
    assert.doesNotMatch(report.lines.join("\n"), /secret-value/);
  });
}
test("unsupported platforms and root do not inspect processes", async () => {
  const runner = CommandRunner.of({
    run: () => {
      throw new Error("must not execute");
    },
  });
  for (const [platform, uid] of [
    ["linux", 501],
    ["darwin", 0],
  ] as const) {
    const report = await Effect.runPromise(
      inspectWorkloads(platform, uid).pipe(Effect.provideService(CommandRunner, runner)),
    );
    assert.equal(report.complete, false);
  }
});

test("empty process snapshot is unknown", async () => {
  const runner = CommandRunner.of({
    run: () => Effect.succeed({ status: 0, stdout: "", stderr: "" }),
  });
  const report = await Effect.runPromise(
    inspectWorkloads("darwin", 501).pipe(Effect.provideService(CommandRunner, runner)),
  );
  assert.equal(report.complete, false);
  assert.match(report.lines.join("\n"), /unknown: no usable process rows/);
  assert.doesNotMatch(report.lines.join("\n"), /No matching/);
});
