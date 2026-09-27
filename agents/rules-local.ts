import { Console, Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { CliFailure, fail } from "../lib/program.ts";

export const validateLocalAgentRules = Effect.fn("validateLocalAgentRules")(function* (
  configDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of [join(configDir, "agents.start.md"), join(configDir, "agents.end.md")]) {
    const link = yield* fs.readLink(path).pipe(Effect.option);
    const exists = yield* fs.exists(path);
    if (Option.isSome(link) && !exists)
      return yield* fail(`local agent rules link is broken: ${path}`);
    if (!exists) continue;
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.mapError(
          () =>
            new CliFailure({ exitCode: 1, message: `cannot inspect local agent rules: ${path}` }),
        ),
      );
    if (info.type !== "File")
      return yield* fail(`local agent rules must resolve to a regular file: ${path}`);
    if (Option.getOrUndefined(info.uid) !== process.getuid?.()) {
      return yield* fail(`local agent rules must be owned by the current user: ${path}`);
    }
    if ((info.mode & 0o022) !== 0) {
      return yield* fail(`local agent rules must not grant group or other write access: ${path}`);
    }
    // A Git checkout updated under umask 022 widens a linked fragment to 0644;
    // write access by others would be an integrity problem, read access is not yet.
    if ((info.mode & 0o077) !== 0) {
      yield* fs.chmod(path, info.mode & 0o700).pipe(
        Effect.mapError(
          () =>
            new CliFailure({
              exitCode: 1,
              message: `cannot restrict local agent rules: ${path}`,
            }),
        ),
      );
      yield* Console.warn(`restricted local agent rules to owner-only access: ${path}`);
    }
  }
});
