import { HARNESSES } from "./harness.ts";
import type { Harness } from "./harness.ts";

type HarnessOwned = { harnesses: ReadonlyArray<Harness> };

function staleEntries<P extends HarnessOwned, C extends HarnessOwned>(
  previous: ReadonlyArray<P>,
  current: ReadonlyArray<C>,
  keyOf: (entry: P | C) => string,
): Array<P> {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const stale: Array<P> = [];

  for (const owned of previous) {
    const next = currentByKey.get(keyOf(owned));

    if (next === undefined) {
      stale.push(owned);
      continue;
    }

    const dropped = owned.harnesses.filter((harness) => !next.harnesses.includes(harness));

    if (dropped.length > 0) {
      stale.push({ ...owned, harnesses: dropped });
    }
  }

  return stale;
}

function presentHarnessEntries<T extends HarnessOwned>(
  available: ReadonlyArray<Harness>,
  entries: ReadonlyArray<T>,
): Array<T> {
  return entries.flatMap((entry) => {
    const harnesses = entry.harnesses.filter((harness) => available.includes(harness));

    return harnesses.length > 0 ? [{ ...entry, harnesses }] : [];
  });
}

function retainAbsentEntries<P extends HarnessOwned, C extends HarnessOwned>(
  available: ReadonlyArray<Harness>,
  previous: ReadonlyArray<P>,
  current: ReadonlyArray<C>,
  keyOf: (entry: P | C) => string,
): Array<P> {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const leftover: Array<P> = [];

  for (const owned of previous) {
    const next = currentByKey.get(keyOf(owned));

    if (next === undefined) {
      continue;
    }

    const absent = owned.harnesses.filter(
      (harness) => next.harnesses.includes(harness) && !available.includes(harness),
    );

    if (absent.length > 0) {
      leftover.push({ ...owned, harnesses: absent });
    }
  }

  return leftover;
}

function mergeLockEntries<T extends HarnessOwned>(
  current: ReadonlyArray<T>,
  leftover: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
): Array<T> {
  const byKey = new Map(
    current.map((entry) => [keyOf(entry), { ...entry, harnesses: [...entry.harnesses] }]),
  );

  for (const extra of leftover) {
    const existing = byKey.get(keyOf(extra));

    if (existing === undefined) {
      byKey.set(keyOf(extra), { ...extra, harnesses: [...extra.harnesses] });
      continue;
    }

    existing.harnesses = HARNESSES.filter(
      (harness) => existing.harnesses.includes(harness) || extra.harnesses.includes(harness),
    );
  }

  return [...byKey.values()];
}

type OwnershipPlan<T> = { removals: Array<T>; nextLock: (deferred: ReadonlyArray<T>) => Array<T> };

export function planOwnership<T extends HarnessOwned>(options: {
  previous: ReadonlyArray<T>;
  selected: ReadonlyArray<T>;
  available: ReadonlyArray<Harness>;
  keyOf: (entry: T) => string;
}): OwnershipPlan<T> {
  const { previous, selected, available, keyOf } = options;
  const applied = presentHarnessEntries(available, selected);
  const retained = retainAbsentEntries(available, previous, selected, keyOf);

  return {
    removals: staleEntries(previous, selected, keyOf),
    nextLock: (deferred) => mergeLockEntries(applied, [...deferred, ...retained], keyOf),
  };
}
