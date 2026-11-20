import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Schema } from "effect";

export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  exitCode: Schema.Int,
  message: Schema.String,
}) {}

export const isCliFailure = Schema.is(CliFailure);

export const fail = (message: string, exitCode = 1): Effect.Effect<never, CliFailure> =>
  Effect.fail(new CliFailure({ exitCode, message }));

export function runMain(program: Effect.Effect<void, unknown>): void {
  program.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.sync(() => {
        const error = cause.reasons.find(Cause.isFailReason)?.error;
        const failure =
          !Cause.hasDies(cause) && isCliFailure(error)
            ? error
            : new CliFailure({
                exitCode: 1,
                message: Cause.hasDies(cause)
                  ? Cause.pretty(cause)
                  : error instanceof Error
                    ? error.message
                    : String(error),
              });
        process.stderr.write(`FAILED: ${failure.message}\n`);
        process.exitCode = failure.exitCode;
      });
    }),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
