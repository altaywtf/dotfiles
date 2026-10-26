#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { classifyTrufflehogFindings } from "./trufflehog.ts";

// Shape captured from trufflehog 3.99.7 `git --json`, secret fields dropped.
const finding = (commit: string, verified: boolean) =>
  JSON.stringify({
    SourceMetadata: { Data: { Git: { commit, file: "a.test.ts", line: 7 } } },
    DetectorName: "URI",
    Verified: verified,
  });

test("only unverified findings pinned by commit, file, line, and detector are allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-trufflehog-"));
  try {
    const allowlist = join(root, "allowlist.json");
    writeFileSync(
      allowlist,
      JSON.stringify({
        version: 1,
        findings: [
          {
            commit: "a".repeat(40),
            file: "a.test.ts",
            line: 7,
            detector: "URI",
            reason: "fixture",
          },
        ],
      }),
    );
    const stdout = [
      finding("a".repeat(40), false),
      finding("a".repeat(40), true),
      finding("b".repeat(40), false),
    ].join("\n");
    assert.deepEqual(classifyTrufflehogFindings(`${stdout}\n`, allowlist), {
      allowed: 1,
      unexpected: [
        `URI (verified) a.test.ts:7 in ${"a".repeat(12)}`,
        `URI a.test.ts:7 in ${"b".repeat(12)}`,
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
