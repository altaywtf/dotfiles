#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { CommandRunner } from "../lib/command.ts";
import { cacheCleanup } from "./cache-cleanup.ts";
import { acquireDirectoryLock } from "../lib/lock.ts";
import { capLogs, dailyLog, logDirectory } from "./logs.ts";
import { cleanRepository, discoverRepositories, openFiles } from "./repositories.ts";

type Entry = { target: string; result: string };

const interval = 3 * 86400_000;
const State = Schema.Struct({
  lastRun: Schema.Number,
  lastCache: Schema.Number,
  candidates: Schema.Record(
    Schema.String,
    Schema.Struct({ head: Schema.String, since: Schema.Number }),
  ),
});
type State = typeof State.Type;
export function readState(statePath: string): { state: State; recovered: boolean } {
  const empty: State = { lastRun: 0, lastCache: 0, candidates: {} };
  let text: string;
  try {
    text = readFileSync(statePath, "utf8");
  } catch (error) {
    // Only a missing file is an empty state. Any other read failure (EACCES,
    // EIO, EISDIR) must not silently restart grace periods or bypass the
    // scheduled interval, so it propagates and fails the run.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: empty, recovered: false };
    throw error;
  }
  try {
    return {
      state: Schema.decodeUnknownSync(Schema.fromJsonString(State))(text),
      recovered: false,
    };
  } catch {
    // Undecodable state only restarts every grace period and the cache
    // interval — strictly conservative — instead of failing every later run.
    return { state: empty, recovered: true };
  }
}

export async function hygiene(
  home: string,
  apply: boolean,
  scheduled: boolean,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const directory = join(home, ".local/state/dotfiles");
  const statePath = join(directory, "hygiene.json");
  const { state, recovered } = readState(statePath);
  if (recovered)
    console.error(
      `Hygiene state was undecodable and is treated as empty; grace periods restart: ${statePath}`,
    );
  if (scheduled && now >= state.lastRun && now - state.lastRun < interval) {
    console.log("Host hygiene: next run is not due.");
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let release: () => void;
  // A lock left by a dead or pre-reboot process is reclaimed automatically;
  // a live or ambiguous owner still fails the run for inspection.
  try {
    release = acquireDirectoryLock(join(directory, "hygiene.lock"));
  } catch (cause) {
    throw new Error("hygiene lock exists; check for an active or interrupted cleanup", { cause });
  }
  try {
    // Eligibility rests entirely on the per-worktree checks below, which retain
    // anything dirty, busy, protected, detached, or not yet in the remote default.
    const roots = [".t3/worktrees", ".codex/worktrees", ".claude/worktrees", "projects"].map(
      (path) => join(home, path),
    );
    const next: Record<string, { head: string; since: number }> = {};
    const reports: Record<string, Entry[]> = {};
    let failed = false;
    const activity = () => openFiles(home);
    for (const repo of discoverRepositories(join(home, "projects"))) {
      try {
        const result = cleanRepository(repo, roots, state.candidates, now, apply, activity);
        reports[repo] = result.entries;
        Object.assign(next, result.candidates);
      } catch (error) {
        failed = true;
        reports[repo] = [
          { target: repo, result: error instanceof Error ? error.message : "inspection failed" },
        ];
      }
    }
    const cacheDue = !scheduled || now - state.lastCache >= interval;
    const cache = cacheDue
      ? await Effect.runPromise(
          cacheCleanup(home, apply).pipe(
            Effect.provide(CommandRunner.layer),
            Effect.provide(NodeServices.layer),
          ),
          { signal },
        )
      : { status: 0, stdout: "Cache cleanup is not due." };
    console.log(cache.stdout);
    failed ||= cache.status !== 0;
    const logs = apply ? capLogs(logDirectory(home)) : [];
    failed ||= logs.some((entry) => entry.result.startsWith("log cap failed"));
    const report = JSON.stringify(
      {
        startedAt: new Date(now).toISOString(),
        finishedAt: new Date().toISOString(),
        apply,
        repositories: reports,
        cacheExitCode: cache.status,
        logs,
      },
      null,
      2,
    );
    console.log(report);
    if (apply) {
      writeFileSync(dailyLog(home, "hygiene", now), `${cache.stdout}\n${report}\n`, {
        flag: "a",
        mode: 0o600,
      });
      const temporary = `${statePath}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({
          lastRun: failed ? 0 : now,
          lastCache: cacheDue && cache.status === 0 ? now : state.lastCache,
          candidates: next,
        }),
        { mode: 0o600 },
      );
      renameSync(temporary, statePath);
    }
    if (failed) throw new Error("some hygiene checks failed; inspect the report");
  } finally {
    release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const controller = new AbortController();
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal;
    controller.abort();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    if (
      process.getuid?.() === 0 ||
      process.argv.slice(2).some((arg) => !["--apply", "--scheduled", "--dry-run"].includes(arg))
    ) {
      throw new Error("Usage (as the owning user): hygiene.ts [--apply] [--scheduled] [--dry-run]");
    }
    await hygiene(
      homedir(),
      process.argv.includes("--apply") && !process.argv.includes("--dry-run"),
      process.argv.includes("--scheduled") && !process.argv.includes("--dry-run"),
      Date.now(),
      controller.signal,
    );
  } catch (error) {
    if (!interrupted) {
      console.error(error instanceof Error ? error.message : "hygiene failed");
      process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    // Preserve signal termination after the Effect scopes and hygiene lock close.
    if (interrupted) process.kill(process.pid, interrupted);
  }
}
