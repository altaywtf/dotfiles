import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      ".claude/worktrees/**",
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
    ignorePatterns: ["chezmoi/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
});
