import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { resolveSources } from "./paths.ts";

test("home discovery includes linked config files and reports broken links", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-paths-"));
  try {
    writeFileSync(join(root, "config"), "fixture");
    symlinkSync(join(root, "config"), join(root, ".zshrc"));
    symlinkSync(join(root, "absent"), join(root, ".broken"));
    const skipped: Array<string> = [];
    assert.deepEqual(
      resolveSources(root, [{ kind: "home-dotfiles" }], (path) => skipped.push(path)),
      [join(root, ".zshrc")],
    );
    assert.deepEqual(skipped, [join(root, ".broken")]);
    skipped.length = 0;
    assert.deepEqual(
      resolveSources(root, [{ kind: "path", path: ".broken" }], (path) => skipped.push(path)),
      [],
    );
    assert.deepEqual(skipped, [join(root, ".broken")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
