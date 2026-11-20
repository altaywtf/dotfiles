import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnipConfig } from "knip";

const commands = globSync("**/*.ts", {
  cwd: import.meta.dirname,
  exclude: ["node_modules/**", "chezmoi/**", ".git/**"],
}).filter(
  (path) =>
    !path.endsWith(".test.ts") &&
    readFileSync(join(import.meta.dirname, path), "utf8").startsWith("#!/usr/bin/env node"),
);

export default {
  entry: commands,
  project: ["**/*.ts", "!chezmoi/**"],
  includeEntryExports: true,
  ignoreDependencies: ["vite"],
  ignoreBinaries: ["brew", "chezmoi", "codex", "mise", "ruby"],
} satisfies KnipConfig;
