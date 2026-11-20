// Pure checkout-readiness rules shared by the unattended convergence job and
// the devbox installer bundle. Callers run Git themselves (spawnSync or the
// Effect CommandRunner) and pass the raw outputs in.
// This module must stay dependency-free: converge.ts imports it before the
// checkout's locked dependencies are installed.

const remoteHeadPrefix = "refs/remotes/origin/";

// `git symbolic-ref refs/remotes/origin/HEAD` -> branch name, or undefined
// when origin/HEAD is unset.
export function defaultBranchFromRemoteHead(remoteHead: string): string | undefined {
  const ref = remoteHead.trim();
  return ref.startsWith(remoteHeadPrefix) ? ref.slice(remoteHeadPrefix.length) : undefined;
}

// `git status --porcelain` output -> reason, or undefined when clean.
export function dirtyCheckoutReason(status: string): string | undefined {
  const lines = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  return `uncommitted changes: ${lines.map((line) => line.slice(3)).join(", ")}`;
}

export type CheckoutPosition = {
  readonly headRef: string; // git symbolic-ref HEAD (fails when detached)
  readonly remoteHead: string; // git symbolic-ref refs/remotes/origin/HEAD
  readonly head: string; // git rev-parse HEAD
  readonly remoteTip: string; // git rev-parse refs/remotes/origin/<default>
};

// Reason HEAD is not the default branch at origin's tip (detached, other
// branch, ahead, or behind), or undefined when it is exactly there.
export function unpublishedCheckoutReason(position: CheckoutPosition): string | undefined {
  const branch = defaultBranchFromRemoteHead(position.remoteHead);
  if (!branch) {
    return "origin has no default branch (refs/remotes/origin/HEAD is unset)";
  }
  if (position.headRef.trim() !== `refs/heads/${branch}`) {
    return `HEAD is not on the default branch ${branch}`;
  }
  const head = position.head.trim();
  const tip = position.remoteTip.trim();
  if (!head || head !== tip) {
    return `HEAD ${head.slice(0, 12)} is not origin/${branch} ${tip.slice(0, 12)}`;
  }
  return undefined;
}
