import { Console, DateTime, Effect, FileSystem, Option } from "effect";
import { basename, dirname, join } from "node:path";
import { CommandRunner } from "../lib/command.ts";
import { CliFailure, fail } from "../lib/program.ts";

export type ChezmoiContext = {
  readonly repoRoot: string;
  readonly home: string;
  readonly baseArgs: readonly string[];
  readonly dryRun: boolean;
};

const runChezmoi = Effect.fn("runChezmoi")(function* (
  context: ChezmoiContext,
  args: readonly string[],
  output: "capture" | "inherit" = "capture",
) {
  const runner = yield* CommandRunner;
  const result = yield* runner
    .run("chezmoi", [...context.baseArgs, ...args], {
      cwd: context.repoRoot,
      stdin: "inherit",
      output,
    })
    .pipe(Effect.mapError((error) => new CliFailure({ exitCode: 1, message: error.message })));
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    return yield* fail(
      `chezmoi ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ""}`,
      result.status,
    );
  }
  return result;
});

const matchesManagedTarget = Effect.fn("matchesManagedTarget")(function* (
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink",
) {
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(target).pipe(Effect.option);
  const exists = yield* fs.exists(target);
  if (!exists && Option.isNone(link)) return true;
  if (expectedType === "symlink" && Option.isSome(link)) {
    const expected = yield* runChezmoi(context, ["cat", target]);
    return link.value === expected.stdout.trimEnd();
  }
  if (expectedType === "file" && exists && Option.isNone(link)) {
    const [actual, expected] = yield* Effect.all([
      fs.readFileString(target),
      runChezmoi(context, ["cat", target]).pipe(Effect.map((result) => result.stdout)),
    ]);
    return actual === expected;
  }
  return false;
});

// Every drifted apply creates one timestamped backup, so enrolled hosts
// accumulate them forever; keep only the most recent backup per target. The
// backup written by this run is the most recent by definition and is never a
// prune candidate: timestamps come from the host clock, so a clock behind an
// existing backup would otherwise prune the file just written.
export const pruneOlderBackups = Effect.fn("pruneOlderBackups")(function* (
  target: string,
  created?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = dirname(target);
  const prefix = `${basename(target)}.backup.`;
  const backups = (yield* fs.readDirectory(directory))
    .filter((entry) => entry.startsWith(prefix) && /^\d{14}$/.test(entry.slice(prefix.length)))
    .filter((entry) => created === undefined || join(directory, entry) !== created)
    .sort();
  for (const entry of created === undefined ? backups.slice(0, -1) : backups) {
    yield* fs.remove(join(directory, entry), { recursive: true, force: true });
    yield* Console.log(`removed older backup ${join(directory, entry)}`);
  }
});

const backupPath = Effect.fn("backupPath")(function* (
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink",
) {
  const matches = yield* matchesManagedTarget(context, target, expectedType);
  if (matches) return;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* DateTime.now;
  const timestamp = DateTime.formatIso(now).replaceAll(/\D/g, "").slice(0, 14);
  const backup = `${target}.backup.${timestamp}`;
  if (context.dryRun) {
    yield* Console.log(`would back up ${target} -> ${backup}`);
    return;
  }
  const link = yield* fs.readLink(target).pipe(Effect.option);
  if (expectedType === "file" && Option.isNone(link)) {
    yield* fs.copy(target, backup, { preserveTimestamps: true });
  } else {
    yield* fs.rename(target, backup);
  }
  yield* Console.log(`backed up ${target} -> ${backup}`);
  yield* pruneOlderBackups(target, backup);
});

const replaceAgentPath = Effect.fn("replaceAgentPath")(function* (
  context: ChezmoiContext,
  target: string,
  expectedType: "file" | "symlink",
) {
  const matches = yield* matchesManagedTarget(context, target, expectedType);
  if (matches) return;
  if (context.dryRun) {
    yield* Console.log(`would replace generated agent rules at ${target}`);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(target, { force: true });
  yield* Console.log(`removed conflicting generated agent rules at ${target}`);
});

const removeLegacyAgentRules = Effect.fn("removeLegacyAgentRules")(function* (
  context: ChezmoiContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const legacy = join(context.home, "AGENTS.md");
  if (!(yield* fs.exists(legacy))) return;
  if (context.dryRun) {
    yield* Console.log(`would remove legacy agent rules at ${legacy}`);
    return;
  }
  yield* fs.remove(legacy, { force: true });
  yield* Console.log(`removed legacy agent rules at ${legacy}`);
});

const managedTargets = Effect.fn("managedTargets")(function* (
  context: ChezmoiContext,
  include: "files" | "symlinks",
) {
  const result = yield* runChezmoi(context, [
    "managed",
    `--include=${include}`,
    "--path-style",
    "absolute",
  ]);
  return result.stdout.split("\n").filter((target) => target.length > 0);
});

export const backupPreexistingTargets = Effect.fn("backupPreexistingTargets")(function* (
  context: ChezmoiContext,
) {
  // Rules used to render at ~/AGENTS.md, which harnesses also load as
  // project rules for every directory under home.
  yield* removeLegacyAgentRules(context);
  for (const target of yield* managedTargets(context, "files")) {
    if (target === join(context.home, ".agents/AGENTS.md")) {
      yield* replaceAgentPath(context, target, "file");
    } else {
      yield* backupPath(context, target, "file");
    }
  }
  for (const target of yield* managedTargets(context, "symlinks")) {
    if (
      target === join(context.home, ".claude/CLAUDE.md") ||
      target === join(context.home, ".codex/AGENTS.md")
    ) {
      yield* replaceAgentPath(context, target, "symlink");
    } else {
      yield* backupPath(context, target, "symlink");
    }
  }
});
