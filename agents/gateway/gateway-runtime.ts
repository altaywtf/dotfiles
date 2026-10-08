import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, FileSystem, Option, Runtime, Schema } from "effect";
import { accessSync, constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ChildProcessSpawner } from "effect/process";
import { parseGatewayConfig } from "./gateway-config.ts";

class GatewayFailure extends Schema.TaggedError<GatewayFailure>()("GatewayFailure", {
  message: Schema.String,
  exitCode: Schema.optionalKey(Schema.Int),
}) {}

export const failure = (message: string, exitCode = 1) =>
  Effect.fail(new GatewayFailure({ message, exitCode }));
const attempt = <A>(run: () => A, message: string) =>
  Effect.try({ try: run, catch: () => new GatewayFailure({ message }) });

export const readGateway = Effect.fn("readGateway")(function* (home: string) {
  const path = process.env.LLM_GATEWAY_CONFIG || join(home, ".config/dotfiles/llm-gateway.json");
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  if (Option.isSome(link)) return yield* failure("missing regular gateway config");
  const info = yield* fs
    .stat(path)
    .pipe(Effect.mapError(() => new GatewayFailure({ message: "missing regular gateway config" })));
  if (info.type !== "File") return yield* failure("missing regular gateway config");
  if ((info.mode & 0o777) !== 0o600) return yield* failure("gateway config mode must be 0600");
  const contents = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => new GatewayFailure({ message: "could not read gateway config" })));
  const config = yield* attempt(() => parseGatewayConfig(contents), "invalid gateway config");
  return { path, config };
});

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export const replaceProcess = Effect.fn("replaceGatewayProcess")(function* (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = isAbsolute(command)
    ? command
    : (env.PATH || "")
        .split(":")
        .filter((entry) => isAbsolute(entry))
        .map((entry) => join(entry, command))
        .find(executable);
  if (!path || !executable(path)) return yield* failure(`executable unavailable: ${command}`);
  const execve = process.execve?.bind(process);
  if (!execve)
    return yield* failure("gateway adapters require Node with process.execve on macOS or Linux");
  return yield* attempt(() => execve(path, [path, ...args], env), `could not start ${command}`);
});

export const credential = Effect.fn("gatewayCredential")(function* (kind: string, home: string) {
  if (kind !== "gatewai") return yield* failure("usage: llm-gateway-credential gatewai");
  const { config } = yield* readGateway(home);
  return config.credentials.gatewai;
});

export function main(
  program: Effect.Effect<
    void,
    unknown,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >,
): void {
  let signalExitCode: number | undefined;
  const interrupt = () => {
    signalExitCode = 130;
  };
  const terminate = () => {
    signalExitCode = 143;
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide(NodeServices.layer),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.sync(() => {
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          const failure =
            !Cause.hasDies(cause) && Schema.is(GatewayFailure)(error) ? error : undefined;
          process.stderr.write(`FAILED: ${failure?.message ?? "gateway adapter failed"}\n`);
          process.exitCode = failure?.exitCode ?? 1;
        });
      }),
    ),
    {
      disableErrorReporting: true,
      teardown(exit, onExit) {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
        if (signalExitCode !== undefined) return onExit(signalExitCode);
        Runtime.defaultTeardown(exit, onExit);
      },
    },
  );
}
export const print = (value: string) => Console.log(value);
