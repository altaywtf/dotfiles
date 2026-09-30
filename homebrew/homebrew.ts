import { Effect, FileSystem, Option } from "effect";
import { basename, dirname, isAbsolute, join } from "node:path";
import { runChecked, runCommand } from "../lib/command.ts";
import { CliFailure, fail } from "../lib/program.ts";
import type { ProfileModel } from "../profiles/model.ts";
import { requireProfile } from "../profiles/model.ts";

const runRaw = runCommand;
const run = runChecked;

const homebrewPrefix = Effect.fn("homebrewPrefix")(function* () {
  return (yield* run("brew", ["--prefix"])).stdout.trim();
});

export const requirePrefixOwner = Effect.fn("requireHomebrewPrefixOwner")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const prefix = yield* homebrewPrefix();
  const info = yield* fs.stat(prefix).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "Directory")
    return yield* fail(`Homebrew prefix does not exist: ${prefix}`);
  const ownerUid = Option.getOrUndefined(info.value.uid);
  const currentUid = process.getuid?.();
  if (ownerUid === currentUid) return prefix;
  const owner = yield* runRaw("id", ["-un", String(ownerUid)]);
  const current = yield* run("id", ["-un"]);
  const ownerName = owner.status === 0 ? owner.stdout.trim() : `uid ${ownerUid}`;
  return yield* fail(
    `Homebrew mutations must run as prefix owner ${ownerName}; current user is ${current.stdout.trim()}`,
  );
});

export function profileBrewfiles(model: ProfileModel, profile: string): readonly string[] {
  return requireProfile(model, profile).brewfiles;
}

export function brewfilePath(repoRoot: string, file: string): string {
  return isAbsolute(file) ? file : join(repoRoot, file);
}

// The optional local layer is trusted Ruby evaluated by Homebrew Bundle, so the
// checkout owner must own it and nobody else may write it.
const localBrewfile = Effect.fn("localBrewfile")(function* (repoRoot: string) {
  const path = process.env.DOTFILES_BREWFILE_LOCAL || join(repoRoot, "Brewfile.local");
  const fs = yield* FileSystem.FileSystem;
  const link = yield* fs.readLink(path).pipe(Effect.option);
  const exists = yield* fs.exists(path);
  if (!exists && Option.isNone(link)) return Option.none<string>();
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isSome(link) || Option.isNone(info) || info.value.type !== "File") {
    return yield* fail(`invalid local Brewfile: ${path} must be a regular file`);
  }
  if (Option.getOrUndefined(info.value.uid) !== process.getuid?.())
    return yield* fail(`unsafe local Brewfile: ${path} must be owned by the current user`);
  if ((info.value.mode & 0o022) !== 0)
    return yield* fail(`unsafe local Brewfile: ${path} must not be group or world writable`);
  yield* fs.access(path, { readable: true }).pipe(
    Effect.mapError(
      () =>
        new CliFailure({
          exitCode: 1,
          message: `invalid local Brewfile: ${path} must be readable`,
        }),
    ),
  );
  return Option.some(path);
});

export const withLocalBrewfile = Effect.fn("withLocalBrewfile")(function* (
  repoRoot: string,
  files: readonly string[],
) {
  const local = yield* localBrewfile(repoRoot);
  return Option.isSome(local) ? [...files, local.value] : files;
});

export const composeBrewfile = Effect.fn("composeBrewfile")(function* (
  repoRoot: string,
  files: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const composed = yield* fs.makeTempFile({ directory: repoRoot, prefix: "Brewfile.composed." });
  const contents = yield* Effect.forEach(files, (file) =>
    fs.readFileString(brewfilePath(repoRoot, file)),
  );
  yield* fs.writeFileString(
    composed,
    contents.map((content) => (content.endsWith("\n") ? content : `${content}\n`)).join(""),
  );
  return composed;
});

export const removeComposedBrewfile = Effect.fn("removeComposedBrewfile")(function* (
  repoRoot: string,
  composed: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const parent = dirname(composed);
  if (parent !== repoRoot && basename(parent).startsWith("Brewfile.composed.")) {
    yield* fs.remove(parent, { recursive: true, force: true });
  } else {
    yield* fs.remove(composed, { force: true });
  }
});

export const bundleDrift = Effect.fn("homebrewBundleDrift")(function* (
  repoRoot: string,
  model: ProfileModel,
  profile: string,
) {
  const composed = yield* composeBrewfile(
    repoRoot,
    yield* withLocalBrewfile(repoRoot, profileBrewfiles(model, profile)),
  );
  const result = yield* runRaw("brew", ["bundle", "cleanup", "--file", composed], {
    env: {
      HOMEBREW_BUNDLE_DOTFILES_PROFILE: profile,
      HOMEBREW_NO_AUTO_UPDATE: "1",
    },
  }).pipe(Effect.ensuring(removeComposedBrewfile(repoRoot, composed).pipe(Effect.orDie)));
  // The dry run exits non-zero both when it has a plan and when the Brewfile
  // fails to evaluate; only the latter must not read as "no drift".
  if (result.status !== 0 && !/^Would /m.test(result.stdout)) {
    const detail =
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || "no output";
    return yield* fail(
      `brew bundle cleanup exited ${result.status} without a plan for the composed Brewfile:\n${detail}`,
    );
  }
  let show = false;
  return result.stdout
    .split("\n")
    .filter((line) => {
      if (/^Would (uninstall|untap)/.test(line)) show = true;
      if (line.startsWith("Would `brew cleanup`")) show = false;
      return show;
    })
    .join("\n");
});

export const trustTaps = Effect.fn("trustHomebrewTaps")(function* (
  repoRoot: string,
  files: readonly string[],
) {
  const support = yield* runRaw("brew", ["trust", "--help"]);
  if (support.status !== 0) return;
  const fs = yield* FileSystem.FileSystem;
  for (const file of files) {
    const contents = yield* fs.readFileString(isAbsolute(file) ? file : join(repoRoot, file));
    for (const line of contents.split("\n")) {
      const tap = /^\s*tap\s+"([^"]+)"/.exec(line)?.[1];
      if (!tap) continue;
      const trusted = yield* runRaw("brew", ["trust", "--tap", tap]);
      if (trusted.status !== 0) {
        return yield* fail(
          `failed to trust tap ${tap}; a managed Homebrew that refuses trust must supply its entries through the external-homebrew contract`,
        );
      }
    }
  }
});

export { runRaw as runHomebrewRaw };
