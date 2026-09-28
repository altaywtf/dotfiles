import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { logDirectory } from "./logs.ts";
import { hygiene } from "./hygiene.ts";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  candidates,
  cleanRepository,
  discoverRepositories,
  lastChanged,
  openFiles,
  type Runner,
} from "./repositories.ts";

const gracePeriod = 3 * 86400_000;
const baseline = Date.now();

const runner: Runner = (cwd, command, args) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-hygiene-")));
  const git = (cwd: string, ...args: string[]) => {
    const result = runner(cwd, "git", args);
    assert.equal(result.status, 0, `git ${args.join(" ")}`);
    return result.stdout.trim();
  };
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  const repo = join(root, "projects/org/repo");
  mkdirSync(join(root, "projects/org"), { recursive: true });
  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(repo, "tracked"), "initial\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  git(repo, "push", "-u", "origin", "main");
  const roots = [join(root, "worktrees")];
  const tree = join(roots[0], "finished");
  git(repo, "worktree", "add", "-b", "finished", tree);
  return {
    root,
    repo,
    roots,
    tree,
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("clean merged worktree waits three days, is removed without force, then its branch is separately eligible", () => {
  const f = fixture();
  try {
    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.ok(existsSync(f.tree));
    cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod - 1,
      true,
      () => [],
      runner,
    );
    assert.ok(existsSync(f.tree), "retained until the full three-day grace period elapses");
    const second = cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.equal(existsSync(f.tree), false);
    assert.ok(second.entries.some((entry) => entry.result === "removed"));
    const branch = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + 3 * gracePeriod,
      true,
      () => [],
      runner,
    );
    cleanRepository(
      f.repo,
      f.roots,
      branch.candidates,
      baseline + 4 * gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.equal(f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/finished"), "");
    assert.ok(existsSync(f.repo));
  } finally {
    f.cleanup();
  }
});

test("dirty, ignored, locked and active worktrees are retained", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tree, "untracked"), "keep");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    rmSync(join(f.tree, "untracked"));
    writeFileSync(join(f.repo, ".git/info/exclude"), ".env\nnode_modules/\n");
    writeFileSync(join(f.tree, ".env"), "keep");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    rmSync(join(f.tree, ".env"));
    mkdirSync(join(f.tree, "node_modules"));
    writeFileSync(join(f.tree, "node_modules/generated"), "regenerable");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 1);
    assert.equal(candidates(f.repo, f.roots, [join(f.tree, "tracked")], runner).eligible.length, 0);
    f.git(f.repo, "worktree", "lock", f.tree);
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    f.git(f.repo, "worktree", "unlock", f.tree);
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 1);
  } finally {
    f.cleanup();
  }
});

// A detached worktree has no branch to protect, so remote-default ancestry is
// the only thing standing between it and removal.
test("a detached worktree is removable once merged and retained while it is not", () => {
  const f = fixture();
  try {
    f.git(f.tree, "checkout", "--detach");
    f.git(f.repo, "branch", "-d", "finished");
    assert.equal(
      candidates(f.repo, f.roots, [], runner).eligible.some((item) => item.path === f.tree),
      true,
    );

    f.git(f.tree, "commit", "--allow-empty", "-m", "unpushed work");
    assert.ok(
      candidates(f.repo, f.roots, [], runner).kept.some(
        (entry) => entry.target === f.tree && entry.result.startsWith("HEAD not in remote default"),
      ),
    );
    assert.equal(
      candidates(f.repo, f.roots, [], runner).eligible.some((item) => item.path === f.tree),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("a worktree beside its owning clone is evaluated, and unpushed work still retains it", () => {
  const f = fixture();
  try {
    const projectRoots = [...f.roots, join(f.root, "projects")];
    const stray = join(f.root, "projects/org/repo-stray");
    f.git(f.repo, "worktree", "add", "-b", "stray", stray);

    assert.ok(
      candidates(f.repo, f.roots, [], runner).kept.some(
        (entry) => entry.target === stray && entry.result === "outside cleanup roots",
      ),
      "unreachable while only harness roots are cleaned",
    );
    assert.ok(
      candidates(f.repo, projectRoots, [], runner).eligible.some((item) => item.path === stray),
      "eligible once the project tree is a cleanup root",
    );

    f.git(stray, "commit", "--allow-empty", "-m", "unpushed work");
    const kept = candidates(f.repo, projectRoots, [], runner).kept;
    assert.ok(
      kept.some(
        (entry) => entry.target === stray && entry.result.startsWith("HEAD not in remote default"),
      ),
    );
    assert.equal(
      candidates(f.repo, projectRoots, [], runner).eligible.some((item) => item.path === stray),
      false,
    );
    assert.ok(existsSync(stray));
  } finally {
    f.cleanup();
  }
});

test("scheduled hygiene reports a stray worktree beside its owning clone", async () => {
  const f = fixture();
  try {
    // fixture() already owns <root>/projects, which is the tree hygiene scans.
    const home = f.root;
    mkdirSync(join(home, ".local/state/dotfiles"), { recursive: true });
    writeFileSync(
      join(home, ".local/state/dotfiles/hygiene.json"),
      JSON.stringify({ lastRun: 0, lastCache: baseline, candidates: {} }),
    );
    const stray = join(home, "projects/org/repo-stray");
    f.git(f.repo, "worktree", "add", "-b", "stray", stray);
    f.git(stray, "commit", "--allow-empty", "-m", "unpushed work");

    await hygiene(home, true, true, baseline);

    const log = readFileSync(
      join(logDirectory(home), `hygiene-${new Date(baseline).toISOString().slice(0, 10)}.log`),
      "utf8",
    );
    assert.ok(log.includes("repo-stray"), "the stray worktree appears in the report");
    assert.ok(log.includes("HEAD not in remote default"), "with the reason it was retained");
    assert.ok(existsSync(stray), "unpushed work is never removed");
  } finally {
    f.cleanup();
  }
});

// Eligibility is judged against the remote default, `git branch -d` against
// local HEAD. A lagging checkout makes them disagree on every run.
test("a branch merged upstream but absent from a lagging local HEAD names the cause", () => {
  const f = fixture();
  try {
    f.git(f.repo, "checkout", "-b", "done");
    f.git(f.repo, "commit", "--allow-empty", "-m", "landed upstream");
    f.git(f.repo, "push", "origin", "done:main");
    f.git(f.repo, "checkout", "main");
    f.git(f.repo, "fetch", "origin");

    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      runner,
    );
    const second = cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.ok(
      second.entries.some(
        (entry) =>
          entry.target === "refs/heads/done" &&
          entry.result === "local default branch is behind the remote; pull before removal",
      ),
    );
    assert.equal(f.git(f.repo, "rev-parse", "--verify", "refs/heads/done").length, 40);

    f.git(f.repo, "merge", "--ff-only", "origin/main");
    const third = cleanRepository(
      f.repo,
      f.roots,
      second.candidates,
      baseline + 3 * gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.ok(
      third.entries.some(
        (entry) => entry.target === "refs/heads/done" && entry.result === "removed",
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("a recreated worktree cannot inherit an old HEAD's elapsed grace period", () => {
  const f = fixture();
  try {
    const now = Date.now();
    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      now - 2 * gracePeriod,
      true,
      () => [],
      runner,
    );
    f.git(f.repo, "worktree", "remove", f.tree);
    f.git(f.repo, "worktree", "add", f.tree, "finished");
    const second = cleanRepository(f.repo, f.roots, first.candidates, now, true, () => [], runner);
    assert.ok(existsSync(f.tree));
    assert.ok(
      second.entries.some(
        (entry) => entry.result === "changed within three days; grace period restarted",
      ),
    );
    assert.equal(Object.values(second.candidates)[0]?.since, now);
    cleanRepository(
      f.repo,
      f.roots,
      second.candidates,
      now + gracePeriod + 1000,
      true,
      () => [],
      runner,
    );
    assert.equal(existsSync(f.tree), false);
  } finally {
    f.cleanup();
  }
});

for (const target of ["nested file", "Git index"] as const) {
  test(`recent ${target} activity protects a clean worktree with unchanged HEAD`, () => {
    const f = fixture();
    try {
      mkdirSync(join(f.tree, "nested"));
      writeFileSync(join(f.tree, "nested/file"), "content\n");
      f.git(f.tree, "add", ".");
      f.git(f.tree, "commit", "-m", "nested file");
      f.git(f.tree, "push", "origin", "HEAD:main");
      const now = Date.now() + 2 * gracePeriod;
      const first = cleanRepository(f.repo, f.roots, {}, now - gracePeriod, true, () => [], runner);
      const path =
        target === "nested file"
          ? join(f.tree, "nested/file")
          : join(f.git(f.tree, "rev-parse", "--absolute-git-dir"), "index");
      utimesSync(path, new Date(now - 1000), new Date(now - 1000));
      const second = cleanRepository(
        f.repo,
        f.roots,
        first.candidates,
        now,
        true,
        () => [],
        runner,
      );
      assert.ok(existsSync(f.tree));
      assert.ok(second.entries.some((entry) => entry.result.includes("changed within three days")));
      assert.equal(f.git(f.tree, "status", "--porcelain"), "");
    } finally {
      f.cleanup();
    }
  });
}

test("activity inspection does not follow symlinks and fails on missing paths", () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    writeFileSync(outside, "outside");
    const future = Date.now() + 10 * gracePeriod;
    utimesSync(outside, new Date(future), new Date(future));
    symlinkSync(outside, join(f.tree, "link"));
    assert.ok(lastChanged(f.tree) < future);
    assert.throws(() => lastChanged(join(f.root, "missing")), { code: "ENOENT" });
  } finally {
    f.cleanup();
  }
});

test("unavailable worktree activity retains an otherwise removable tree", () => {
  const f = fixture();
  try {
    const now = Date.now() + 2 * gracePeriod;
    const first = cleanRepository(f.repo, f.roots, {}, now - gracePeriod, true, () => [], runner);
    const unavailable: Runner = (cwd, command, args) =>
      args.includes("--absolute-git-dir")
        ? { status: 0, stdout: join(f.root, "missing") }
        : runner(cwd, command, args);
    assert.throws(() =>
      cleanRepository(f.repo, f.roots, first.candidates, now, true, () => [], unavailable),
    );
    assert.ok(existsSync(f.tree));
  } finally {
    f.cleanup();
  }
});

test("unmerged commits survive even when their remote branch is gone", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tree, "tracked"), "unmerged work\n");
    f.git(f.tree, "commit", "-am", "keep");
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(f.repo, "push", "origin", "--delete", "finished");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
  } finally {
    f.cleanup();
  }
});

test("activity arriving at removal time cancels eligibility", () => {
  const f = fixture();
  try {
    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      runner,
    );
    let checks = 0;
    const second = cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      true,
      () => (++checks === 1 ? [] : [f.tree]),
      runner,
    );
    assert.ok(existsSync(f.tree));
    assert.equal(Object.keys(second.candidates).length, 0);
  } finally {
    f.cleanup();
  }
});

test("existing upstreams and long-lived branches stay, changed HEAD restarts the grace period", () => {
  const f = fixture();
  try {
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(f.repo, "branch", "release/stable");
    assert.equal(candidates(f.repo, f.roots, [], runner).eligible.length, 0);
    f.git(f.repo, "push", "origin", "--delete", "finished");
    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      runner,
    );
    writeFileSync(join(f.tree, "tracked"), "more merged work\n");
    f.git(f.tree, "commit", "-am", "more work");
    f.git(f.tree, "push", "origin", "HEAD:main");
    const second = cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      true,
      () => [],
      runner,
    );
    assert.ok(existsSync(f.tree));
    assert.equal(Object.values(second.candidates)[0]?.since, baseline + 2 * gracePeriod);
    assert.equal(
      f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/release/stable"),
      "refs/heads/release/stable",
    );
  } finally {
    f.cleanup();
  }
});

test("dry-run never deletes, failed remote reads and activity probes fail closed", () => {
  const f = fixture();
  try {
    const first = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      runner,
    );
    f.git(f.tree, "push", "-u", "origin", "finished");
    f.git(
      f.root,
      "--git-dir",
      join(f.root, "remote.git"),
      "update-ref",
      "-d",
      "refs/heads/finished",
    );
    cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      false,
      () => [],
      runner,
    );
    assert.ok(existsSync(f.tree));
    assert.equal(
      f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/finished"),
      "refs/remotes/origin/finished",
    );
    const failed: Runner = (cwd, command, args) =>
      args[0] === "ls-remote" ? { status: 1, stdout: "" } : runner(cwd, command, args);
    assert.throws(() =>
      cleanRepository(
        f.repo,
        f.roots,
        first.candidates,
        baseline + 2 * gracePeriod,
        true,
        () => [],
        failed,
      ),
    );
    assert.throws(() => openFiles(f.root, () => ({ status: 1, stdout: "" })));
    assert.ok(existsSync(f.tree));
    const missing: Runner = (cwd, command, args) =>
      args[0] === "cat-file" ? { status: 1, stdout: "" } : runner(cwd, command, args);
    const skipped = cleanRepository(
      f.repo,
      f.roots,
      first.candidates,
      baseline + 2 * gracePeriod,
      true,
      () => [],
      missing,
    );
    assert.equal(
      skipped.entries[0]?.result,
      "remote default history missing locally; retained for normal sync",
    );
    assert.ok(existsSync(f.tree));
  } finally {
    f.cleanup();
  }
});

test("repository discovery ignores symlinks and stays within its depth", () => {
  const f = fixture();
  try {
    symlinkSync(f.repo, join(f.root, "projects/linked"));
    assert.deepEqual(discoverRepositories(join(f.root, "projects")), [f.repo]);
  } finally {
    f.cleanup();
  }
});

test("inactive and explicitly excluded checkouts need no remote access", () => {
  const f = fixture();
  try {
    f.git(f.repo, "worktree", "remove", f.tree);
    f.git(f.repo, "branch", "-d", "finished");
    const offline: Runner = (cwd, command, args) => {
      if (args[0] === "ls-remote" || args[0] === "remote")
        throw new Error("unexpected network access");
      return runner(cwd, command, args);
    };
    const result = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      offline,
    );
    assert.deepEqual(result, { entries: [], candidates: {} });
    assert.ok(existsSync(join(f.repo, "tracked")));
    f.git(f.repo, "worktree", "add", "-b", "finished", f.tree);
    f.git(f.repo, "config", "--local", "dotfiles.hygiene", "skip");
    const excluded = cleanRepository(
      f.repo,
      f.roots,
      {},
      baseline + gracePeriod,
      true,
      () => [],
      offline,
    );
    assert.equal(excluded.entries[0]?.result, "excluded by local dotfiles.hygiene=skip");
    assert.ok(existsSync(f.tree));
  } finally {
    f.cleanup();
  }
});

test("process inventory suppresses lsof warning-induced exits but stays fail-closed", () => {
  let seen: string[] = [];
  const paths = openFiles("/fixture", (_cwd, command, args) => {
    assert.equal(command, "lsof");
    seen = args;
    return { status: 0, stdout: "p1\0n/fixture/file\0" };
  });
  assert.equal(seen[0], "-w");
  assert.deepEqual(paths, ["/fixture/file"]);
  // A warning-free nonzero exit (a real lsof failure) still fails closed.
  assert.throws(
    () => openFiles("/fixture", () => ({ status: 1, stdout: "" })),
    /retained local work/,
  );
  // No paths at all is indistinguishable from a broken inventory: fail closed.
  assert.throws(
    () => openFiles("/fixture", () => ({ status: 0, stdout: "" })),
    /process activity unavailable/,
  );
});
