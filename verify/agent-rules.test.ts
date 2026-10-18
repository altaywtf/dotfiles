import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "vite-plus/test";

import {
  agentRulesCache,
  assertManagedRules,
  cleanupFixtures,
  createFixture,
  runChezmoi,
  runChezmoiResult,
  runWrapper,
} from "./agent-rules-fixture.ts";

afterEach(cleanupFixtures);

test("applies public rules and links without private output", () => {
  const { config, home } = createFixture();

  runChezmoi(home, config, "apply");
  const rules = assertManagedRules(home);

  assert.match(rules, /^## General guidelines/);
  assert.doesNotMatch(rules, /private fixture rule/);
  assert.match(rules, /Fixture shared rule/);
  assert.match(rules, /### Delivery/);
  assert.match(rules, /Shared fixture delivery rule\.\n$/);
  assert.equal(runChezmoi(home, config, "diff"), "");
  runChezmoi(home, config, "apply");
  assert.equal(runChezmoi(home, config, "diff"), "");
});

test("reads an optional private end layer from machine-local Markdown", () => {
  const { home } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  writeFileSync(privateEnd, "## Private fixture rule\n\nKeep this fixture local.\n");
  chmodSync(privateEnd, 0o600);

  runWrapper(home);

  assert.match(
    assertManagedRules(home),
    /Shared fixture delivery rule\.\n\n## Private fixture rule\n\nKeep this fixture local\.\n$/,
  );
});

test("composes optional private Markdown around the shared rules", () => {
  const { home } = createFixture();
  const privateStart = join(home, ".config/dotfiles/agents.start.md");
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateStart), { recursive: true });
  writeFileSync(privateStart, "# Private fixture context\n\nLoad this first.\n");
  writeFileSync(privateEnd, "## Private fixture end\n\nLoad this last.\n");
  chmodSync(privateStart, 0o600);
  chmodSync(privateEnd, 0o600);

  runWrapper(home);
  const rules = assertManagedRules(home);

  assert.match(rules, /^# Private fixture context\n\nLoad this first\.\n\n## General guidelines/);
  assert.ok(rules.indexOf("# Private fixture context") < rules.indexOf("## General guidelines"));
  assert.ok(rules.indexOf("## General guidelines") < rules.indexOf("## Private fixture end"));
  assert.match(rules, /## Private fixture end\n\nLoad this last\.\n$/);
});

test("reads machine-local Markdown through a symlink", () => {
  const { home, root } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  const externalEnd = join(root, "private/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  mkdirSync(dirname(externalEnd), { recursive: true });
  writeFileSync(externalEnd, "## Symlinked fixture rule\n");
  chmodSync(externalEnd, 0o600);
  symlinkSync(externalEnd, privateEnd);

  runWrapper(home);

  assert.match(assertManagedRules(home), /## Symlinked fixture rule\n$/);
});

test("omits the private end layer for blank Markdown", () => {
  const { home } = createFixture();
  const privateEnd = join(home, ".config/dotfiles/agents.end.md");
  mkdirSync(dirname(privateEnd), { recursive: true });
  writeFileSync(privateEnd, " \n\t\n");
  chmodSync(privateEnd, 0o600);

  runWrapper(home);

  assert.match(assertManagedRules(home), /Shared fixture delivery rule\.\n$/);
});

test("shows rule changes in diff and waits for an explicit apply", () => {
  const { config, home } = createFixture();
  runChezmoi(home, config, "apply");
  const rulesPath = join(home, "AGENTS.md");
  const before = readFileSync(rulesPath, "utf8");

  appendFileSync(
    agentRulesCache(home),
    "\nFixture public rule changed: `{{ .chezmoi.homeDir }}`.\n",
  );

  assert.match(runChezmoi(home, config, "diff"), /Fixture public rule changed/);
  assert.equal(readFileSync(rulesPath, "utf8"), before);
  runChezmoi(home, config, "apply");
  assert.match(
    readFileSync(rulesPath, "utf8"),
    /Fixture public rule changed: `\{\{ \.chezmoi\.homeDir \}\}`/,
  );
  assert.equal(runChezmoi(home, config, "diff"), "");
});

test("requires fetched machine-local rules instead of a repository copy", () => {
  const { config, home } = createFixture();
  rmSync(agentRulesCache(home));

  const result = runChezmoiResult(home, config, "apply");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agent-rules\.md/);
});
