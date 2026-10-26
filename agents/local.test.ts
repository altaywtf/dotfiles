import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import { readLocalOverlay } from "./local.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agents-local-"));
  roots.push(root);
  mkdirSync(join(root, "agents"), { recursive: true });
  return root;
}

test("a missing overlay is optional", () => {
  assert.equal(readLocalOverlay(fixture()), undefined);
});

test("rejects malformed JSON, non-objects, and unsupported keys", () => {
  const root = fixture();
  const path = join(root, "agents/local.json");
  writeFileSync(path, "{", { mode: 0o600 });
  assert.throws(() => readLocalOverlay(root), /Invalid local agent overlay at .*JSON/);
  writeFileSync(path, "[]", { mode: 0o600 });
  assert.throws(() => readLocalOverlay(root), /expected an object/);
  writeFileSync(path, '{"agents":[]}', { mode: 0o600 });
  assert.throws(
    () => readLocalOverlay(root),
    /unsupported keys agents; expected skills, servers, plugins/,
  );
});

test("rejects a symlink and a group or world writable file", () => {
  const root = fixture();
  const path = join(root, "agents/local.json");
  writeFileSync(join(root, "elsewhere.json"), "{}", { mode: 0o600 });
  symlinkSync(join(root, "elsewhere.json"), path);
  assert.throws(() => readLocalOverlay(root), /must be a regular file/);
  rmSync(path);
  writeFileSync(path, "{}", { mode: 0o600 });
  chmodSync(path, 0o664);
  assert.throws(() => readLocalOverlay(root), /must not be group or world writable/);
});
