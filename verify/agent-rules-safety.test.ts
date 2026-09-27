import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import {
  cleanupFixtures,
  createFixture,
  runChezmoiResult,
  runWrapperResult,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

test("restricts linked local Markdown that a checkout update left group and other readable", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const { home, root } = createFixture();
    const target = join(root, "rules-checkout/templates", name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "### Shared checkout fixture rule\n");
    chmodSync(target, 0o644);
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    symlinkSync(target, privateRules);

    const result = runWrapperResult(home);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /restricted local agent rules to owner-only access/);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /Shared checkout fixture rule/);
  }
});

test("rejects local Markdown granting group or other write access", () => {
  for (const [name, mode] of [
    ["agents.start.md", 0o660],
    ["agents.end.md", 0o602],
  ] as const) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    writeFileSync(privateRules, "### Permissive fixture rule\n");
    chmodSync(privateRules, mode);

    const result = runWrapperResult(home);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local agent rules must not grant group or other write access/);
  }
});

test("rejects a broken local Markdown link", () => {
  for (const [name, profile] of [
    ["agents.start.md", "workstation"],
    ["agents.end.md", "personal-devbox"],
  ] as const) {
    const { home } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    mkdirSync(dirname(privateRules), { recursive: true });
    symlinkSync(join(home, `missing-${name}`), privateRules);

    const result = runWrapperResult(home, profile);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local agent rules link is broken/);
  }
});

test("rejects local Markdown owned by another user", (context) => {
  if (process.getuid?.() === 0) {
    context.skip("requires a non-root test runner");
    return;
  }
  const { home } = createFixture();
  const privateRules = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateRules), { recursive: true });
  symlinkSync("/usr/bin/true", privateRules);

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local agent rules must be owned by the current user/);
});

test("rejects a local Markdown symlink resolving to a directory", () => {
  for (const name of ["agents.start.md", "agents.end.md"]) {
    const { config, home, root } = createFixture();
    const privateRules = join(home, ".config/dotfiles", name);
    const directory = join(root, "private/rules");
    mkdirSync(dirname(privateRules), { recursive: true });
    mkdirSync(directory, { recursive: true });
    symlinkSync(directory, privateRules);

    const wrapperResult = runWrapperResult(home);
    const chezmoiResult = runChezmoiResult(home, config, "apply");

    assert.notEqual(wrapperResult.status, 0);
    assert.match(wrapperResult.stderr, /local agent rules must resolve to a regular file/);
    assert.notEqual(chezmoiResult.status, 0);
    assert.match(
      chezmoiResult.stderr,
      new RegExp(`${name.replaceAll(".", "\\.")} must resolve to a regular file`),
    );
  }
});
