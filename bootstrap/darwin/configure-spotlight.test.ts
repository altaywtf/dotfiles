import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const script = join(import.meta.dirname, "configure-spotlight.ts");

test(
  "Spotlight checks default to strict and only explicitly skip verification",
  { skip: process.platform !== "darwin" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "dotfiles-spotlight-"));
    const log = join(root, "commands.log");

    try {
      writeFileSync(
        join(root, "mdutil"),
        `#!/bin/sh
printf 'mdutil %s\\n' "$*" >> "$SPOTLIGHT_TEST_LOG"
if [ "$*" = "-sa" ]; then
  printf '%s\\n' "$SPOTLIGHT_TEST_OUTPUT"
  printf '%s\\n' "$SPOTLIGHT_TEST_STDERR" >&2
  exit "$SPOTLIGHT_TEST_STATUS"
fi
[ "$*" = "-a -i off" ] || exit 90
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(root, "sudo"),
        `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "$SPOTLIGHT_TEST_LOG"
exec "$@"
`,
        { mode: 0o755 },
      );

      const run = (
        skip: string | undefined,
        stdout: string,
        stderr = "",
        status = "0",
        args = ["--check"],
      ) => {
        writeFileSync(log, "");

        const result = spawnSync(process.execPath, [script, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: root,
            HOME: root,
            DOTFILES_SKIP_SPOTLIGHT_CHECK: skip,
            SPOTLIGHT_TEST_LOG: log,
            SPOTLIGHT_TEST_OUTPUT: stdout,
            SPOTLIGHT_TEST_STDERR: stderr,
            SPOTLIGHT_TEST_STATUS: status,
          },
        });

        return { ...result, commands: readFileSync(log, "utf8") };
      };

      for (const flag of [undefined, "", "0", "true"]) {
        const result = run(flag, "/:\n  Indexing enabled.");
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Spotlight indexing is enabled/);
        assert.equal(result.commands, "mdutil -sa\n");
      }

      const disabled = run(undefined, "/:\n  Indexing disabled.");
      assert.equal(disabled.status, 0, disabled.stderr);
      assert.match(disabled.stdout, /ok Spotlight indexing disabled/);
      assert.equal(disabled.commands, "mdutil -sa\n");

      const stderrEnabled = run(undefined, "", "Indexing enabled.");
      assert.equal(stderrEnabled.status, 1, stderrEnabled.stderr);
      assert.match(stderrEnabled.stderr, /Spotlight indexing is enabled/);

      const failed = run(undefined, "", "inspection failed", "7");
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stderr, /mdutil -sa exited 7/);

      const skipped = run("1", "Indexing enabled.", "inspection failed", "7");
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.match(
        skipped.stdout,
        /skipped Spotlight indexing policy check \(DOTFILES_SKIP_SPOTLIGHT_CHECK=1\)/,
      );
      assert.equal(skipped.commands, "");

      const configure = run("1", "Indexing enabled.", "", "0", []);
      assert.equal(configure.status, 1, configure.stderr);
      assert.doesNotMatch(configure.stdout, /skipped/);
      const sudo = process.getuid?.() === 0 ? "" : "sudo mdutil -a -i off\n";
      assert.equal(configure.commands, `${sudo}mdutil -a -i off\nmdutil -sa\n`);
      assert.match(configure.stderr, /Spotlight indexing is enabled/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
