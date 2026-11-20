import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import { discoverCheckouts, projectTrustEdits, restrictCodexState } from "./projects.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "dotfiles-codex-projects-"));
  directories.push(directory);
  return directory;
}

test("discovers primary checkouts one and two levels under the root", () => {
  const root = join(temporary(), "projects");
  for (const path of ["solo/.git", "owner/repo/.git", "owner/repo/nested/.git", ".hidden/.git"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  mkdirSync(join(root, "owner/plain"), { recursive: true });
  mkdirSync(join(root, "owner/worktree"));
  writeFileSync(join(root, "owner/worktree/.git"), "gitdir: elsewhere\n");
  symlinkSync(join(root, "owner/repo"), join(root, "owner/link"));

  assert.deepEqual(discoverCheckouts(root), [join(root, "owner/repo"), join(root, "solo")]);
  assert.deepEqual(discoverCheckouts(join(root, "missing")), []);
});

test("adds missing checkouts, keeps existing entries, and prunes only vanished checkout paths", () => {
  const home = "/home/user";
  const root = `${home}/projects`;
  const existing = {
    [home]: { trust_level: "trusted" },
    [root]: { trust_level: "trusted" },
    [`${root}/owner/kept`]: { trust_level: "untrusted" },
    [`${root}/owner/gone`]: { trust_level: "trusted" },
    [`${root}/owner/gone/deeper/still`]: { trust_level: "trusted" },
    [`${home}/elsewhere`]: { trust_level: "trusted" },
    "/home/other/projects/repo": { trust_level: "trusted" },
  };
  const present = new Set([`${root}/owner/kept`, `${root}/owner/new`]);

  assert.deepEqual(
    projectTrustEdits(
      root,
      [`${root}/owner/kept`, `${root}/owner/new`, `${root}/owner/"quoted"`],
      existing,
      (path) => present.has(path),
    ),
    [
      {
        keyPath: `projects."${root}/owner/new".trust_level`,
        value: "trusted",
        mergeStrategy: "upsert",
      },
      { keyPath: `projects."${root}/owner/gone"`, value: null, mergeStrategy: "replace" },
    ],
  );
  assert.deepEqual(
    projectTrustEdits(root, [`${root}/owner/kept`], { [`${root}/owner/kept`]: {} }, () => true),
    [],
  );
});

const mode = (path: string) => statSync(path).mode & 0o777;

test("restricts loose Codex state the devbox audit checks and leaves other files alone", () => {
  const home = join(temporary(), ".codex");
  for (const path of ["sessions/2026", "shell_snapshots", "log", "skills"]) {
    mkdirSync(join(home, path), { recursive: true, mode: 0o755 });
  }
  const files = {
    state: join(home, "state_5.sqlite"),
    snapshot: join(home, "log/codex-tui.log"),
    deep: join(home, "sessions/2026/deep.sqlite"),
    skill: join(home, "skills/SKILL.md"),
  };
  for (const path of Object.values(files)) {
    writeFileSync(path, "", { mode: 0o644 });
  }
  chmodSync(home, 0o755);
  chmodSync(join(home, "sessions"), 0o755);

  const changed = restrictCodexState(home);
  for (const path of ["", "sessions", "shell_snapshots", "log"]) {
    assert.equal(mode(join(home, path)), 0o700, path);
  }
  assert.equal(mode(files.state), 0o600);
  assert.equal(mode(files.snapshot), 0o600);
  assert.equal(mode(files.deep), 0o600);
  assert.equal(mode(files.skill), 0o644);
  assert.equal(mode(join(home, "skills")), 0o755);
  assert.ok(changed.includes(files.state));
  assert.deepEqual(restrictCodexState(home), []);
  assert.deepEqual(restrictCodexState(join(home, "missing")), []);
});
