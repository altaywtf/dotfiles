import { Console, Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";

// IOPMrootDomain reports kIOPMSystemCapabilityGraphics (0x2) only in a full
// wake; DarkWake and Power Nap run with CPU and network alone.
const graphicsCapability = 0x2;

// True in a full wake, false in DarkWake, undefined when the probe is unusable.
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

// A launchd calendar slot missed during sleep fires in the next DarkWake, where
// the Mac sleeps again within seconds and the run's wall-clock deadline expires.
// Defer until a full wake; give the slot up before the next six-hour slot.
export const awaitFullWake = Effect.fn("awaitFullWake")(function* (
  probe: Effect.Effect<boolean | undefined, never, CommandRunner> = fullWake,
  intervalMs = 60_000,
  maxWaitMs = 5.5 * 3600_000,
) {
  const deadline = Date.now() + maxWaitMs;
  let announced = false;
  while (true) {
    // An unreadable probe must not stop updates.
    if ((yield* probe) !== false) return true;
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
