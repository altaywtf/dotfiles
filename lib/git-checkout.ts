const remoteHeadPrefix = "refs/remotes/origin/";

export function defaultBranchFromRemoteHead(remoteHead: string): string | undefined {
  const ref = remoteHead.trim();

  return ref.startsWith(remoteHeadPrefix) ? ref.slice(remoteHeadPrefix.length) : undefined;
}

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
  readonly headRef: string;
  readonly remoteHead: string;
  readonly head: string;
  readonly remoteTip: string;
};

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
