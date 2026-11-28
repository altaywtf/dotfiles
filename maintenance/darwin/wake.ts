import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";

const graphicsCapability = 0x2;

export function parseFullWake(ioreg: string): boolean | undefined {
  const match = /"System Capabilities" = (\d+)/.exec(ioreg);

  return match ? (Number(match[1]) & graphicsCapability) !== 0 : undefined;
}

const fullWake = Effect.gen(function* () {
  const result = yield* (yield* CommandRunner).run("/usr/sbin/ioreg", [
    "-n",
    "IOPMrootDomain",
    "-r",
    "-d1",
  ]);

  return result.status === 0 ? parseFullWake(result.stdout) : undefined;
}).pipe(Effect.orElseSucceed(() => undefined));

export const awaitFullWake = Effect.fn("awaitFullWake")(function* (
  probe: Effect.Effect<boolean | undefined, never, CommandRunner> = fullWake,
  intervalMs: number = 60_000,
  maxWaitMs: number = 5.5 * 3_600_000,
) {
  const deadline = Date.now() + maxWaitMs;
  let announced = false;

  while (true) {
    if ((yield* probe) !== false) {
      return true;
    }

    if (Date.now() >= deadline) {
      yield* Console.log("The Mac never fully woke; skipping this update slot.");

      return false;
    }

    if (!announced) {
      yield* Console.log("The Mac is in DarkWake; deferring the update until a full wake.");
      announced = true;
    }

    yield* Effect.sleep(intervalMs);
  }
});
