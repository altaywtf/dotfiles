#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { Console, Effect } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runMain } from "../lib/program.ts";

type Update = {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function git(args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    fail(`cannot run git: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    fail(`${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function objectExists(revision: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", revision], { stdio: "ignore" });
  return result.status === 0;
}

function parseUpdates(input: string, oidLength: number): Update[] {
  const updates: Update[] = [];
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      fail(`invalid pre-push update on line ${index + 1}: expected four fields`);
    }
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    for (const [label, oid] of [
      ["local", localOid],
      ["remote", remoteOid],
    ] as const) {
      if (!new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid)) {
        fail(`invalid ${label} object id on line ${index + 1}`);
      }
    }
    updates.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return updates;
}

function remoteNames(remoteName: string, remoteLocation: string): string[] {
  const names = git(["remote"], true).split(/\r?\n/).filter(Boolean);
  if (names.includes(remoteName)) {
    return [remoteName];
  }
  return names.filter((name) => {
    const fetchUrl = git(["remote", "get-url", name], true);
    const pushUrl = git(["remote", "get-url", "--push", name], true);
    return fetchUrl === remoteLocation || pushUrl === remoteLocation;
  });
}

function commitsForUpdate(update: Update, zeroOid: string, matchingRemotes: string[]): string[] {
  if (update.localOid === zeroOid) {
    return [];
  }
  if (!objectExists(update.localOid)) {
    fail(
      `missing local object ${update.localOid} for ${update.localRef}; fetch or repair the repository before pushing`,
    );
  }
  if (!objectExists(`${update.localOid}^{commit}`)) {
    return [];
  }

  const args = ["rev-list", update.localOid];
  if (update.remoteOid !== zeroOid) {
    if (!objectExists(`${update.remoteOid}^{commit}`)) {
      fail(
        `missing remote commit ${update.remoteOid} for ${update.remoteRef}; fetch the remote before pushing`,
      );
    }
    args.push(`^${update.remoteOid}`);
  } else {
    if (matchingRemotes.length > 0) {
      args.push("--not", ...matchingRemotes.map((remote) => `--remotes=${remote}`));
    }
  }

  const output = git(args);
  return output ? output.split(/\r?\n/) : [];
}

function verifyOutgoingCommits(input: string, remoteName: string, remoteLocation: string): number {
  const format = git(["rev-parse", "--show-object-format"]);
  const oidLength =
    format === "sha256"
      ? 64
      : format === "sha1"
        ? 40
        : fail(`unsupported Git object format ${format}`);
  const zeroOid = "0".repeat(oidLength);
  const updates = parseUpdates(input, oidLength);
  const matchingRemotes = remoteNames(remoteName, remoteLocation);
  const commits = new Set<string>();

  for (const update of updates) {
    for (const commit of commitsForUpdate(update, zeroOid, matchingRemotes)) {
      commits.add(commit);
    }
  }

  for (const commit of commits) {
    const result = spawnSync("git", ["diff-tree", "--check", "--root", "-m", "-r", commit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      fail(`cannot inspect outgoing commit ${commit}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const diagnostic = (result.stdout || result.stderr).trim();
      fail(
        `outgoing commit ${commit} has whitespace or conflict-marker errors${diagnostic ? `:\n${diagnostic}` : ""}`,
      );
    }
  }

  return commits.size;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const program = Effect.gen(function* () {
    const input = yield* Effect.try({
      try: () => readFileSync(0, "utf8"),
      catch: (error) => error,
    });
    const count = yield* Effect.try({
      try: () => verifyOutgoingCommits(input, process.argv[2] ?? "", process.argv[3] ?? ""),
      catch: (error) => error,
    });
    yield* Console.log(`ok outgoing commit hygiene (${count} commit${count === 1 ? "" : "s"})`);
  });
  runMain(program);
}
