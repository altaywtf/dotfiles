import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { type Harness } from "./harness.ts";
import { planOwnership } from "./ownership.ts";

type Entry = { name: string; harnesses: readonly Harness[] };
type Case = {
  previous: readonly Entry[];
  selected: readonly Entry[];
  available: readonly Harness[];
  deferred: readonly Entry[];
};

const keyOf = (entry: Entry) => entry.name;
const NAMES = ["a", "b", "c"];
const SUBSETS: readonly (readonly Harness[])[] = [
  [],
  ["claude"],
  ["codex"],
  ["claude", "codex"],
].map((harnesses) => Object.freeze(harnesses as Harness[]));

// Every list with at most one non-empty-harness entry per name, in the given name order.
function entryLists(names: readonly string[]): (readonly Entry[])[] {
  return names
    .reduce<Entry[][]>(
      (lists, name) =>
        lists.flatMap((list) =>
          SUBSETS.map((harnesses) =>
            harnesses.length === 0 ? list : [...list, frozen({ name, harnesses })],
          ),
        ),
      [[]],
    )
    .map((list) => Object.freeze(list));
}

// Frozen inputs, lists included, make any mutation by the planner throw.
function frozen(entry: Entry): Entry {
  Object.freeze(entry.harnesses);
  return Object.freeze(entry);
}

function pairs(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => entry.harnesses.map((harness) => `${entry.name}:${harness}`));
}

function entriesFrom(owned: readonly { name: string; harness: Harness }[]): readonly Entry[] {
  const byName = new Map<string, Harness[]>();
  for (const { name, harness } of owned) {
    byName.set(name, [...(byName.get(name) ?? []), harness]);
  }
  return Object.freeze([...byName].map(([name, harnesses]) => frozen({ name, harnesses })));
}

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>(
    (all, item) => all.flatMap((subset) => [subset, [...subset, item]]),
    [[]],
  );
}

// Exhaustive over three names and both harnesses; selected runs in reverse name
// order so lock merging never relies on matching input order. With deferral,
// deferred ranges over every subset of the removals the spec requires.
function* cases(withDeferral: boolean): Generator<Case> {
  const previousLists = entryLists(NAMES);
  const selectedLists = entryLists([...NAMES].reverse());
  for (const previous of previousLists) {
    for (const selected of selectedLists) {
      const stale = previous.flatMap(({ name, harnesses }) =>
        harnesses
          .filter((harness) => !pairs(selected).includes(`${name}:${harness}`))
          .map((harness) => ({ name, harness })),
      );
      for (const available of SUBSETS) {
        for (const deferred of withDeferral ? subsets(stale) : [[]]) {
          yield { previous, selected, available, deferred: entriesFrom(deferred) };
        }
      }
    }
  }
}

function forEveryCase(property: (input: Case) => void, withDeferral = false): void {
  let checked = 0;
  for (const input of cases(withDeferral)) {
    try {
      property(input);
    } catch (error) {
      throw new Error(`property failed for ${JSON.stringify(input)}`, { cause: error });
    }
    checked += 1;
  }
  assert.ok(checked > 10_000);
}

const sorted = (values: readonly string[]) => [...values].sort();
const plan = (input: Case, previous: readonly Entry[] = input.previous) =>
  planOwnership({ previous, selected: input.selected, available: input.available, keyOf });

test("removals are exactly the owned (name, harness) pairs no longer selected, never a selected pair", () => {
  forEveryCase((input) => {
    const selected = pairs(input.selected);
    assert.deepEqual(
      sorted(pairs(plan(input).removals)),
      sorted(pairs(input.previous).filter((pair) => !selected.includes(pair))),
    );
  });
});

test("the next lock owns selected pairs on present harnesses, owned pairs on absent ones, and deferred removals until a retry removes them", () => {
  forEveryCase((input) => {
    const lock = plan(input).nextLock(input.deferred);
    const present = (pair: string) =>
      input.available.some((harness) => pair.endsWith(`:${harness}`));
    const owned = pairs(input.previous);
    const expected = new Set([
      ...pairs(input.selected).filter((pair) => present(pair) || owned.includes(pair)),
      ...pairs(input.deferred),
    ]);

    assert.deepEqual(sorted(pairs(lock)), sorted([...expected]));
    assert.equal(new Set(lock.map(keyOf)).size, lock.length);

    const retried = plan(input, lock).removals;
    assert.deepEqual(sorted(pairs(retried)), sorted(pairs(input.deferred)));
  }, true);
});

test("re-planning with the resulting lock and the same inputs yields no removals and the same lock", () => {
  forEveryCase((input) => {
    const settled = plan(input).nextLock([]);
    const replanned = plan(input, settled);
    assert.deepEqual(replanned.removals, []);
    assert.deepEqual(replanned.nextLock([]), settled);
  });
});
