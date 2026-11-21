import { existsSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

import type { ProfileConfig } from "../profiles/model.ts";
import { decodeOrThrow, readJsonFile } from "./decode.ts";
import { writeLockFile } from "./lock.ts";
import { writeLine } from "./runtime.ts";
import type { Runtime } from "./runtime.ts";

const TrustFile = Schema.Record(Schema.String, Schema.Json);

function piTrustedRoots(home: string): Array<string> {
  return [join(home, "projects"), join(home, ".t3/worktrees")];
}

export function writePiTrust(runtime: Runtime, capabilities: ProfileConfig["capabilities"]): void {
  if (!(capabilities.personal || capabilities.devbox) || !runtime.commandExists("pi")) {
    return;
  }
  const home = runtime.env.HOME;
  if (!home) {
    throw new Error("HOME is required to locate the Pi trust file");
  }
  const trustPath = join(home, ".pi/agent/trust.json");
  const current = existsSync(trustPath)
    ? decodeOrThrow(
        TrustFile,
        readJsonFile(trustPath, trustPath),
        (detail) => `${trustPath}: ${detail}`,
      )
    : {};
  const missing = piTrustedRoots(home).filter((root) => current[root] !== true);
  if (missing.length === 0) {
    return;
  }
  writeLockFile(trustPath, {
    ...current,
    ...Object.fromEntries(missing.map((root) => [root, true])),
  });
  writeLine(runtime.stdout, `Pi: trusted ${missing.join(", ")} in ${trustPath}`);
}
