import { Console, Effect, FileSystem, Option } from "effect";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CliFailure, fail } from "../lib/program.ts";

// Machine-local fragments linked from a directory the operator names once.
// Keys are the files the rule renderer reads; values are names in the source.
const ruleLinks = (host: string) =>
  [
    ["agents.start.md", "agents.md"],
    ["agents.end.md", `agents.${host}.md`],
    ["claude-automode.json", "claude-automode.json"],
    ["codex.rules", "codex.rules"],
  ] as const;

const settingName = "rules-source";

const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

export const saveRulesSource = Effect.fn("saveRulesSource")(function* (
  configDir: string,
  input: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = resolve(expandHome(input));
  const info = yield* fs.stat(source).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory")
    return yield* fail(`rules source must be an existing directory: ${source}`, 2);
  yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(join(configDir, settingName), `${source}\n`, { mode: 0o600 });
  yield* fs.chmod(join(configDir, settingName), 0o600);
}, Effect.mapError(asCliFailure));

const readRulesSource = Effect.fn("readRulesSource")(function* (configDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(configDir, settingName);
  if (!(yield* fs.exists(path))) return Option.none<string>();
  const info = yield* fs.stat(path);
  if (info.type !== "File") return yield* fail(`${path} must be a regular file`);
  if (Option.getOrUndefined(info.uid) !== process.getuid?.())
    return yield* fail(`${path} must be owned by the current user`);
  if ((info.mode & 0o022) !== 0) return yield* fail(`${path} must not be group or other writable`);
  const source = (yield* fs.readFileString(path)).trim();
  if (!isAbsolute(source)) return yield* fail(`${path} must hold an absolute directory path`);
  const sourceInfo = yield* fs.stat(source).pipe(Effect.option);
  if (Option.isNone(sourceInfo) || sourceInfo.value.type !== "Directory")
    return yield* fail(`rules source from ${path} is not a directory: ${source}`);
  return Option.some(source);
});

export const linkRulesSource = Effect.fn("linkRulesSource")(function* (
  configDir: string,
  host: string,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* readRulesSource(configDir);
  if (Option.isNone(source)) return;
  if (!dryRun) yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
  for (const [name, sourceName] of ruleLinks(host)) {
    const destination = join(configDir, name);
    const target = join(source.value, sourceName);
    const current = yield* fs.readLink(destination).pipe(Effect.option);
    const targetExists = yield* fs.exists(target);
    if (!targetExists) {
      // A link left pointing into the source for a file it no longer has would
      // fail rule rendering; anything else at the destination stays the operator's.
      if (Option.isSome(current) && current.value.startsWith(`${source.value}/`)) {
        if (dryRun) yield* Console.log(`would remove stale rule link ${destination}`);
        else yield* fs.remove(destination);
      }
      continue;
    }
    if (Option.isSome(current) && current.value === target) continue;
    if (Option.isNone(current) && (yield* fs.exists(destination)))
      return yield* fail(
        `${destination} is a regular file; remove it to link ${target} from the rules source`,
      );
    if (dryRun) {
      yield* Console.log(`would link ${destination} -> ${target}`);
      continue;
    }
    if (Option.isSome(current)) yield* fs.remove(destination);
    yield* fs.symlink(target, destination);
  }
}, Effect.mapError(asCliFailure));

function asCliFailure(error: unknown): CliFailure {
  return error instanceof CliFailure
    ? error
    : new CliFailure({ exitCode: 1, message: `rules source: ${String(error)}` });
}
