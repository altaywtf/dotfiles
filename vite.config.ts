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
    ],
    rules: {
      ...cloudflare.rules,
      "vite-plus/prefer-vite-plus-imports": "error",
      curly: "off",
      "quality/no-conditional-empty-object-spread": "off",
      "quality/no-known-value-widening": "off",
      "quality/no-unknown-returns": "off",
      "quality/no-unsafe-dictionary-type": "off",
      "typescript/array-type": "off",
      "typescript/no-unsafe-argument": "off",
      "typescript/no-unsafe-assignment": "off",
      "typescript/no-unsafe-call": "off",
      "typescript/no-unsafe-return": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "unicorn/consistent-function-scoping": "off",
    },
    options: { ...cloudflare.options, typeCheck: true, denyWarnings: true },
    overrides: [
      ...(cloudflare.overrides ?? []),
      {
        files: ["**/*.ts"],
        rules: {
          curly: "off",
          "quality/no-conditional-empty-object-spread": "off",
          "quality/no-known-value-widening": "off",
          "quality/no-unknown-returns": "off",
          "quality/no-unsafe-dictionary-type": "off",
          "typescript/array-type": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "unicorn/consistent-function-scoping": "off",
        },
      },
    ],
  },
});
