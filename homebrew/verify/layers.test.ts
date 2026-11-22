import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { readProfileModel } from "../../profiles/model.ts";
import { composeBrewfile, profileBrewfiles, removeComposedBrewfile } from "../homebrew.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const model = readProfileModel(join(repoRoot, "chezmoi/.chezmoidata/profiles.json"));
const evaluator = `require "json"
entries = []
%w[brew cask tap].each do |kind|
  define_singleton_method(kind) { |name, **options| entries << [kind, name, options] }
end
ARGV.each { |path| load path }
puts entries.uniq.map { |entry| JSON.generate(entry) }.sort
`;

function evaluate(files: ReadonlyArray<string>): Array<string> {
  const result = spawnSync("ruby", ["-e", evaluator, ...files], {
    encoding: "utf8",
    env: { ...process.env, HOMEBREW_BUNDLE_DOTFILES_PROFILE: undefined },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "ruby failed");
  return result.stdout.trim().split("\n").filter(Boolean);
}

for (const profile of Object.keys(model.profiles)) {
  test(`${profile} evaluates standalone and preserves its package set when composed`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dotfiles-homebrew-layers-"));
    try {
      const layers = profileBrewfiles(model, profile);
      for (const layer of layers) {
        await mkdir(dirname(join(root, layer)), { recursive: true });
        await copyFile(join(repoRoot, layer), join(root, layer));
      }
      const entries = evaluate(layers.map((layer) => join(root, layer)));
      const desktop = evaluate([join(repoRoot, "homebrew/Brewfile.personal-workstation")]);
      for (const entry of desktop) {
        assert.equal(
          entries.includes(entry),
          profile === "personal-workstation",
          `${profile}: ${entry}`,
        );
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const composed = yield* composeBrewfile(root, layers);
          try {
            assert.deepEqual(evaluate([composed]), entries);
          } finally {
            yield* removeComposedBrewfile(root, composed);
          }
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
