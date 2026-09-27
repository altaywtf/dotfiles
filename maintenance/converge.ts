#!/usr/bin/env node

// This entrypoint must run before the checkout's locked dependencies are installed.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBranchFromRemoteHead } from "../lib/git-checkout.ts";
import { acquireDirectoryLock, type LockOptions } from "../lib/lock.ts";

// Concurrent manual and scheduled convergence wait for the checkout owner.
const lockWaitMs = 15 * 60_000;

class UpdateFailure extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function run(repo: string, command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_UPGRADE_QUIT_CASKS: "1",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new UpdateFailure(
      `${command} ${args[0]} failed${capture ? `: ${result.stderr?.trim()}` : ""}`,
      result.status ?? 1,
    );
  return result.stdout?.trim() ?? "";
}

export function syncCheckout(repo: string, label = "dotfiles checkout"): string {
  const git = (...args: string[]) => run(repo, "git", args, true);
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(repo)) {
    throw new UpdateFailure(`use the root of the ${label}`);
  }
  const clean = () => {
    if (git("status", "--porcelain", "--untracked-files=all"))
      throw new UpdateFailure(`${label} has local changes; commit or resolve them before retrying`);
    for (const state of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      if (existsSync(resolve(repo, git("rev-parse", "--git-path", state))))
        throw new UpdateFailure(`finish the current Git operation in the ${label}`);
    }
  };
  clean();
  const remote = git("symbolic-ref", "refs/remotes/origin/HEAD");
  const branch = defaultBranchFromRemoteHead(remote);
  if (
    !branch ||
    git("symbolic-ref", "HEAD") !== `refs/heads/${branch}` ||
    git("rev-parse", "--symbolic-full-name", "@{upstream}") !== remote
  ) {
    throw new UpdateFailure(`${label} updates require the default branch tracking origin`);
  }
  const before = git("rev-parse", "HEAD");
  git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:${remote}`);
  clean();
  if (
    git("rev-parse", "HEAD") !== before ||
    git("symbolic-ref", "HEAD") !== `refs/heads/${branch}`
  ) {
    throw new UpdateFailure(
      `${label} HEAD or branch changed during fetch; retry when the checkout is idle`,
    );
  }
  git("merge-base", "--is-ancestor", "HEAD", remote);
  git("merge", "--ff-only", "--no-autostash", "--no-edit", remote);
  clean();
  return git("rev-parse", "HEAD");
}

export function acquireCheckoutLock(repo: string, options: LockOptions = {}): () => void {
  const gitDir = run(repo, "git", ["rev-parse", "--absolute-git-dir"], true);
  const lock = join(gitDir, "dotfiles-converge.lock");
  try {
    return acquireDirectoryLock(lock, { waitMs: lockWaitMs, ...options });
  } catch (cause) {
    throw new Error(
      `dotfiles convergence lock unavailable: ${lock}; check for an active or interrupted update`,
      { cause },
    );
  }
}

// Local rule fragments may link into another checkout, whose default branch
// then has to advance for rendered rules to follow it.
function ruleSourceCheckouts(home: string, repo: string): string[] {
  const checkouts = new Set<string>();
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const fragment = join(home, ".config/dotfiles", name);
    let target: string;
    try {
      if (!lstatSync(fragment).isSymbolicLink()) continue;
      target = realpathSync(fragment);
    } catch {
      continue; // profile setup reports broken fragment links
    }
    const root = spawnSync("git", ["-C", dirname(target), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (root.status === 0) checkouts.add(realpathSync(root.stdout.trim()));
  }
  checkouts.delete(realpathSync(repo));
  return [...checkouts];
}

export function converge(repo: string, lockOptions: LockOptions = {}, home = homedir()): void {
  const release = acquireCheckoutLock(repo, lockOptions);
  try {
    const revision = syncCheckout(repo);
    const skipped: string[] = [];
    for (const checkout of ruleSourceCheckouts(home, repo)) {
      try {
        console.log(
          `Agent rule checkout ${checkout} at ${syncCheckout(checkout, "agent rule checkout")}`,
        );
      } catch (error) {
        if (!(error instanceof UpdateFailure)) throw error;
        skipped.push(`${checkout}: ${error.message}`);
      }
    }
    console.log(`Converging dotfiles ${revision}`);
    run(repo, "mise", ["trust", join(repo, "mise.toml")]);
    // The shell bootstrap selects the new repository Node pin before loading dependencies.
    run(repo, join(repo, "dotfiles"), ["maintain"]);
    console.log(`Dotfiles converged at ${revision}`);
    if (skipped.length > 0)
      throw new UpdateFailure(`agent rule checkouts not updated:\n${skipped.join("\n")}`);
  } finally {
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2 || process.getuid?.() === 0)
      throw new UpdateFailure("run dotfiles convergence as the enrolled user, without arguments");
    converge(resolve(import.meta.dirname, ".."));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UpdateFailure ? error.exitCode : 1;
  }
}
