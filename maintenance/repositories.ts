import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const gracePeriod = 3 * 86_400_000;
type Result = { status: number; stdout: string };
export type Runner = (cwd: string, command: string, args: Array<string>) => Result;
export type Worktree = {
  path: string;
  branch: string;
  head: string;
  locked: boolean;
  prunable: boolean;
};
type Candidate = { kind: "worktree" | "branch"; path: string; branch: string; head: string };
type Entry = { target: string; result: string };

const run: Runner = (cwd, command, args) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.error ? 1 : (result.status ?? 1), stdout: result.stdout ?? "" };
};

function checked(runner: Runner, cwd: string, command: string, args: Array<string>): string {
  const result = runner(cwd, command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed; retained local work`);
  }
  return result.stdout.trim();
}

function parseWorktrees(text: string): Array<Worktree> {
  return text
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = block.split("\0");
      const field = (name: string) =>
        fields.find((value) => value.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
      if (!field("worktree") || !/^[0-9a-f]{40,64}$/.test(field("HEAD"))) {
        throw new Error("invalid worktree inventory");
      }
      return {
        path: field("worktree"),
        branch: field("branch"),
        head: field("HEAD"),
        locked: fields.some((value) => value === "locked" || value.startsWith("locked ")),
        prunable: fields.some((value) => value === "prunable" || value.startsWith("prunable ")),
      };
    });
}

export function discoverRepositories(root: string, depth = 2): Array<string> {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) {
    return [];
  }
  if (existsSync(join(root, ".git"))) {
    return lstatSync(join(root, ".git")).isDirectory() ? [realpathSync(root)] : [];
  }
  if (depth === 0) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => discoverRepositories(join(root, entry.name), depth - 1));
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function busy(path: string, openPaths: ReadonlyArray<string>): boolean {
  return openPaths.some((open) => inside(open, path));
}

export function openFiles(home: string, runner: Runner = run): Array<string> {
  // -w suppresses warning-induced nonzero exits (for example unreadable mounts);
  // real failures still exit nonzero and fail closed below.
  const output = checked(runner, home, "lsof", [
    "-w",
    "-n",
    "-P",
    "-a",
    "-u",
    String(process.getuid?.()),
    "-F0n",
  ]);
  const paths = output
    .split(/[\0\n]/)
    .filter((field) => field.startsWith("n/"))
    .map((field) => field.slice(1));
  if (paths.length === 0) {
    throw new Error("process activity unavailable; retained local work");
  }
  return paths;
}

function unfinished(repo: string, runner: Runner): boolean {
  return [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "index.lock",
  ].some((name) =>
    existsSync(resolve(repo, checked(runner, repo, "git", ["rev-parse", "--git-path", name]))),
  );
}

const longLived = (branch: string) =>
  /^refs\/heads\/(main|master|develop|dev|production|staging|release)(\/|$)/.test(branch);

export function candidates(
  repo: string,
  roots: ReadonlyArray<string>,
  openPaths: ReadonlyArray<string>,
  runner: Runner = run,
) {
  const git = (...args: Array<string>) => checked(runner, repo, "git", args);
  if (
    git("rev-parse", "--show-toplevel") !== realpathSync(repo) ||
    !lstatSync(join(repo, ".git")).isDirectory()
  ) {
    throw new Error("standalone owning checkout required");
  }
  const policy = runner(repo, "git", ["config", "--local", "--get", "dotfiles.hygiene"]);
  if (policy.status === 0 && policy.stdout.trim() === "skip") {
    return {
      eligible: [],
      kept: [{ target: repo, result: "excluded by local dotfiles.hygiene=skip" }],
    };
  }
  if (policy.status !== 0 && policy.status !== 1) {
    throw new Error("local hygiene policy unavailable");
  }
  const worktrees = parseWorktrees(git("worktree", "list", "--porcelain", "-z"));
  const checkedOut = new Set(worktrees.map((worktree) => worktree.branch));
  const refs = git("for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads")
    .split("\n")
    .filter(Boolean);
  const possibleTree = worktrees
    .slice(1)
    .some(
      (tree) =>
        !longLived(tree.branch) &&
        !tree.locked &&
        !tree.prunable &&
        roots.some((root) => tree.path !== root && inside(tree.path, root)),
    );
  const possibleBranch = refs.some((row) => {
    const [branch] = row.split("\0");
    return branch && !longLived(branch) && !checkedOut.has(branch) && !busy(repo, openPaths);
  });
  if (!possibleTree && !possibleBranch) {
    return { eligible: [], kept: [] };
  }
  // Observe the remote's current default rather than trusting a stale origin/HEAD.
  const remote = git("ls-remote", "--symref", "origin", "HEAD", "refs/heads/*");
  const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remote)?.[1];
  const target = /^([0-9a-f]{40,64})\tHEAD$/m.exec(remote)?.[1];
  if (!defaultBranch || !target) {
    throw new Error("remote default branch unavailable");
  }
  if (runner(repo, "git", ["cat-file", "-e", `${target}^{commit}`]).status !== 0) {
    return {
      eligible: [],
      kept: [
        {
          target: repo,
          result: "remote default history missing locally; retained for normal sync",
        },
      ],
    };
  }
  const remoteHeads = new Set(
    remote.split("\n").flatMap((line) => {
      const match = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line);
      return match ? [match[1]] : [];
    }),
  );
  const eligible: Array<Candidate> = [];
  const kept: Array<Entry> = [];
  const merged = (head: string) =>
    runner(repo, "git", ["merge-base", "--is-ancestor", head, target]).status === 0;
  const protectedBranch = (branch: string) => {
    const name = branch.replace(/^refs\/heads\//, "");
    if (longLived(branch)) {
      return true;
    }
    const upstream = git("for-each-ref", "--format=%(upstream)", branch);
    if (remoteHeads.has(name)) {
      return true;
    }
    if (upstream.startsWith("refs/remotes/origin/")) {
      return remoteHeads.has(upstream.slice("refs/remotes/origin/".length));
    }
    return Boolean(upstream);
  };
  const worktreeReason = (tree: Worktree): string | undefined => {
    if (
      tree.path === repo ||
      !roots.some((root) => inside(tree.path, root) && tree.path !== root)
    ) {
      return "outside cleanup roots";
    }
    if (tree.locked || tree.prunable) {
      return "locked or missing worktree";
    }
    if (
      !existsSync(tree.path) ||
      lstatSync(tree.path).isSymbolicLink() ||
      realpathSync(tree.path) !== tree.path
    ) {
      return "non-canonical worktree path";
    }
    // A detached worktree has no branch to protect; merged() below is what proves
    // its HEAD is already in the remote default and nothing unique is lost.
    if (tree.branch) {
      if (tree.branch === `refs/heads/${defaultBranch}`) {
        return "default branch";
      }
      if (protectedBranch(tree.branch)) {
        return "long-lived branch or existing upstream";
      }
    }
    if (busy(tree.path, openPaths)) {
      return "active process or open file";
    }
    if (unfinished(tree.path, runner)) {
      return "unfinished Git operation";
    }
    if (checked(runner, tree.path, "git", ["status", "--porcelain", "--untracked-files=all"])) {
      return "dirty worktree";
    }
    const ignored = checked(runner, tree.path, "git", [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    if (
      ignored
        .split("\0")
        .filter(Boolean)
        .some((path) => !/(^|\/)node_modules\/$/.test(path))
    ) {
      return "ignored local files retained";
    }
    if (!merged(tree.head)) {
      return "HEAD not in remote default (including squash merges)";
    }
    return undefined;
  };
  for (const tree of worktrees.slice(1)) {
    const reason = worktreeReason(tree);
    if (reason) {
      kept.push({ target: tree.path, result: reason });
    } else {
      eligible.push({ kind: "worktree", path: tree.path, branch: tree.branch, head: tree.head });
    }
  }
  for (const row of refs) {
    const [branch, head] = row.split("\0");
    if (
      !branch ||
      !head ||
      branch === `refs/heads/${defaultBranch}` ||
      checkedOut.has(branch) ||
      protectedBranch(branch)
    ) {
      continue;
    }
    if (busy(repo, openPaths) || unfinished(repo, runner)) {
      kept.push({ target: branch, result: "owning checkout active" });
    } else if (merged(head)) {
      eligible.push({ kind: "branch", path: repo, branch, head });
    } else {
      kept.push({
        target: branch,
        result: "commits not in remote default (including squash merges)",
      });
    }
  }
  return { eligible, kept };
}

export function cleanRepository(
  repo: string,
  roots: ReadonlyArray<string>,
  previous: Readonly<Record<string, { head: string; since: number }>>,
  now: number,
  apply: boolean,
  activity: () => Array<string>,
  runner: Runner = run,
) {
  const initial = candidates(repo, roots, activity(), runner);
  if (apply && initial.eligible.length) {
    checked(runner, repo, "git", ["remote", "prune", "origin"]);
  }
  const next: Record<string, { head: string; since: number }> = {};
  const entries = [...initial.kept];
  for (const candidate of initial.eligible) {
    const key = JSON.stringify([repo, candidate.kind, candidate.path, candidate.branch]);
    const old = previous[key];
    const since = old?.head === candidate.head && old.since <= now ? old.since : now;
    next[key] = { head: candidate.head, since };
    if (!apply || now - since < gracePeriod) {
      entries.push({
        target: candidate.kind === "branch" ? candidate.branch : candidate.path,
        result: now - since < gracePeriod ? "eligible; three-day grace period" : "would remove",
      });
      continue;
    }
    const fresh = candidates(repo, roots, activity(), runner).eligible.find(
      (item) =>
        item.kind === candidate.kind &&
        item.path === candidate.path &&
        item.branch === candidate.branch &&
        item.head === candidate.head,
    );
    if (!fresh) {
      delete next[key];
      entries.push({ target: candidate.path, result: "state changed; retained" });
      continue;
    }
    if (candidate.kind === "worktree") {
      const gitDirectory = checked(runner, candidate.path, "git", [
        "rev-parse",
        "--absolute-git-dir",
      ]);
      const changedAt = Math.max(lastChanged(candidate.path), lastChanged(gitDirectory));
      if (now - changedAt < gracePeriod) {
        next[key] = { head: candidate.head, since: now };
        entries.push({
          target: candidate.path,
          result: "changed within three days; grace period restarted",
        });
        continue;
      }
    }
    const args =
      candidate.kind === "worktree"
        ? ["worktree", "remove", candidate.path]
        : ["branch", "-d", "--", candidate.branch.replace(/^refs\/heads\//, "")];
    // No force flags: Git rechecks dirty/locked worktrees and checked-out branches.
    const result = runner(repo, "git", args);
    // Eligibility is judged against the remote default, but `git branch -d`
    // judges against local HEAD. A lagging checkout makes them disagree forever,
    // so say which one to fix instead of reporting an opaque refusal.
    const behind =
      result.status !== 0 &&
      candidate.kind === "branch" &&
      runner(repo, "git", ["merge-base", "--is-ancestor", candidate.head, "HEAD"]).status !== 0;
    entries.push({
      target: candidate.kind === "branch" ? candidate.branch : candidate.path,
      result:
        result.status === 0
          ? "removed"
          : behind
            ? "local default branch is behind the remote; pull before removal"
            : "Git refused removal; retained",
    });
    if (result.status === 0) {
      delete next[key];
    }
  }
  return { entries, candidates: next };
}

export function lastChanged(root: string): number {
  const pending = [root];
  let latest = 0;
  let visited = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) {
      break;
    }
    if (++visited > 100_000) {
      throw new Error("worktree activity inspection limit exceeded; retained local work");
    }
    const info = lstatSync(path);
    latest = Math.max(latest, info.mtimeMs, info.ctimeMs, info.birthtimeMs);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        // Dependency contents are regenerable; the directory itself still
        // records installs/removals without scanning an entire package store.
        if (entry.name === "node_modules" && entry.isDirectory()) {
          const dependency = lstatSync(join(path, entry.name));
          latest = Math.max(latest, dependency.mtimeMs, dependency.ctimeMs, dependency.birthtimeMs);
        } else {
          pending.push(join(path, entry.name));
        }
      }
    }
  }
  return latest;
}
