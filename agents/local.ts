import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "./runtime.ts";

const LOCAL_OVERLAY_KEYS = ["skills", "mcps", "plugins"] as const;

export type LocalOverlay = {
  path: string;
  document: Partial<Record<(typeof LOCAL_OVERLAY_KEYS)[number], unknown>>;
};

// The overlay is trusted checkout-local configuration applied after every
// profile layer, so it follows the Brewfile.local ownership contract: a regular
// file owned by the current user that nobody else may write.
export function readLocalOverlay(repoDir: string): LocalOverlay | undefined {
  const path = join(repoDir, "agents", "local.json");
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return undefined;
  if (!info.isFile()) {
    throw new Error(`Invalid local agent overlay: ${path} must be a regular file`);
  }
  if (info.uid !== process.getuid?.()) {
    throw new Error(`Unsafe local agent overlay: ${path} must be owned by the current user`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new Error(`Unsafe local agent overlay: ${path} must not be group or world writable`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid local agent overlay at ${path}: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid local agent overlay at ${path}: expected an object`);
  }
  const unknownKeys = Object.keys(parsed).filter(
    (key) => !(LOCAL_OVERLAY_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid local agent overlay at ${path}: unsupported keys ${unknownKeys.join(", ")}; expected ${LOCAL_OVERLAY_KEYS.join(", ")}`,
    );
  }
  return { path, document: parsed };
}
