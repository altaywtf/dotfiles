import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
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
  runWrapperResult,
  sharedFixtureRules,
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
  assert.match(
    rules,
    /Shared fixture delivery rule\.\n\n## Private fixture end\n\nLoad this last\.\n$/,
  );
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

test("omits private layers for blank Markdown", () => {
  const { home } = createFixture();
  mkdirSync(join(home, ".config/dotfiles"), { recursive: true });
  for (const name of ["agents.start.md", "agents.end.md"])
    writeFileSync(join(home, ".config/dotfiles", name), " \n\t\n", { mode: 0o600 });

  runWrapper(home);

  assert.equal(assertManagedRules(home), sharedFixtureRules);
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

function rulesSourceFixture(home: string, files: Record<string, string>): string {
  const source = join(home, "rules-source");
  mkdirSync(source, { recursive: true });
  for (const [name, contents] of Object.entries(files))
    writeFileSync(join(source, name), contents, { mode: 0o600 });
  mkdirSync(join(home, ".config/dotfiles"), { recursive: true });
  writeFileSync(join(home, ".config/dotfiles/rules-source"), `${source}\n`, { mode: 0o600 });
  return source;
}

const host = hostname().split(".")[0];

test("links the stored rules source before rendering what reads it", () => {
  const { config, home } = createFixture();
  const source = rulesSourceFixture(home, {
    "agents.md": "## Source start rule\n",
    [`agents.${host}.md`]: "## Source host rule\n",
    "claude-automode.json": "{}\n",
    "codex.rules": "",
  });

  runWrapper(home);

  const local = join(home, ".config/dotfiles");
  assert.equal(readlinkSync(join(local, "agents.start.md")), join(source, "agents.md"));
  assert.equal(readlinkSync(join(local, "agents.end.md")), join(source, `agents.${host}.md`));
  assert.equal(
    readlinkSync(join(local, "claude-automode.json")),
    join(source, "claude-automode.json"),
  );
  assert.equal(readlinkSync(join(local, "codex.rules")), join(source, "codex.rules"));
  const rules = assertManagedRules(home);
  assert.match(rules, /^## Source start rule\n/);
  assert.match(rules, /## Source host rule\n$/);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.autoMode, {});
  assert.equal(runChezmoi(home, config, "diff"), "");
});

test("drops a rules source link whose file is gone and skips missing host rules", () => {
  const { home } = createFixture();
  const source = rulesSourceFixture(home, { "agents.md": "## Source start rule\n" });
  runWrapper(home);
  assert.equal(existsSync(join(home, ".config/dotfiles/agents.end.md")), false);

  rmSync(join(source, "agents.md"));
  runWrapper(home);

  assert.equal(existsSync(join(home, ".config/dotfiles/agents.start.md")), false);
  assert.match(assertManagedRules(home), /^## General guidelines/);
});

test("refuses to replace a hand-written fragment with a rules source link", () => {
  const { home } = createFixture();
  rulesSourceFixture(home, { "agents.md": "## Source start rule\n" });
  writeFileSync(join(home, ".config/dotfiles/agents.start.md"), "## Mine\n", { mode: 0o600 });

  const result = runWrapperResult(home);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /agents\.start\.md is a regular file/);
});
