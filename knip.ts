import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnipConfig } from "knip";
import { gatewayHelpers } from "./agents/gateway/bundle.ts";

// CLI commands are also invoked by mise, schedulers, templates, and operators.
const commands = globSync("**/*.ts", {
  cwd: import.meta.dirname,
  exclude: ["node_modules/**", "chezmoi/**", ".git/**"],
}).filter(
  (path) =>
    !path.endsWith(".test.ts") &&
    readFileSync(join(import.meta.dirname, path), "utf8").startsWith("#!/usr/bin/env node"),
);

export default {
  entry: [...commands, ...gatewayHelpers.map((name) => `agents/gateway/${name}.ts`)],
  project: ["**/*.ts", "!chezmoi/**"],
  includeEntryExports: true,
  // Vite+'s migrator installs this alias to satisfy the bundled tools' peers.
  ignoreDependencies: ["vite"],
  // Native host tools are provisioned outside the npm dependency graph.
  ignoreBinaries: ["brew", "chezmoi", "codex", "mise", "plutil", "ruby"],
} satisfies KnipConfig;
