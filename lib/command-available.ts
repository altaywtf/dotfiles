import { Effect, FileSystem, Option } from "effect";
import { delimiter, join } from "node:path";

export const commandAvailable = Effect.fn("commandAvailable")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const info = yield* fs.stat(join(directory, name)).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
      return true;
    }
  }
  return false;
});
