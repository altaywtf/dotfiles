#!/usr/bin/env node

import { NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Schema } from "effect";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandRunner } from "../lib/command.ts";
import { fail, runMain } from "../lib/program.ts";
import { BoundedCommand } from "./bounded-command.ts";
import { awaitFullWake } from "./darwin/wake.ts";
import { dailyLog, rotateUpdateLog } from "./logs.ts";

const Job = Schema.Literal("software-update");
type Job = typeof Job.Type;
const Address = Schema.String.check(Schema.isPattern(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/));
const AlertConfig = Schema.Struct({
  endpoint: Schema.String,
  token: Schema.String.check(Schema.isMinLength(1)),
  from: Address,
  to: Address,
});
const AlertState = Schema.Struct({ failing: Schema.Boolean });
const SendResult = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    delivered: Schema.Array(Schema.String),
    queued: Schema.Array(Schema.String),
    permanent_bounces: Schema.Array(Schema.String),
  }),
});
const PreviousReceipt = Schema.Struct({ cleanupComplete: Schema.optionalKey(Schema.Boolean) });
type Alert = "not-configured" | "not-needed" | "sent" | "failed";

export const runUpdate = Effect.fn("runMonitoredUpdate")(function* (
  job: Job,
  home: string,
  command: string,
  args: readonly string[],
  send: typeof fetch = fetch,
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* BoundedCommand;
  const startedAt = new Date().toISOString();
  const directory = join(home, ".local/state/dotfiles/updates");
  const path = join(directory, `${job}.json`);
  const configPath = join(home, ".config/dotfiles/update-alerts.json");
  const alertStatePath = join(directory, `${job}-alert.json`);
  let alert: Alert = "not-configured";
  yield* Effect.try(() => rotateUpdateLog(home, job)).pipe(
    Effect.catch(() => Console.error("Could not rotate update logs; updates will continue.")),
  );
  const receipt = Effect.fn("writeUpdateReceipt")(
    function* (fields: Record<string, unknown>) {
      const record = `${JSON.stringify({ version: 1, job, startedAt, ...fields })}\n`;
      yield* Console.log(`Update receipt: ${record.trim()}`);
      yield* Effect.gen(function* () {
        const history = yield* Effect.try(() => dailyLog(home, `${job}-history`));
        yield* fs.writeFileString(history, record, { flag: "a", mode: 0o600 });
      }).pipe(
        Effect.catch(() =>
          Console.error("Could not append update history; inspect the update log."),
        ),
      );
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, record, { mode: 0o600 });
      yield* fs.rename(temporary, path);
      return true;
    },
    Effect.catch(() =>
      Console.error("Could not write update receipt; inspect launchd and the update log.").pipe(
        Effect.as(false),
      ),
    ),
  );

  const destination = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(configPath))) return undefined;
    const link = yield* fs.readLink(configPath).pipe(Effect.option);
    const info = yield* fs.stat(configPath);
    if (
      Option.isSome(link) ||
      info.type !== "File" ||
      Option.getOrUndefined(info.uid) !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      return yield* fail("alert config must be an owner-only regular file");
    }
    const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AlertConfig))(
      yield* fs.readFileString(configPath),
    );
    const url = yield* Effect.try(() => new URL(config.endpoint));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return yield* fail(
        "alert endpoints must be HTTPS URLs without credentials, queries, or fragments",
      );
    }
    return config;
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        alert = "failed";
        yield* Console.error(
          "Invalid update alert configuration; updates will continue without alerts.",
        );
        return undefined;
      }),
    ),
  );

  const blocked = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return false;
    const previous = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreviousReceipt))(
      yield* fs.readFileString(path),
    );
    return previous.cleanupComplete === false;
  }).pipe(Effect.catch(() => Effect.succeed(true)));
  if (blocked)
    yield* Console.error(
      "Previous update cleanup is unverified; refusing to start another update.",
    );
  const gateSaved = yield* receipt({ state: "running", cleanupComplete: false });
  if (!gateSaved)
    yield* Console.error("Cannot persist the cleanup gate; refusing to start another update.");
  const execution =
    blocked || !gateSaved
      ? { status: 125, timedOut: false, cleanupComplete: !blocked }
      : yield* runner
          .run(command, args, {
            diagnosticDirectory: join(directory, "diagnostics"),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Console.error("Update command failed to execute.");
                return { status: 127, timedOut: false, cleanupComplete: error.cleanupComplete };
              }),
            ),
          );
  const status = execution.cleanupComplete ? execution.status : execution.status || 1;
  if (execution.timedOut) {
    yield* Console.error("Update exceeded its execution deadline; reporting failure.");
    yield* Console.error(
      "diagnosticPath" in execution && execution.diagnosticPath
        ? `Timeout diagnostics: ${execution.diagnosticPath}`
        : "Timeout diagnostics could not be saved.",
    );
  }
  if (!execution.cleanupComplete)
    yield* Console.error("Update process cleanup is incomplete; inspect before retrying.");
  // Persist cleanup before network delivery: cancellation must not reopen the retry gate.
  yield* receipt({
    state: "running",
    exitCode: status,
    cleanupComplete: execution.cleanupComplete,
    ...(execution.timedOut ? { timedOut: true } : {}),
  });
  if (destination) {
    const failing = status !== 0;
    const notified = yield* fs.readFileString(alertStatePath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AlertState))),
      Effect.map((state) => state.failing),
      Effect.orElseSucceed(() => false),
    );
    if (failing === notified) alert = "not-needed";
    else {
      const host = hostname();
      const subject = failing
        ? `${host}: ${job} failed with exit code ${status}`
        : `${host}: ${job} recovered`;
      const text = [
        failing ? `The scheduled ${job} failed.` : `The scheduled ${job} succeeded again.`,
        "",
        `Host: ${host}`,
        `User: ${userInfo().username}`,
        `Exit code: ${status}`,
        ...(execution.timedOut ? ["Timed out: yes"] : []),
        ...(execution.cleanupComplete ? [] : ["Process cleanup: incomplete"]),
        `Started: ${startedAt}`,
        `Receipt: ${path}`,
        "",
        "Inspect with `mise run maintenance:status` and the update log.",
        "",
      ].join("\n");
      // One attempt only: a timed-out send may have been accepted. An unconfirmed
      // transition stays pending, so the next scheduled run notifies again.
      alert = yield* Effect.tryPromise(async (signal) => {
        const response = await send(destination.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${destination.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: destination.from, to: destination.to, subject, text }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`alert rejected with HTTP ${response.status}`);
        return body.slice(0, 65_536);
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SendResult))),
        Effect.filterOrFail(
          ({ result }) =>
            result.permanent_bounces.length === 0 &&
            [...result.delivered, ...result.queued].includes(destination.to),
        ),
        Effect.andThen(
          fs.writeFileString(alertStatePath, `${JSON.stringify({ failing })}\n`, { mode: 0o600 }),
        ),
        Effect.as("sent" as const),
        Effect.catch(() =>
          Console.error("Update alert delivery failed; the update will not be repeated.").pipe(
            Effect.as("failed" as const),
          ),
        ),
      );
    }
  }
  yield* receipt({
    state: "finished",
    finishedAt: new Date().toISOString(),
    exitCode: status,
    alert,
    ...(execution.timedOut ? { timedOut: true } : {}),
    ...(execution.timedOut || !execution.cleanupComplete
      ? { cleanupComplete: execution.cleanupComplete }
      : {}),
  });
  return status;
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const program = Effect.gen(function* () {
    const [job, separator, command, ...args] = process.argv.slice(2);
    if (!Schema.is(Job)(job) || separator !== "--" || !command || !process.env.HOME) {
      return yield* fail("Usage: run.ts <software-update> -- COMMAND [ARGS...]", 2);
    }
    if (process.platform === "darwin" && !(yield* awaitFullWake())) return;
    process.exitCode = yield* runUpdate(job, process.env.HOME, command, args);
  }).pipe(
    Effect.provide(BoundedCommand.layer),
    Effect.provide(CommandRunner.layer),
    Effect.provide(NodeServices.layer),
  );
  runMain(program);
}
