import { Context, Effect, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliFailure, fail } from "./program.ts";

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  command: Schema.NonEmptyString,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export type CommandResult = {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly stdoutBytes?: Uint8Array;
};

export type CommandOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly extendEnv?: boolean;
  readonly stdin?: "ignore" | "inherit" | Uint8Array;
  readonly output?: "capture" | "inherit" | "ignore";
  readonly timeoutMs?: number;
};

function decode(chunks: ReadonlyArray<Uint8Array>): string {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: (
      command: string,
      args?: ReadonlyArray<string>,
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, CommandError>;
  }
>()("dotfiles/lib/CommandRunner") {
  static readonly layer = Layer.effect(
    CommandRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("CommandRunner.run")(function* (
        command: string,
        args: ReadonlyArray<string> = [],
        options: CommandOptions = {},
      ) {
        const output = options.output ?? "capture";
        const stdout: Array<Uint8Array> = [];
        const stderr: Array<Uint8Array> = [];
        const execution = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: options.cwd,
              env: options.env,
              extendEnv: options.extendEnv ?? true,
              detached: options.stdin !== "inherit",
              forceKillAfter: options.timeoutMs === undefined ? undefined : "5 seconds",
              stdin: Predicate.isUint8Array(options.stdin)
                ? Stream.make(options.stdin)
                : (options.stdin ?? "ignore"),
              stdout: output === "capture" ? "pipe" : output,
              stderr: output === "capture" ? "pipe" : output,
            }),
          );
          if (output !== "capture") {
            return { status: Number(yield* handle.exitCode), stderr: "", stdout: "" };
          }
          const stdoutFiber = yield* Stream.runForEach(handle.stdout, (chunk) =>
            Effect.sync(() => {
              stdout.push(chunk);
            }),
          ).pipe(Effect.forkScoped);
          const stderrFiber = yield* Stream.runForEach(handle.stderr, (chunk) =>
            Effect.sync(() => {
              stderr.push(chunk);
            }),
          ).pipe(Effect.forkScoped);
          const status = Number(yield* handle.exitCode);
          yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)]);
          return {
            status,
            stderr: decode(stderr),
            stdout: decode(stdout),
            stdoutBytes: Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))),
          };
        }).pipe(Effect.scoped);

        const bounded =
          options.timeoutMs === undefined
            ? execution
            : execution.pipe(
                Effect.timeout(options.timeoutMs),
                Effect.catchTag("TimeoutError", () =>
                  Effect.succeed({
                    status: 124,
                    stderr: `${decode(stderr)}\ncommand timed out after ${options.timeoutMs}ms\n`,
                    stdout: decode(stdout),
                  }),
                ),
              );
        return yield* bounded.pipe(
          Effect.mapError(
            (error) => new CommandError({ command, message: String(error), cause: error }),
          ),
        );
      });

      return CommandRunner.of({ run });
    }),
  );
}

export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string> = [],
  options: CommandOptions = {},
): Effect.fn.Return<CommandResult, CliFailure, CommandRunner> {
  const runner = yield* CommandRunner;
  return yield* runner.run(command, args, options).pipe(
    Effect.mapError(
      (error) =>
        new CliFailure({
          exitCode: 1,
          message: `${command} is required or failed to start: ${error.message}`,
        }),
    ),
  );
});

export const runChecked = Effect.fn("runChecked")(function* (
  command: string,
  args: ReadonlyArray<string> = [],
  options: CommandOptions = {},
): Effect.fn.Return<CommandResult, CliFailure, CommandRunner> {
  const result = yield* runCommand(command, args, options);
  if (result.status !== 0) {
    return yield* fail(`${command} exited ${result.status}`, result.status);
  }
  return result;
});
