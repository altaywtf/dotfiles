import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { newestT3, stageT3Update } from "./t3.ts";

function home(versions: Array<string>) {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-t3-"));
  for (const version of versions) {
    const directory = join(root, ".t3/runtime/versions", version);
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, "t3");
    writeFileSync(binary, `#!/bin/sh\nprintf '%s ' "$@" > "${root}/args-${version}"\n`);
    chmodSync(binary, 0o755);
  }
  return root;
}

test("the newest T3 runtime is chosen by release order", (t) => {
  const root = home(["0.1.7", "0.1.12", "0.1.10", "nightly"]);
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(newestT3(root), join(root, ".t3/runtime/versions/0.1.12/t3"));
});

test("a host without a T3 runtime skips the update", (t) => {
  const root = home([]);
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(newestT3(root), undefined);
  assert.equal(stageT3Update(root), 0);
});

test("the scheduled update stages a release without restarting the service", (t) => {
  const root = home(["0.1.11", "0.1.12"]);
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(stageT3Update(root), 0);
  assert.equal(readFileSync(join(root, "args-0.1.12"), "utf8").trim(), "update");
});
