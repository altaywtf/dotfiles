import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { commit, init, invoke, run } from "./pre-push-fixture.ts";

test("empty input and deletions succeed without inspecting the worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-empty-"));

  try {
    const repo = init(root);
    const base = commit(repo, "base\n");
    const first = commit(repo, "clean\n");
    writeFileSync(join(repo.path, "file.txt"), "dirty worktree line   \n");
    assert.equal(invoke(repo, "").status, 0);
    const update = `refs/heads/main ${first} refs/heads/main ${base}\n`;
    assert.equal(invoke(repo, update).status, 0);
    const deletion = `(delete) ${repo.zeroOid} refs/heads/main ${first}\n`;
    assert.equal(invoke(repo, deletion).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing, new, and multiple ref updates inspect only outgoing commits", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-updates-"));

  try {
    const repo = init(root);
    const base = commit(repo, "base\n");
    const clean = commit(repo, "clean\n");
    let input = `refs/heads/main ${clean} refs/heads/main ${base}\n`;
    assert.equal(invoke(repo, input).status, 0);

    const bad = commit(repo, "trailing whitespace   \n", "bad.txt");
    input = `refs/heads/topic ${bad} refs/heads/topic ${repo.zeroOid}\n`;
    const badResult = invoke(repo, input);
    assert.equal(badResult.status, 1);
    assert.match(String(badResult.stderr), /trailing whitespace/);

    input = [
      `refs/heads/main ${clean} refs/heads/main ${base}`,
      `refs/heads/topic ${bad} refs/heads/topic ${repo.zeroOid}`,
    ].join("\n");
    assert.equal(invoke(repo, `${input}\n`).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("URL remotes and repositories without tracking refs check new history", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-url-"));

  try {
    const repo = init(root);
    const bad = commit(repo, "bad   \n");
    const input = `refs/heads/main ${bad} refs/heads/main ${repo.zeroOid}\n`;
    assert.equal(invoke(repo, input, "file:///missing.git", "file:///missing.git").status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing required objects fail with an actionable diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-missing-"));

  try {
    const repo = init(root);
    const local = commit(repo, "clean\n");
    const missing = "f".repeat(repo.oidLength);
    const localMissing = `refs/heads/main ${missing} refs/heads/main ${repo.zeroOid}\n`;
    assert.match(String(invoke(repo, localMissing).stderr), /missing local object/);
    const remoteMissing = `refs/heads/main ${local} refs/heads/main ${missing}\n`;
    assert.match(String(invoke(repo, remoteMissing).stderr), /missing remote commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mirror-shaped non-commit and deletion updates are ignored safely", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-mirror-"));

  try {
    const repo = init(root);
    const commitOid = commit(repo, "clean\n");
    const blobOid = run(repo.path, ["git", "hash-object", "file.txt"]);

    const input = [
      `refs/heads/main ${commitOid} refs/heads/main ${repo.zeroOid}`,
      `refs/custom/blob ${blobOid} refs/custom/blob ${repo.zeroOid}`,
      `(delete) ${repo.zeroOid} refs/heads/old ${commitOid}`,
    ].join("\n");

    assert.equal(invoke(repo, `${input}\n`).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merge-only defects fail while clean merges pass", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-merge-"));

  try {
    const repo = init(root);
    const base = commit(repo, "base\n");
    run(repo.path, ["git", "checkout", "-b", "topic"]);
    commit(repo, "topic\n", "topic.txt");
    run(repo.path, ["git", "checkout", "-b", "target", base]);
    commit(repo, "target\n", "target.txt");
    run(repo.path, ["git", "merge", "--no-ff", "--no-commit", "topic"]);
    const clean = commit(repo, "clean resolution\n", "merge.txt");
    const update = (oid: string) => `refs/heads/target ${oid} refs/heads/target ${base}\n`;
    assert.equal(invoke(repo, update(clean)).status, 0);

    for (const content of ["bad resolution   \n", "<<<<<<< fixture\n"]) {
      writeFileSync(join(repo.path, "merge.txt"), content);
      run(repo.path, ["git", "add", "merge.txt"]);
      run(repo.path, ["git", "commit", "--amend", "--no-edit"]);
      const merge = run(repo.path, ["git", "rev-parse", "HEAD"]);
      assert.equal(invoke(repo, update(merge)).status, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
