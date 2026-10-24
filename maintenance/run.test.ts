import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vite-plus/test";
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { NodeServices } from "@effect/platform-node";
import { Effect, Exit, FileSystem } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { BoundedCommand, BoundedCommandError } from "./bounded-command.ts";
import { runUpdate } from "./run.ts";
import { dailyLog, logDirectory, rotateUpdateLog } from "./logs.ts";

const alertConfig = {
  endpoint: "https://mail.example/v4/accounts/fixture/email/sending/send",
  token: "secret-token",
  from: "alerts@example.test",
  to: "admin@example.test",
};

const writeAlertConfig = (home: string, content = JSON.stringify(alertConfig)) =>
  mkdir(join(home, ".config/dotfiles"), { recursive: true }).then(() =>
    writeFile(join(home, ".config/dotfiles/update-alerts.json"), content, { mode: 0o600 }),
  );

const accepted = (overrides: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      success: true,
      result: { delivered: [], queued: [alertConfig.to], permanent_bounces: [], ...overrides },
    }),
    { status: 200 },
  );

type SentAlert = { url: string; token: string | undefined; subject: string; text: string };

const recordingSender = (sent: SentAlert[], respond: () => Response = () => accepted()) =>
  (async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(typeof init?.body, "string");
    const body = JSON.parse(init.body as string);
    assert.equal(body.from, alertConfig.from);
    assert.equal(body.to, alertConfig.to);
    sent.push({
      url: input instanceof Request ? input.url : input.toString(),
      token: new Headers(init?.headers).get("authorization") ?? undefined,
      subject: body.subject,
      text: body.text,
    });
    return respond();
  }) satisfies typeof fetch;

const receiptPath = (home: string) =>
  join(home, ".local/state/dotfiles/updates/software-update.json");
const readReceipt = async (home: string) => JSON.parse(await readFile(receiptPath(home), "utf8"));

async function tempHome(t: TestContext, prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  return home;
}

// Counts launches and finishes each one with `outcome`.
function fixedCommand(outcome: { status: number; timedOut?: boolean; cleanupComplete?: boolean }) {
  const command = {
    executions: 0,
    service: BoundedCommand.of({
      run: () => {
        command.executions++;
        return Effect.succeed({ timedOut: false, cleanupComplete: true, ...outcome });
      },
    }),
  };
  return command;
}

const update = (
  home: string,
  command: Parameters<typeof BoundedCommand.of>[0],
  send?: typeof fetch,
) =>
  runUpdate("software-update", home, "fixture", [], send).pipe(
    Effect.provideService(BoundedCommand, command),
    Effect.provide(NodeServices.layer),
  );

for (const scenario of [
  "success",
  "failure",
  "timeout",
  "spawn",
  "rejected",
  "invalid",
  "unconfigured",
] as const) {
  test(`update reporting preserves ${scenario} without repeating the command`, async (t) => {
    const home = await tempHome(t, "dotfiles-report-");
    if (scenario !== "unconfigured")
      await writeAlertConfig(home, scenario === "invalid" ? "not-json" : undefined);
    let executions = 0;
    const sent: SentAlert[] = [];
    const expected =
      scenario === "failure" || scenario === "rejected"
        ? 23
        : scenario === "spawn"
          ? 127
          : scenario === "timeout"
            ? 124
            : 0;
    const runner = BoundedCommand.of({
      run: () => {
        executions++;
        return scenario === "spawn"
          ? Effect.fail(
              new BoundedCommandError({
                cause: new Error("secret diagnostic"),
                cleanupComplete: true,
              }),
            )
          : Effect.succeed({
              status: expected,
              timedOut: scenario === "timeout",
              cleanupComplete: true,
            });
      },
    });
    const send = recordingSender(sent, () =>
      scenario === "rejected" ? new Response(null, { status: 503 }) : accepted(),
    );
    assert.equal(await Effect.runPromise(update(home, runner, send)), expected);
    assert.equal(executions, 1);
    const receipt = await readFile(receiptPath(home), "utf8");
    assert.doesNotMatch(receipt, /secret-token|secret diagnostic/);
    assert.equal(JSON.parse(receipt).exitCode, expected);
    assert.equal(JSON.parse(receipt).timedOut, scenario === "timeout" ? true : undefined);
    const historyPath = join(
      logDirectory(home),
      `software-update-history-${new Date().toISOString().slice(0, 10)}.log`,
    );
    const history = await readFile(historyPath, "utf8");
    assert.doesNotMatch(history, /secret-token|secret diagnostic/);
    const records = history
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.equal(records[0].state, "running");
    assert.equal(records[0].cleanupComplete, false);
    assert.equal(records[0].startedAt, records[2].startedAt);
    assert.deepEqual(records[2], JSON.parse(receipt));
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(receipt).alert,
      scenario === "rejected" || scenario === "invalid"
        ? "failed"
        : scenario === "unconfigured"
          ? "not-configured"
          : scenario === "success"
            ? "not-needed"
            : "sent",
    );
    const alerted = expected !== 0 && scenario !== "invalid";
    assert.equal(sent.length, alerted ? 1 : 0, "one attempt, never retried");
    if (alerted) {
      assert.equal(sent[0].url, alertConfig.endpoint);
      assert.equal(sent[0].token, "Bearer secret-token");
      assert.match(
        sent[0].subject,
        new RegExp(`software-update failed with exit code ${expected}$`),
      );
      assert.match(sent[0].text, new RegExp(`Exit code: ${expected}\n`));
      assert.doesNotMatch(sent[0].text, /secret-token|secret diagnostic/);
      assert.equal(/Timed out: yes/.test(sent[0].text), scenario === "timeout");
    }
  });
}

test("history write failure does not prevent updates or the latest receipt", async (t) => {
  const home = await tempHome(t, "dotfiles-report-");
  await writeFile(join(home, "Library"), "blocks log directory");
  assert.equal(await Effect.runPromise(update(home, fixedCommand({ status: 23 }).service)), 23);
  assert.equal((await readReceipt(home)).exitCode, 23);
});

test("rotation preserves launchd's append descriptor and expires only owned dated logs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-logs-"));
  t.onTestFinished(() => rm(home, { recursive: true, force: true }));
  const now = Date.parse("2026-09-08T12:00:00Z");
  const history = dailyLog(home, "software-update-history", now);
  const directory = logDirectory(home);
  const active = join(directory, "software-update.log");
  await writeFile(active, "previous run\n", { mode: 0o600 });
  await utimes(active, new Date(now), new Date(now));
  const info = lstatSync(active);
  const archive = join(
    directory,
    `software-update-${info.mtime.toISOString().replaceAll(":", "-")}.log`,
  );
  const expired = join(directory, "hygiene-2026-09-01.log");
  const retained = join(directory, "hygiene-2026-09-02.log");
  const unrelated = join(directory, "another-app-2026-09-01.log");
  await Promise.all(
    [expired, retained, unrelated].map((path) => writeFile(path, "keep unless expired\n")),
  );
  const fd = openSync(active, "a");
  try {
    rotateUpdateLog(home, "software-update", now);
    writeSync(fd, "new run\n");
  } finally {
    closeSync(fd);
  }
  assert.equal(lstatSync(active).ino, info.ino);
  assert.equal(readFileSync(active, "utf8"), "new run\n");
  assert.equal(readFileSync(archive, "utf8"), "previous run\n");
  await assert.rejects(readFile(expired), { code: "ENOENT" });
  assert.ok(await readFile(retained));
  assert.ok(await readFile(unrelated));
  assert.equal(history, join(directory, "software-update-history-2026-09-08.log"));
});

for (const outcome of ["network", 401, 500, "malformed", "unacknowledged", "bounced"] as const) {
  test(`an unconfirmed ${outcome} alert is not retried and stays pending for the next run`, async (t) => {
    const home = await tempHome(t, "dotfiles-alert-outcome-");
    await writeAlertConfig(home);
    const command = fixedCommand({ status: 23 });
    const sent: SentAlert[] = [];
    const failing = recordingSender(sent, () => {
      if (outcome === "network") throw new TypeError("fetch failed");
      if (typeof outcome === "number") return new Response(null, { status: outcome });
      if (outcome === "malformed") return new Response("<html>", { status: 200 });
      return outcome === "bounced"
        ? accepted({ permanent_bounces: [alertConfig.to] })
        : accepted({ queued: [] });
    });
    assert.equal(await Effect.runPromise(update(home, command.service, failing)), 23);
    assert.equal(command.executions, 1);
    assert.equal(sent.length, 1);
    assert.equal((await readReceipt(home)).alert, "failed");
    assert.equal(await Effect.runPromise(update(home, command.service, recordingSender(sent))), 23);
    assert.equal(sent.length, 2, "the next failing run delivers the pending alert");
    assert.equal((await readReceipt(home)).alert, "sent");
  });
}

test("interrupting alert delivery aborts fetch once and keeps the cleanup gate closed", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dotfiles-alert-cancel-"));
  await writeAlertConfig(home);
  let sends = 0;
  let aborted = false;
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const command = fixedCommand({ status: 124, timedOut: true, cleanupComplete: false });
  const send: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      sends++;
      assert.ok(init?.signal);
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
      started.resolve();
    });
  const completion = Effect.runPromiseExit(update(home, command.service, send), {
    signal: controller.signal,
  });
  t.onTestFinished(async () => {
    controller.abort();
    await completion;
    await rm(home, { recursive: true, force: true });
  });
  await started.promise;
  controller.abort();
  assert.equal(Exit.isFailure(await completion), true);
  assert.equal(aborted, true);
  assert.equal(sends, 1);
  assert.equal((await readReceipt(home)).cleanupComplete, false);
  assert.equal(await Effect.runPromise(update(home, command.service, async () => accepted())), 125);
  assert.equal(command.executions, 1);
  assert.equal(sends, 1);
});

test("alerts follow transitions: one failure email, silence while failing, one recovery email", async (t) => {
  const home = await tempHome(t, "dotfiles-update-deadline-");
  await writeAlertConfig(home);
  const sent: SentAlert[] = [];
  const send = recordingSender(sent);
  const execute = (script: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bounded = yield* BoundedCommand;
        return yield* runUpdate(
          "software-update",
          home,
          process.execPath,
          ["-e", script],
          send,
        ).pipe(
          Effect.provideService(
            BoundedCommand,
            BoundedCommand.of({
              run: (command, args, options) =>
                bounded.run(command, args, {
                  ...options,
                  timeoutMs: 1_000,
                  termGraceMs: 100,
                  pollIntervalMs: 50,
                }),
            }),
          ),
        );
      }).pipe(
        Effect.provide(BoundedCommand.layer),
        Effect.provide(CommandRunner.layer),
        Effect.provide(NodeServices.layer),
      ),
    );
  const alertOf = async () => (await readReceipt(home)).alert;
  assert.equal(await execute("process.exit(0)"), 0);
  assert.equal(await alertOf(), "not-needed");
  assert.equal(await execute("setInterval(() => {}, 1000)"), 124);
  const failure = await readReceipt(home);
  assert.equal(failure.state, "finished");
  assert.equal(failure.timedOut, true);
  assert.equal(failure.cleanupComplete, true);
  assert.equal(failure.alert, "sent");
  assert.equal(await execute("process.exit(3)"), 3);
  assert.equal(await alertOf(), "not-needed");
  assert.equal(await execute("process.exit(0)"), 0);
  const recovery = await readReceipt(home);
  assert.equal(recovery.exitCode, 0);
  assert.equal(recovery.timedOut, undefined);
  assert.equal(recovery.alert, "sent");
  assert.equal(await execute("process.exit(0)"), 0);
  assert.equal(await alertOf(), "not-needed");
  assert.deepEqual(
    sent.map(({ subject }) => subject.replace(/^[^:]+: /, "")),
    ["software-update failed with exit code 124", "software-update recovered"],
  );
});

for (const previous of ["incomplete", "unreadable"] as const) {
  test(`a ${previous} cleanup receipt prevents the next update from overlapping`, async (t) => {
    const home = await tempHome(t, "dotfiles-update-blocked-");
    await mkdir(join(home, ".local/state/dotfiles/updates"), { recursive: true });
    await writeFile(
      receiptPath(home),
      previous === "incomplete" ? JSON.stringify({ cleanupComplete: false }) : "invalid",
    );
    const command = fixedCommand({ status: 0 });
    assert.equal(await Effect.runPromise(update(home, command.service)), 125);
    assert.equal(await Effect.runPromise(update(home, command.service)), 125);
    assert.equal(command.executions, 0);
    assert.equal((await readReceipt(home)).cleanupComplete, false);
    await rm(receiptPath(home));
    assert.equal(await Effect.runPromise(update(home, command.service)), 0);
    assert.equal(command.executions, 1);
  });
}

test("a pre-spawn failure remains retryable without removing the receipt", async (t) => {
  const home = await tempHome(t, "dotfiles-update-spawn-");
  const execute = (command: string, args: string[]) =>
    Effect.runPromise(
      runUpdate("software-update", home, command, args).pipe(
        Effect.provide(BoundedCommand.layer),
        Effect.provide(CommandRunner.layer),
        Effect.provide(NodeServices.layer),
      ),
    );
  assert.equal(await execute(join(home, "missing-executable"), []), 127);
  assert.equal((await readReceipt(home)).cleanupComplete, undefined);
  assert.equal(await execute(process.execPath, ["-e", "process.exit(0)"]), 0);
});

// A failed gate write must refuse the launch without leaving a cleanup block.
test("a transient initial receipt failure does not leave a cleanup block for an unstarted command", async (t) => {
  const home = await tempHome(t, "dotfiles-update-transient-storage-");
  let rejectInitialWrite = true;
  const command = fixedCommand({ status: 0 });
  const execute = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* runUpdate("software-update", home, "fixture", []).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, content, options) => {
              if (rejectInitialWrite && path.endsWith(`software-update.json.${process.pid}.tmp`)) {
                rejectInitialWrite = false;
                return fs.writeFileString(home, content, options);
              }
              return fs.writeFileString(path, content, options);
            },
          }),
        );
      }).pipe(
        Effect.provideService(BoundedCommand, command.service),
        Effect.provide(NodeServices.layer),
      ),
    );
  assert.equal(await execute(), 125);
  assert.equal(command.executions, 0);
  assert.notEqual((await readReceipt(home)).cleanupComplete, false);
  assert.equal(await execute(), 0);
  assert.equal(command.executions, 1);
});
