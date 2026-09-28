import { type AgentLayer } from "../profiles/model.ts";
import { type Runtime, writeLine } from "./runtime.ts";

export const HARNESSES = ["claude", "codex", "grok"] as const;

export type Harness = (typeof HARNESSES)[number];

export const HARNESS_INFO: Record<Harness, { binary: string; label: string }> = {
  claude: { binary: "claude", label: "Claude Code" },
  codex: { binary: "codex", label: "Codex" },
  grok: { binary: "grok", label: "Grok" },
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeName(value: string): boolean {
  return NAME_PATTERN.test(value) && !RESERVED_NAMES.has(value);
}

function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

// Selection uses membership, never order; normalize so composition compares
// manifests by meaning rather than authoring order.
export function readHarnesses(value: unknown, invalidMessage: string): readonly Harness[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isHarness) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(invalidMessage);
  }
  return HARNESSES.filter((harness) => value.includes(harness));
}

export function harnessPresent(runtime: Runtime): boolean {
  return HARNESSES.some((harness) => runtime.commandExists(HARNESS_INFO[harness].binary));
}

export type SyncFailure = {
  diagnostic: string;
  summary: string;
};

export function reportSyncFailures(
  runtime: Runtime,
  failures: readonly SyncFailure[],
  subject: string,
  nouns: readonly [string, string],
  kind: string,
): 1 {
  const noun = failures.length === 1 ? nouns[0] : nouns[1];
  writeLine(runtime.stderr, `${subject} failed for ${failures.length} ${noun}:`);
  for (const failure of failures) {
    writeLine(runtime.stderr, `  - ${failure.summary}`);
    for (const line of failure.diagnostic.split("\n")) {
      if (line.length > 0) {
        writeLine(runtime.stderr, `    ${line}`);
      }
    }
  }
  writeLine(runtime.stderr, `Fix the reported ${kind} failures, then rerun sync.`);
  return 1;
}

export type SyncArgs =
  | { kind: "run"; profile?: string; update: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseSyncArgs(
  args: readonly string[],
  usage: string,
  allowUpdate: boolean,
): SyncArgs {
  let profile: string | undefined;
  let update = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (allowUpdate && arg === "--update") {
      update = true;
      continue;
    }
    if (arg === "--profile") {
      if (profile !== undefined) {
        return { kind: "error", message: `${usage}\n--profile may be provided only once` };
      }
      const value = args[index + 1];
      if (value === undefined) {
        return { kind: "error", message: `${usage}\n--profile requires a value` };
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" };
    }
    return { kind: "error", message: `${usage}\nUnknown argument: ${arg}` };
  }

  return { kind: "run", profile, update };
}

// Compose the selected manifest layers, tolerating an identical entry selected
// by more than one layer and rejecting a conflicting redefinition.
export function composeLayers<T, Layer extends string = AgentLayer>(
  selected: readonly Layer[],
  manifests: ReadonlyMap<Layer, readonly T[]>,
  keyOf: (entry: T) => string,
  conflictMessage: (key: string) => string,
): T[] {
  const seen = new Map<string, string>();
  const entries: T[] = [];
  for (const entry of selected.flatMap((layer) => manifests.get(layer) ?? [])) {
    const key = keyOf(entry);
    const shape = JSON.stringify(entry);
    const previous = seen.get(key);
    if (previous === shape) {
      continue;
    }
    if (previous !== undefined) {
      throw new Error(conflictMessage(key));
    }
    seen.set(key, shape);
    entries.push(entry);
  }
  return entries;
}
