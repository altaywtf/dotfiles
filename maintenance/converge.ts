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

// Local work blocks a fast-forward without making the checkout unusable.
class LocalWork extends UpdateFailure {}

export function syncCheckout(repo: string, label = "dotfiles checkout"): string {
  const git = (...args: string[]) => run(repo, "git", args, true);
  const probe = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(repo)) {
    throw new UpdateFailure(`use the root of the ${label}`);
  }
  const remote = git("symbolic-ref", "refs/remotes/origin/HEAD");
  const branch = defaultBranchFromRemoteHead(remote);
  if (!branch) throw new UpdateFailure(`${label} has no default branch on origin`);
  const head = () => probe("symbolic-ref", "-q", "HEAD").stdout.trim();
  const before = { revision: git("rev-parse", "HEAD"), head: head() };
  git("fetch", "--no-tags", "origin", `+refs/heads/${branch}:${remote}`);
  if (git("rev-parse", "HEAD") !== before.revision || head() !== before.head) {
    throw new UpdateFailure(
      `${label} HEAD or branch changed during fetch; retry when the checkout is idle`,
    );
  }
  const clean = () => {
    if (git("status", "--porcelain", "--untracked-files=all"))
      throw new LocalWork(`${label} has local changes; commit or resolve them before retrying`);
    for (const state of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      if (existsSync(resolve(repo, git("rev-parse", "--git-path", state))))
        throw new LocalWork(`finish the current Git operation in the ${label}`);
    }
  };
  clean();
  if (before.head !== `refs/heads/${branch}`)
    throw new LocalWork(`${label} is not on its default branch ${branch}`);
  if (git("rev-parse", "--symbolic-full-name", "@{upstream}") !== remote)
    throw new UpdateFailure(`${label} updates require the default branch tracking origin`);
  const ancestry = probe("merge-base", "--is-ancestor", "HEAD", remote);
  if (ancestry.error) throw ancestry.error;
  if (ancestry.status === 1)
    throw new LocalWork(`${label} has commits that are not on origin/${branch}`);
  if (ancestry.status !== 0)
    throw new UpdateFailure(`${label} ancestry check failed with git status ${ancestry.status}`);
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

// Git writes changed files under the process umask; a shell's 022 would widen
// an owner-only fragment, even briefly, and profile setup then rejects it.
function privately<T>(update: () => T): T {
  const previous = process.umask(0o077);
  try {
    return update();
  } finally {
    process.umask(previous);
  }
}

export function converge(repo: string, lockOptions: LockOptions = {}, home = homedir()): void {
  const release = acquireCheckoutLock(repo, lockOptions);
  try {
    let revision: string;
    try {
      revision = syncCheckout(repo);
    } catch (error) {
      if (!(error instanceof LocalWork)) throw error;
      console.warn(`Kept ${repo}: ${error.message}; convergence skipped`);
      return;
    }
    const failed: string[] = [];
    for (const checkout of ruleSourceCheckouts(home, repo)) {
      try {
        const advanced = privately(() => syncCheckout(checkout, "agent rule checkout"));
        console.log(`Agent rule checkout ${checkout} at ${advanced}`);
      } catch (error) {
        if (error instanceof LocalWork) console.warn(`Kept ${checkout}: ${error.message}`);
        else if (error instanceof UpdateFailure) failed.push(`${checkout}: ${error.message}`);
        else throw error;
      }
    }
    console.log(`Converging dotfiles ${revision}`);
    run(repo, "mise", ["trust", join(repo, "mise.toml")]);
    // The shell bootstrap selects the new repository Node pin before loading dependencies.
    run(repo, join(repo, "dotfiles"), ["maintain"]);
    console.log(`Dotfiles converged at ${revision}`);
    if (failed.length > 0)
      throw new UpdateFailure(`agent rule checkouts not updated:\n${failed.join("\n")}`);
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
