import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { commit, init, installer, invoke, run, type Repository } from "./pre-push-fixture.ts";

test.for([
  ["a missing Node runtime", "/usr/bin/false", /missing node; run mise install .* before pushing/],
  [
    "missing repository dependencies",
    process.execPath,
    /missing repository dependencies; run pnpm install --frozen-lockfile .* before pushing/,
  ],
] as const)("installed hook reports %s", ([, node, message]) => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-installer-"));
  try {
    const repo = init(root);
    const verifyDir = join(repo.path, "verify");
    const bin = join(root, "bin");
    mkdirSync(verifyDir, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(verifyDir, "pre-push.ts"), "");
    symlinkSync("/usr/bin/git", join(bin, "git"));
    symlinkSync(node, join(bin, "node"));

    const install = spawnSync(process.execPath, [installer], {
      cwd: repo.path,
      encoding: "utf8",
      env: { ...process.env, DOTFILES_PRE_PUSH_REPO_ROOT: repo.path },
    });
    assert.equal(install.status, 0, install.stderr);

    const result = spawnSync(
      "/bin/bash",
      [join(repo.path, ".git/hooks/pre-push"), "origin", "fixture"],
      { cwd: repo.path, encoding: "utf8", env: { ...process.env, PATH: bin } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shallow repositories can verify commits above the shallow boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-shallow-"));
  try {
    const source = init(root);
    commit(source, "base\n");
    const remotePath = join(root, "remote.git");
    run(root, ["git", "clone", "--quiet", "--bare", source.path, remotePath]);
    const shallowPath = join(root, "shallow");
    run(root, ["git", "clone", "--quiet", "--depth=1", `file://${remotePath}`, shallowPath]);
    const format = run(shallowPath, ["git", "rev-parse", "--show-object-format"]);
    assert.ok(format === "sha1" || format === "sha256");
    const shallow: Repository = {
      path: shallowPath,
      oidLength: format === "sha256" ? 64 : 40,
      zeroOid: "0".repeat(format === "sha256" ? 64 : 40),
    };
    const remoteOid = run(shallow.path, ["git", "rev-parse", "HEAD"]);
    const localOid = commit(shallow, "next\n");
    const input = `refs/heads/main ${localOid} refs/heads/main ${remoteOid}\n`;
    assert.equal(invoke(shallow, input, "origin", remotePath).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SHA-256 object IDs are supported when Git supports them", (context) => {
  const root = mkdtempSync(join(tmpdir(), "pre-push-sha256-"));
  try {
    const probe = spawnSync("git", [
      "init",
      "--quiet",
      "--object-format=sha256",
      join(root, "probe"),
    ]);
    if (probe.status !== 0) {
      context.skip("installed Git does not support SHA-256 repositories");
      return;
    }
    rmSync(join(root, "probe"), { recursive: true, force: true });
    const repo = init(root, "sha256");
    const oid = commit(repo, "clean\n");
    const input = `refs/heads/main ${oid} refs/heads/main ${repo.zeroOid}\n`;
    assert.equal(invoke(repo, input).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
