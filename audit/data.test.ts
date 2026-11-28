import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

test("data CLI preserves symlink invocation and rejects invalid count maps", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-cli-"));

  try {
    const report = join(root, "report.json");
    const policy = join(root, "policy.json");
    writeFileSync(report, "[]");
    writeFileSync(
      policy,
      JSON.stringify({ version: 1, defaultSeverity: "high", failureThreshold: "high", rules: {} }),
    );
    const cliPath = join(root, "data.ts");
    symlinkSync(join(import.meta.dirname, "data.ts"), cliPath);

    const cli = spawnSync(process.execPath, [cliPath, "gitleaks-locators", root, report], {
      encoding: "utf8",
    });

    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, "");

    const invalidCounts = spawnSync(
      process.execPath,
      [cliPath, "gitleaks-summary", policy, "{", "{}", report],
      {
        encoding: "utf8",
      },
    );

    assert.equal(invalidCounts.status, 1);
    assert.match(invalidCounts.stderr, /invalid persisted count map/);
    writeFileSync(report, "not json");

    const malformed = spawnSync(process.execPath, [cliPath, "gitleaks-locators", root, report], {
      encoding: "utf8",
    });

    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /report is missing or invalid/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
