import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ConfigEdit } from "./config.ts";
import type { Schema } from "effect";

// Codex creates its state with the process umask; the devbox audit requires
// these directories and matching files to stay private.
export const codexPrivateDirectories = [
  "",
  "sessions",
  "archived_sessions",
  "shell_snapshots",
  "log",
  "app-server-control",
] as const;
export const codexPrivateFileDepth = 2;
export const codexPrivateFilePattern = /(?:[.]sqlite3?|[.]db(?:-.*)?|[.]log)$|\/log\//;

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function childDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

const checkout = (path: string) => isDirectory(join(path, ".git"));

// Checkouts sit at ROOT/NAME or ROOT/OWNER/NAME. Linked worktrees carry a
// .git file and resolve to their main checkout's trust, so only primary
// checkouts qualify.
export function discoverCheckouts(root: string): string[] {
  return childDirectories(root)
    .flatMap((path) => [path, ...childDirectories(path)])
    .filter(checkout)
    .sort();
}

// Codex parses quoted key-path segments; paths that would need escaping are skipped.
function projectKey(path: string): string | undefined {
  return /["\\\p{Cc}]/u.test(path) ? undefined : `projects."${path}"`;
}

function withinRoot(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  return parts.length <= 2 && parts.every((part) => part !== "" && part !== "..");
}

// Adds missing checkouts and drops entries for checkout-shaped paths under the
// root that no longer exist. Existing entries keep their trust level, and paths
// outside the root are never touched.
export function projectTrustEdits(
  root: string,
  checkouts: readonly string[],
  existing: Readonly<Record<string, Schema.Json>>,
  exists: (path: string) => boolean = existsSync,
): ConfigEdit[] {
  const edits: ConfigEdit[] = [];
  for (const path of checkouts) {
    const key = projectKey(path);
    if (key && withinRoot(root, path) && !Object.hasOwn(existing, path))
      edits.push({ keyPath: `${key}.trust_level`, value: "trusted", mergeStrategy: "upsert" });
  }
  for (const path of Object.keys(existing).sort()) {
    const key = projectKey(path);
    if (key && withinRoot(root, path) && !exists(path))
      edits.push({ keyPath: key, value: null, mergeStrategy: "replace" });
  }
  return edits;
}

function walkFiles(path: string, depth: number): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return depth > 0 ? walkFiles(child, depth - 1) : [];
      return entry.isFile() ? [child] : [];
    });
  } catch {
    return [];
  }
}

export function restrictCodexState(codexHome: string): string[] {
  const changed: string[] = [];
  const restrict = (path: string, mode: number) => {
    const current = lstatSync(path).mode & 0o777;
    if (current === mode) return;
    chmodSync(path, mode);
    changed.push(path);
  };
  for (const name of codexPrivateDirectories) {
    const path = join(codexHome, name);
    if (isDirectory(path)) restrict(path, 0o700);
  }
  for (const path of walkFiles(codexHome, codexPrivateFileDepth)) {
    if (!codexPrivateFilePattern.test(path)) continue;
    const mode = lstatSync(path).mode & 0o777;
    if (mode & 0o077) restrict(path, mode & 0o700);
  }
  return changed;
}
