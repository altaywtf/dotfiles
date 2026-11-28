import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  defaultBranchFromRemoteHead,
  dirtyCheckoutReason,
  unpublishedCheckoutReason,
} from "./git-checkout.ts";

const sha = "a".repeat(40);

const published = {
  headRef: "refs/heads/main\n",
  remoteHead: "refs/remotes/origin/main\n",
  head: `${sha}\n`,
  remoteTip: `${sha}\n`,
};

test("the default branch comes from origin/HEAD only", () => {
  assert.equal(defaultBranchFromRemoteHead("refs/remotes/origin/main\n"), "main");
  assert.equal(defaultBranchFromRemoteHead("refs/heads/main"), undefined);
  assert.equal(defaultBranchFromRemoteHead(""), undefined);
});

test("porcelain status lines name the dirty paths", () => {
  assert.equal(dirtyCheckoutReason(""), undefined);
  assert.equal(dirtyCheckoutReason("\n"), undefined);
  assert.equal(
    dirtyCheckoutReason(" M lib/program.ts\n?? new.ts\n"),
    "uncommitted changes: lib/program.ts, new.ts",
  );
});

test("only the default branch exactly at origin's tip is published", () => {
  assert.equal(unpublishedCheckoutReason(published), undefined);
  assert.match(
    unpublishedCheckoutReason({ ...published, remoteHead: "" }) ?? "",
    /no default branch/,
  );
  assert.match(
    unpublishedCheckoutReason({ ...published, headRef: "refs/heads/feature" }) ?? "",
    /not on the default branch main/,
  );
  assert.match(
    unpublishedCheckoutReason({ ...published, headRef: "" }) ?? "",
    /not on the default branch/,
    "detached HEAD",
  );
  assert.match(
    unpublishedCheckoutReason({ ...published, head: "b".repeat(40) }) ?? "",
    /is not origin\/main/,
    "ahead or behind",
  );
  assert.match(
    unpublishedCheckoutReason({ ...published, head: "", remoteTip: "" }) ?? "",
    /is not origin\/main/,
  );
});
