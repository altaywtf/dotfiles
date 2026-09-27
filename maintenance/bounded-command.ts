import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  constants,
  closeSync,
  fchmodSync,
  openSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { CommandRunner } from "../lib/command.ts";

export class BoundedCommandError extends Schema.TaggedError<BoundedCommandError>()(
  "BoundedCommandError",
  {
    cause: Schema.Defect(),
    cleanupComplete: Schema.Boolean,
  },
) {}

export type BoundedCommandOptions = {
  readonly diagnosticDirectory: string;
  readonly timeoutMs?: number;
  readonly termGraceMs?: number;
  readonly pollIntervalMs?: number;
};
export type BoundedCommandResult = {
  readonly status: number;
  readonly timedOut: boolean;
  readonly diagnosticPath?: string;
  readonly cleanupComplete: boolean;
};
const ProcessRow = Schema.Struct({
  pid: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  ppid: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  uid: Schema.Int,
  started: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)),
  ),
  state: Schema.String,
  cpu: Schema.String,
});
type ProcessRow = typeof ProcessRow.Type;
const gate =
  'read -r _ || exit 125; command -v "$0" >/dev/null 2>&1 || exit 127; exec "$0" "$@" </dev/null';
const release = new TextEncoder().encode("\n");

function parseProcesses(output: string): ProcessRow[] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, uid, day, month, date, time, year, state, cpu] = line.trim().split(/\s+/);
      return Schema.decodeUnknownSync(ProcessRow)({
        pid: Number(pid),
        ppid: Number(ppid),
        uid: Number(uid),
        started: [day, month, date, time, year].join(" "),
        state,
        cpu,
      });
    });
}
function sameProcess(a: ProcessRow, b: ProcessRow): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.started === b.started;
}

export class BoundedCommand extends Context.Service<
  BoundedCommand,
  {
    readonly run: (
      command: string,
      args: readonly string[],
      options: BoundedCommandOptions,
    ) => Effect.Effect<BoundedCommandResult, BoundedCommandError>;
  }
>()("dotfiles/maintenance/BoundedCommand") {
  static readonly layer = Layer.effect(
    BoundedCommand,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runner = yield* CommandRunner;
      const snapshot = runner
        .run("/bin/ps", ["-axo", "pid=,ppid=,uid=,lstart=,stat=,pcpu="], {
          timeoutMs: 2_000,
          env: { LC_ALL: "C" },
        })
        .pipe(
          Effect.flatMap((result) =>
            result.status === 0
              ? Effect.try(() => parseProcesses(result.stdout))
              : Effect.fail(new Error("Process inventory failed")),
          ),
          // One inventory can catch a process mid-exit; only a persistent failure voids cleanup proof.
          Effect.retry({ times: 2, schedule: Schedule.spaced("50 millis") }),
        );
      const run = Effect.fn("BoundedCommand.run")(function* (
        command: string,
        args: readonly string[],
        options: BoundedCommandOptions,
      ) {
        const timeoutMs = options.timeoutMs ?? 60 * 60_000;
        const graceMs = options.termGraceMs ?? 10_000;
        const intervalMs = options.pollIntervalMs ?? 2_000;
        const owned = new Map<number, ProcessRow>();
        let rootPid = 0;
        let completed = false;
        let cleanupComplete = true;
        let inventoryFailed = false;
        let rootInspected = false;
        const observe = Effect.gen(function* () {
          const rows = yield* snapshot.pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                inventoryFailed = true;
              }),
            ),
          );
          const live = new Map(rows.map((row) => [row.pid, row]));
          const root = live.get(rootPid);
          if (!rootInspected && root && root.uid === process.getuid?.()) owned.set(rootPid, root);
          rootInspected = true;
          // Remember identities before descendants can become reparented or start a new session.
          let added = true;
          while (added) {
            added = false;
            for (const row of rows) {
              const parent = owned.get(row.ppid);
              const liveParent = live.get(row.ppid);
              if (
                !owned.has(row.pid) &&
                parent &&
                liveParent &&
                sameProcess(parent, liveParent) &&
                row.uid === parent.uid
              ) {
                owned.set(row.pid, row);
                added = true;
              }
            }
          }
          return rows.filter((row) => {
            const previous = owned.get(row.pid);
            return previous && sameProcess(previous, row) && !row.state.startsWith("Z");
          });
        });
        const signal = Effect.fnUntraced(function* (kind: NodeJS.Signals) {
          const rows = yield* observe;
          for (const row of rows.toReversed()) {
            // Recheck each identity immediately before signaling; never use a process-group kill.
            const current = yield* snapshot;
            if (
              !current.some(
                (candidate) => sameProcess(candidate, row) && !candidate.state.startsWith("Z"),
              )
            )
              continue;
            yield* Effect.try(() => process.kill(row.pid, kind)).pipe(
              Effect.catch(() => Effect.void),
            );
          }
        });
        const cleanup = Effect.gen(function* () {
          yield* signal("SIGTERM");
          yield* Effect.sleep(graceMs);
          yield* signal("SIGKILL");
          yield* Effect.sleep(Math.min(intervalMs, 100));
          cleanupComplete = (yield* observe).length === 0 && owned.has(rootPid) && !inventoryFailed;
        }).pipe(
          Effect.timeout(graceMs + 10_000),
          Effect.catch(() =>
            Effect.sync(() => {
              cleanupComplete = false;
            }),
          ),
        );
        return yield* Effect.gen(function* () {
          // Hold the command until the first inventory records the root; exec keeps its identity.
          const handle = yield* spawner.spawn(
            ChildProcess.make("/bin/sh", ["-c", gate, command, ...args], {
              stdin: "pipe",
              stdout: "inherit",
              stderr: "inherit",
              detached: false,
              killSignal: "SIGKILL",
              forceKillAfter: 1_000,
            }),
          );
          rootPid = Number(handle.pid);
          yield* Effect.addFinalizer(() => (completed ? Effect.void : cleanup));
          yield* observe.pipe(Effect.catch(() => Effect.void));
          // A write to a child that already exited never settles.
          yield* Stream.run(Stream.make(release), handle.stdin).pipe(
            Effect.raceFirst(handle.exitCode),
            Effect.catch(() => Effect.void),
          );
          const watcher = Effect.forever(
            observe.pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.sleep(intervalMs)),
            ),
          );
          const outcome = yield* Effect.raceFirst(
            handle.exitCode.pipe(
              Effect.map((status) => ({ status: Number(status), timedOut: false })),
            ),
            Effect.sleep(timeoutMs).pipe(Effect.as({ status: 124, timedOut: true })),
          ).pipe(Effect.raceFirst(watcher));
          let diagnosticPath: string | undefined;
          if (outcome.timedOut) {
            diagnosticPath = yield* Effect.gen(function* () {
              const rows = yield* observe;
              const stacks: { pid: number; callGraph: string }[] = [];
              if (process.platform === "darwin") {
                for (const row of rows.toReversed().slice(0, 3)) {
                  const current = yield* snapshot;
                  if (!current.some((candidate) => sameProcess(candidate, row))) continue;
                  const sample = yield* runner
                    .run("/usr/bin/sample", [String(row.pid), "1", "1", "-file", "/dev/stdout"], {
                      timeoutMs: 2_000,
                    })
                    .pipe(Effect.option);
                  if (sample._tag === "Some") {
                    const start = sample.value.stdout.indexOf("Call graph:");
                    const end = sample.value.stdout.indexOf("Binary Images:", start);
                    if (start >= 0)
                      stacks.push({
                        pid: row.pid,
                        callGraph: sample.value.stdout
                          .slice(start, end < 0 ? undefined : end)
                          .slice(0, 64 * 1024),
                      });
                  }
                }
              }
              return yield* Effect.try(() => {
                mkdirSync(options.diagnosticDirectory, { recursive: true, mode: 0o700 });
                const directory = lstatSync(options.diagnosticDirectory);
                if (
                  !directory.isDirectory() ||
                  directory.uid !== process.getuid?.() ||
                  (directory.mode & 0o077) !== 0
                )
                  throw new Error("Unsafe diagnostic directory");
                const path = join(options.diagnosticDirectory, "software-update-timeout.json");
                const temporary = `${path}.${process.pid}.tmp`;
                const fd = openSync(
                  temporary,
                  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                  0o600,
                );
                try {
                  try {
                    fchmodSync(fd, 0o600);
                    writeFileSync(
                      fd,
                      JSON.stringify({
                        version: 1,
                        capturedAt: new Date().toISOString(),
                        timeoutMs,
                        processes: rows.slice(0, 256),
                        stacks,
                      }) + "\n",
                    );
                  } finally {
                    closeSync(fd);
                  }
                  renameSync(temporary, path);
                } finally {
                  try {
                    unlinkSync(temporary);
                  } catch {}
                }
                return path;
              });
            }).pipe(
              Effect.timeout(10_000),
              Effect.catch(() => Effect.succeed(undefined)),
            );
            yield* cleanup;
          } else {
            const remaining = yield* observe.pipe(Effect.catch(() => Effect.succeed([])));
            if (remaining.length > 0) yield* cleanup;
            else if (inventoryFailed || !owned.has(rootPid)) cleanupComplete = false;
          }
          completed = true;
          return { ...outcome, diagnosticPath, cleanupComplete };
        }).pipe(
          Effect.scoped,
          Effect.mapError(
            (cause) => new BoundedCommandError({ cause, cleanupComplete: rootPid === 0 }),
          ),
        );
      });
      return BoundedCommand.of({ run });
    }),
  );
}
