import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      ".claude/worktrees/**",
      ".worktrees/**",
      ...(process.platform === "darwin"
        ? []
        : ["maintenance/darwin/schedule.test.ts", "maintenance/darwin/devbox.test.ts"]),
    ],
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    sequence: { hooks: "list" },
  },
  fmt: {
    ignorePatterns: ["chezmoi/**/*.tmpl", "chezmoi/**/modify_*", "chezmoi/**/symlink_*"],
  },
  lint: {
    ...cloudflare,
    ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "chezmoi/**"],
    jsPlugins: [
      ...(cloudflare.jsPlugins ?? []),
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "comments", specifier: "@uinaf/oxlint-plugin-no-comments" },
    ],
    rules: {
      ...cloudflare.rules,
      "vite-plus/prefer-vite-plus-imports": "error",
      "comments/no-comments": ["error", { allow: ["^renovate: ", "^trufflehog:ignore$"] }],
    },
    options: { ...cloudflare.options, typeCheck: true, denyWarnings: true },
  },
});
