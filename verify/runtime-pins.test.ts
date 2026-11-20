import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { Schema } from "effect";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tools = `${read("chezmoi/.chezmoitemplates/mise.toml")}\n${read("chezmoi/.chezmoitemplates/mise-tasks.toml")}`;

const MiseSettings = Schema.fromJsonString(
  Schema.Struct({
    minimum_release_age: Schema.String,
    minimum_release_age_excludes: Schema.Array(Schema.String),
  }),
);
const Renovate = Schema.fromJsonString(
  Schema.Struct({
    packageRules: Schema.Array(
      Schema.Struct({
        groupName: Schema.optionalKey(Schema.String),
        matchManagers: Schema.optionalKey(Schema.Array(Schema.String)),
        matchDepNames: Schema.optionalKey(Schema.Array(Schema.String)),
        matchPackageNames: Schema.optionalKey(Schema.Array(Schema.String)),
        matchUpdateTypes: Schema.optionalKey(Schema.Array(Schema.String)),
        minimumReleaseAge: Schema.optionalKey(Schema.Json),
        schedule: Schema.optionalKey(Schema.Json),
      }),
    ),
  }),
);

const XcodePin = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Number, release: Schema.String, build: Schema.String }),
);

function miseSettings() {
  const source = read("chezmoi/private_dot_config/mise/config.toml.tmpl");
  const settings = source.slice(source.indexOf("[settings]"), source.indexOf("[settings.github]"));
  const parsed = spawnSync(
    "python3",
    [
      "-c",
      "import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())['settings']))",
    ],
    { input: settings, encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  return Schema.decodeUnknownSync(MiseSettings)(parsed.stdout);
}

test("Xcode pin is a dotted release and its build", () => {
  const xcode = Schema.decodeUnknownSync(XcodePin)(read("chezmoi/.chezmoidata/xcode.json"));
  assert.equal(xcode.version, 1);
  assert.match(xcode.release, /^\d+\.\d+$/);
  assert.match(xcode.build, /^\d+[A-Z]\d+[a-z]?$/);
});

test("mise package convergence repeats without runtime installs and stops on failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-runtime-packages-"));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Keep the real task; runtime downloads are outside this fixture's scope.
  const task = tools.slice(tools.indexOf('[tasks."dotfiles:runtime-packages"]'));
  assert.ok(task.startsWith("[tasks."));
  writeFileSync(join(root, "mise.toml"), task);
  writeFileSync(join(root, "global.toml"), "");
  const log = join(root, "commands");
  for (const name of ["npm", "python"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$TEST_LOG"\n[ '${name}' != "\${TEST_FAIL:-}" ]\n`,
      { mode: 0o755 },
    );
  }
  const run = (failure = "") =>
    spawnSync("mise", ["run", "dotfiles:runtime-packages"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MISE_GLOBAL_CONFIG_FILE: join(root, "global.toml"),
        MISE_CONFIG_DIR: join(root, "config"),
        MISE_TRUSTED_CONFIG_PATHS: root,
        TEST_LOG: log,
        TEST_FAIL: failure,
      },
    });
  for (let i = 0; i < 2; i++) {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(log, "utf8"), "npm\npython\n".repeat(2));
  writeFileSync(log, "");
  assert.notEqual(run("npm").status, 0);
  assert.equal(readFileSync(log, "utf8"), "npm\n");
});

test("mise and Renovate agree on CLI age exemptions without exempting runtimes or holds", () => {
  const mise = miseSettings();
  const renovate = Schema.decodeUnknownSync(Renovate)(read("renovate.json"));
  const cliRule = renovate.packageRules.find(
    (rule) => rule.groupName === "mise CLI patch and minor",
  );
  assert.ok(cliRule);
  assert.deepEqual(mise.minimum_release_age_excludes, cliRule.matchDepNames);
  assert.equal(mise.minimum_release_age, "3d");
  assert.equal(cliRule.minimumReleaseAge, null);
  assert.deepEqual(cliRule.matchUpdateTypes, ["patch", "minor", "pin"]);
  for (const tool of [
    "node",
    "bun",
    "python",
    "java",
    "ruby",
    "go",
    "uv",
    "pnpm",
    "npm:@playwright/cli",
  ]) {
    assert.ok(!mise.minimum_release_age_excludes.includes(tool), `${tool} retains its age gate`);
  }
});

const matches = (names: readonly string[] | undefined, name: string) =>
  names === undefined ||
  ((names.some((pattern) => pattern === name) ||
    names.every((pattern) => pattern.startsWith("!"))) &&
    !names.includes(`!${name}`));

const settle = (manager: string) =>
  Schema.decodeUnknownSync(Renovate)(read("renovate.json"))
    .packageRules.filter(
      (rule) =>
        (rule.matchManagers === undefined || rule.matchManagers.includes(manager)) &&
        matches(rule.matchDepNames, "pnpm") &&
        matches(rule.matchPackageNames, "pnpm"),
    )
    .reduce<Record<string, Schema.Json>>((merged, rule) => {
      if (rule.minimumReleaseAge !== undefined) merged.minimumReleaseAge = rule.minimumReleaseAge;
      if (rule.schedule !== undefined) merged.schedule = rule.schedule;
      if (rule.groupName !== undefined) merged.groupName = rule.groupName;
      return merged;
    }, {});

test("both pnpm pins share one Renovate release gate and schedule", () => {
  assert.deepEqual(settle("mise"), settle("npm"));
  assert.equal(settle("mise").groupName, "pnpm");
});
