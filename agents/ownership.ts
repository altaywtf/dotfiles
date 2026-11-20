import { HARNESSES } from "./harness.ts";
import type { Harness } from "./harness.ts";

// Ownership-lock algebra shared by the plugin and MCP syncs. Each lock entry
// records the harness subset the sync owns for one named thing; apply drops
// stale ownership, keeps ownership for absent CLIs, and merges the remainder.
type HarnessOwned = { harnesses: readonly Harness[] };

function staleEntries<P extends HarnessOwned, C extends HarnessOwned>(
  previous: readonly P[],
  current: readonly C[],
  keyOf: (entry: P | C) => string,
): P[] {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const stale: P[] = [];

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
  available: readonly Harness[],
  entries: readonly T[],
): T[] {
  return entries.flatMap((entry) => {
    const harnesses = entry.harnesses.filter((harness) => available.includes(harness));
    return harnesses.length > 0 ? [{ ...entry, harnesses }] : [];
  });
}

function retainAbsentEntries<P extends HarnessOwned, C extends HarnessOwned>(
  available: readonly Harness[],
  previous: readonly P[],
  current: readonly C[],
  keyOf: (entry: P | C) => string,
): P[] {
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const leftover: P[] = [];

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
  current: readonly T[],
  leftover: readonly T[],
  keyOf: (entry: T) => string,
): T[] {
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

// Inputs are validated manifest/lock entries. Persist nextLock only after all
// apply/remove operations succeed; deferred removals remain owned for retry.
type OwnershipPlan<T> = { removals: T[]; nextLock: (deferred: readonly T[]) => T[] };

export function planOwnership<T extends HarnessOwned>(options: {
  previous: readonly T[];
  selected: readonly T[];
  available: readonly Harness[];
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
