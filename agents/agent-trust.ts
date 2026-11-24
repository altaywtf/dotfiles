import { existsSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

import type { ProfileConfig } from "../profiles/model.ts";
import { decodeOrThrow, readJsonFile } from "./decode.ts";
import { writeLockFile } from "./lock.ts";
import { writeLine } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";

const AgySettings = Schema.StructWithRest(
  Schema.Struct({ trustedWorkspaces: Schema.optional(Schema.Array(Schema.String)) }),
  [Schema.Record(Schema.String, Schema.Json)],
);

function trustedRoots(home: string): Array<string> {
  return [join(home, "projects"), join(home, ".t3/worktrees")];
}

function readJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  path: string,
): S["Type"] | undefined {
  return existsSync(path)
    ? decodeOrThrow(schema, readJsonFile(path, path), (detail) => `${path}: ${detail}`)
    : undefined;
}

function writeAgyTrust(runtime: Runtime, home: string, roots: ReadonlyArray<string>): void {
  const settingsPath = join(home, ".gemini/antigravity-cli/settings.json");
  const current = readJson(AgySettings, settingsPath) ?? {};
  const trusted = current.trustedWorkspaces ?? [];
  const missing = roots.filter((root) => !trusted.includes(root));
  if (missing.length === 0) {
    return;
  }
  writeLockFile(settingsPath, { ...current, trustedWorkspaces: [...trusted, ...missing] });
  writeLine(runtime.stdout, `Antigravity: trusted ${missing.join(", ")} in ${settingsPath}`);
}

export function writeAgentTrust(
  runtime: Runtime,
  capabilities: ProfileConfig["capabilities"],
): void {
  if (!(capabilities.personal || capabilities.devbox)) {
    return;
  }
  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to locate agent trust files");
  }
  const roots = trustedRoots(home);
  if (runtime.commandExists("agy")) {
    writeAgyTrust(runtime, home, roots);
  }
}
