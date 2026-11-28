import { lstatSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

import { ClosedStruct, decodeOrThrow, readJsonFile } from "./decode.ts";

const LOCAL_OVERLAY_FIELDS = {
  skills: Schema.optionalKey(Schema.Unknown),
  mcps: Schema.optionalKey(Schema.Unknown),
  plugins: Schema.optionalKey(Schema.Unknown),
};

const LocalOverlayDocument = ClosedStruct(LOCAL_OVERLAY_FIELDS, {
  notObject: "expected an object",
  unsupported: (keys) =>
    `unsupported keys ${keys}; expected ${Object.keys(LOCAL_OVERLAY_FIELDS).join(", ")}`,
});

export type LocalOverlay = {
  path: string;
  document: typeof LocalOverlayDocument.Type;
};

export function readLocalOverlay(repoDir: string): LocalOverlay | undefined {
  const path = join(repoDir, "agents", "local.json");
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (!info) {
    return undefined;
  }

  if (!info.isFile()) {
    throw new Error(`Invalid local agent overlay: ${path} must be a regular file`);
  }

  if (info.uid !== process.getuid?.()) {
    throw new Error(`Unsafe local agent overlay: ${path} must be owned by the current user`);
  }

  if ((info.mode & 0o022) !== 0) {
    throw new Error(`Unsafe local agent overlay: ${path} must not be group or world writable`);
  }

  const label = `Invalid local agent overlay at ${path}`;

  return {
    path,
    document: decodeOrThrow(
      LocalOverlayDocument,
      readJsonFile(path, label),
      (detail) => `${label}: ${detail}`,
    ),
  };
}
