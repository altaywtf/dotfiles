import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import {
  assertManagedRules,
  cleanupFixtures,
  createFixture,
  runWrapper,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

function assertNoBackups(home: string): void {
  for (const directory of [
    home,
    join(home, ".agents"),
    join(home, ".claude"),
    join(home, ".codex"),
  ]) {
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.includes(".backup.")),
      [],
      directory,
    );
  }
}

test.each([
  [
    "unmanaged files and a broken link",
    (home: string) => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(join(home, ".claude/CLAUDE.md"), "unmanaged fixture rules\n");
      mkdirSync(join(home, ".agents"), { recursive: true });
      writeFileSync(join(home, ".agents/AGENTS.md"), "unmanaged fixture rules\n");
      symlinkSync("../missing/AGENTS.md", join(home, ".codex/AGENTS.md"));
    },
  ],
  [
    "links to external rules",
    (home: string, root: string) => {
      const externalRules = join(root, "external/rules.md");
      mkdirSync(dirname(externalRules), { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(externalRules, "external fixture rules\n");
      symlinkSync(externalRules, join(home, ".claude/CLAUDE.md"));
      symlinkSync(externalRules, join(home, ".codex/AGENTS.md"));
    },
  ],
])("replaces conflicting %s without backups", (_name, conflict) => {
  const { home, root } = createFixture();
  conflict(home, root);

  runWrapper(home);

  assertManagedRules(home);
  assertNoBackups(home);
});

test("does not replace managed rule paths again", () => {
  const { home } = createFixture();

  runWrapper(home);
  const output = runWrapper(home);

  assertManagedRules(home);
  assert.doesNotMatch(output, /removed conflicting generated agent rules/);
  assertNoBackups(home);
});

test("removes rules rendered at the old home-root path", () => {
  const { home } = createFixture();
  writeFileSync(join(home, "AGENTS.md"), "previously rendered rules\n");

  runWrapper(home);

  assertManagedRules(home);
  assert.equal(existsSync(join(home, "AGENTS.md")), false);
  assertNoBackups(home);
});
