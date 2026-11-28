import shared, { env, ignorePatterns } from "@uinaf/oxlint-config/effect/vite-plus";
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
    extends: [shared],
    env,
    ignorePatterns: [...ignorePatterns, "chezmoi/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "anti-slop/no-unknown-parameters": "off",
      "anti-slop/no-runtime-typeof": "off",
      "anti-slop/require-safety-comment-for-type-assertion": "off",
      "anti-slop-effect/no-manual-tagged-construction": "off",
      "uinaf/no-comments": ["error", { allow: ["^renovate: ", "^trufflehog:ignore$"] }],
    },
    options: { typeCheck: true, denyWarnings: true },
  },
});
