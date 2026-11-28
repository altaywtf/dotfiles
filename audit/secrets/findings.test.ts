#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { findingLocators, summarizeFindings } from "./findings.ts";

test("gitleaks data exposes only safe locators and aggregate counts", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-data-"));

  try {
    const report = join(root, "report.json");
    const policy = join(root, "policy.json");
    writeFileSync(
      policy,
      JSON.stringify({ version: 1, defaultSeverity: "high", failureThreshold: "high", rules: {} }),
    );
    writeFileSync(
      report,
      JSON.stringify([
        { RuleID: "private-key", File: join(root, "home/.ssh/id"), Secret: "hidden" },
        { RuleID: "token", File: "/outside/path", Match: "hidden" },
        { RuleID: "relative", File: "home/.ssh/id" },
        { RuleID: "empty", File: "" },
      ]),
    );
    assert.deepEqual(findingLocators(root, report), [
      "private-key\thome/.ssh/id",
      "token\tunknown",
      "relative\tunknown",
      "empty\tunknown",
    ]);
    assert.deepEqual(summarizeFindings('{"private-key":2}', '{"low":2}', report, policy), {
      findingCount: 4,
      failures: 4,
      warnings: 0,
      rules: { empty: 1, "private-key": 3, relative: 1, token: 1 },
      severities: { low: 2, high: 4 },
    });
    assert.throws(
      () => summarizeFindings('{"private-key":-1}', "", report, policy),
      /invalid count/,
    );
    assert.throws(
      () => summarizeFindings(`{"private-key":${Number.MAX_SAFE_INTEGER + 1}}`, "", report, policy),
      /invalid count/,
    );

    for (const value of ["{", "[]", "null"]) {
      assert.throws(
        () => summarizeFindings(value, "", report, policy),
        /invalid persisted count map/,
      );
    }

    writeFileSync(
      report,
      JSON.stringify([
        { RuleID: { private: "hidden" }, SymlinkFile: {}, File: join(root, "home/token") },
        { RuleID: "token", File: { private: "hidden" } },
      ]),
    );
    assert.deepEqual(findingLocators(root, report), ["unknown\thome/token", "token\tunknown"]);
    assert.deepEqual(summarizeFindings("", "", report, policy).rules, { token: 1, unknown: 1 });
    const missingRoot = join(root, "missing");
    writeFileSync(
      report,
      JSON.stringify([{ RuleID: "token", File: join(missingRoot, "home/token") }]),
    );
    assert.deepEqual(findingLocators(missingRoot, report), ["token\thome/token"]);
    writeFileSync(report, "not json");
    assert.throws(() => findingLocators(root, report), /report is missing or invalid/);
    assert.throws(() => summarizeFindings("", "", report, policy), /report is missing or invalid/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Gitleaks policy classifies rule severity", () => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-audit-policy-"));

  try {
    const report = join(root, "report.json");
    const policy = join(root, "policy.json");
    writeFileSync(
      report,
      JSON.stringify([{ RuleID: "private-key" }, { RuleID: "generic-api-key" }]),
    );
    writeFileSync(
      policy,
      JSON.stringify({
        version: 1,
        defaultSeverity: "high",
        failureThreshold: "high",
        rules: { "generic-api-key": "low" },
      }),
    );
    assert.deepEqual(summarizeFindings("", "", report, policy), {
      findingCount: 2,
      failures: 1,
      warnings: 1,
      rules: { "generic-api-key": 1, "private-key": 1 },
      severities: { low: 1, high: 1 },
    });
    writeFileSync(
      policy,
      JSON.stringify({
        version: 1,
        defaultSeverity: "toString",
        failureThreshold: "high",
        rules: {},
      }),
    );
    assert.throws(
      () => summarizeFindings("", "", report, policy),
      /invalid Gitleaks policy header/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
