import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import { CommandRunner } from "../../lib/command.ts";
import { awaitFullWake, parseFullWake } from "./wake.ts";

test("System Capabilities distinguish a full wake from DarkWake", () => {
  assert.equal(parseFullWake(`      "System Capabilities" = 15\n`), true);
  assert.equal(parseFullWake(`      "System Capabilities" = 9\n`), false);
  assert.equal(parseFullWake("unexpected layout"), undefined);
});

const wait = (states: readonly (boolean | undefined)[], maxWaitMs: number) => {
  let probes = 0;
  const probe = Effect.sync(() => states[Math.min(probes++, states.length - 1)]);
  return Effect.runPromise(
    awaitFullWake(probe, 1, maxWaitMs).pipe(
      Effect.provideService(CommandRunner, CommandRunner.of({ run: () => Effect.die("unused") })),
      Effect.map((proceed) => ({ proceed, probes })),
    ),
  );
};

test("the update waits through DarkWake and runs at the next full wake", async () => {
  assert.deepEqual(await wait([false, false, true], 60_000), { proceed: true, probes: 3 });
});

test("an unreadable wake probe never blocks the update", async () => {
  assert.deepEqual(await wait([undefined], 0), { proceed: true, probes: 1 });
});

test("a slot that never sees a full wake is skipped", async () => {
  assert.equal((await wait([false], 20)).proceed, false);
});
