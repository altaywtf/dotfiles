#!/usr/bin/env node

import assert from "node:assert/strict";
import { Console, Effect, Schema } from "effect";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { runMain } from "../lib/program.ts";
import { dirname, join, resolve } from "node:path";

import { runApply } from "./home-fixture.ts";

type Settings = Record<string, Schema.Json | undefined> & {
  autoMemoryDirectory?: string;
  autoMemoryEnabled?: boolean;
  env?: Record<string, Schema.Json>;
  modelSettings?: Record<string, Record<string, Schema.Json | undefined>>;
  permissions?: Record<string, Schema.Json | undefined>;
};
type Fixture = {
  contents: string;
  expected?: Settings;
  malformed?: boolean;
};

const repoRoot = resolve(import.meta.dirname, "..");
const JsonRecord = Schema.Record(Schema.String, Schema.Json);
const JsonDocument = Schema.fromJsonString(JsonRecord);
const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.StructWithRest(
      Schema.Struct({
        autoMemoryDirectory: Schema.optionalKey(Schema.String),
        autoMemoryEnabled: Schema.optionalKey(Schema.Boolean),
        env: Schema.optionalKey(JsonRecord),
        modelSettings: Schema.optionalKey(Schema.Record(Schema.String, JsonRecord)),
        permissions: Schema.optionalKey(JsonRecord),
      }),
      [JsonRecord],
    ),
  ),
);
const sourceDir = join(repoRoot, "chezmoi");
const templatePath = join(sourceDir, "private_dot_claude/modify_private_settings.json");
const managedMode = "defaultMode";
const memoryDirectory = "~/.claude/memory";
const managedEnv = {
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
};

function unmanagedEnv(env: Record<string, Schema.Json> | undefined) {
  const rest = Object.fromEntries(
    Object.entries(env ?? {}).filter(([key]) => !Object.hasOwn(managedEnv, key)),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}
const fixtures: Array<Fixture> = [
  { contents: "", expected: {} },
  {
    contents: '{"theme":"dark","cleanupPeriodDays":30}',
    expected: { theme: "dark", cleanupPeriodDays: 30 },
  },
  {
    contents: '{"env":{"KEEP":"yes"},"permissions":{"allow":["Read"]}}',
    expected: { env: { KEEP: "yes" }, permissions: { allow: ["Read"] } },
  },
  {
    contents: '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1"}}',
    expected: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } },
  },
  {
    contents: '{"env":{"CLAUDE_CODE_DISABLE_1M_CONTEXT":"1","KEEP":"yes"}}',
    expected: { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", KEEP: "yes" } },
  },
  {
    contents:
      '{"modelSettings":{"claude-opus-5-5":{"effortLevel":"high","maxEffortLevel":"xhigh"},"claude-sonnet-5":{"effortLevel":"low"}}}',
    expected: {
      modelSettings: {
        "claude-opus-5-5": { maxEffortLevel: "xhigh" },
        "claude-sonnet-5": { effortLevel: "low" },
      },
    },
  },
  {
    contents: '{\n    "theme": "dark",\n    "env": {\n        "KEEP": "yes"\n    }\n}\n',
    expected: { theme: "dark", env: { KEEP: "yes" } },
  },
  {
    contents: '{"syncClaudeAiPlugins":true,"theme":"dark"}',
    expected: { theme: "dark" },
  },
  {
    contents: '{"advisorModel":"claude-fable-5-1","theme":"dark"}',
    expected: { theme: "dark" },
  },
  {
    contents: '{"env":{"ENABLE_CLAUDEAI_MCP_SERVERS":"false","KEEP":"yes"}}',
    expected: { env: { KEEP: "yes" } },
  },
  { contents: '{"env":', malformed: true },
];

function settingsPath(root: string): string {
  return join(root, "home/.claude/settings.json");
}

function writeSettings(root: string, contents: string, mode = 0o600): void {
  const path = settingsPath(root);
  mkdirSync(join(root, "home/.claude"), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

function renderFixture(fixture: Fixture, root: string): Promise<void> {
  return new Promise((finish, reject) => {
    const home = join(root, "home");
    const temp = join(root, "tmp");
    const agentRulesPath = join(root, "xdg/state/dotfiles/agent-rules.md");
    mkdirSync(home, { recursive: true });
    mkdirSync(temp, { recursive: true });
    mkdirSync(dirname(agentRulesPath), { recursive: true });
    writeFileSync(agentRulesPath, "## General guidelines\n\nFixture shared rule.\n", {
      mode: 0o600,
    });
    const child = spawn(
      "chezmoi",
      [
        "--source",
        sourceDir,
        "--override-data",
        JSON.stringify({ agentRulesPath, dotfilesProfile: "workstation" }),
        "execute-template",
        "--with-stdin",
        "--file",
        templatePath,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(root, "xdg/config"),
          XDG_CACHE_HOME: join(root, "xdg/cache"),
          XDG_DATA_HOME: join(root, "xdg/data"),
          XDG_STATE_HOME: join(root, "xdg/state"),
          TMPDIR: temp,
          GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      const output = Buffer.concat(stderr).toString();
      try {
        if (fixture.malformed) {
          assert.notEqual(status, 0);
          assert.match(output, /fromJson|invalid character|unexpected end/i);
          finish();
          return;
        }
        assert.equal(status, 0, output);
        const actual = decodeSettings(Buffer.concat(stdout).toString());
        const expected = fixture.expected ?? {};
        assert.deepEqual(
          {
            ...actual,
            env: unmanagedEnv(actual.env),
            model: undefined,
            modelSettings: {
              ...actual.modelSettings,
              "claude-opus-5-5": {
                ...actual.modelSettings?.["claude-opus-5-5"],
                effortLevel: undefined,
              },
            },
            effortLevel: undefined,
            autoCompactWindow: undefined,
            outputStyle: undefined,
            attribution: undefined,
            syncClaudeAiPlugins: undefined,
            permissions: { ...actual.permissions, [managedMode]: undefined },
          },
          {
            ...expected,
            env: expected.env,
            model: undefined,
            modelSettings: {
              ...expected.modelSettings,
              "claude-opus-5-5": {
                ...expected.modelSettings?.["claude-opus-5-5"],
                effortLevel: undefined,
              },
            },
            effortLevel: undefined,
            autoCompactWindow: undefined,
            outputStyle: undefined,
            attribution: undefined,
            syncClaudeAiPlugins: undefined,
            autoMemoryDirectory: memoryDirectory,
            autoMemoryEnabled: true,
            permissions: { ...expected.permissions, [managedMode]: undefined },
          },
        );
        assert.equal(actual.model, "claude-opus-5-5[1m]");
        assert.equal(actual.modelSettings?.["claude-opus-5-5"]?.effortLevel, "medium");
        assert.equal(actual.effortLevel, "medium");
        assert.equal(actual.autoCompactWindow, 400_000);
        assert.equal(actual.outputStyle, "Concise");
        assert.equal(actual.syncClaudeAiPlugins, false);
        assert.equal(actual.autoMemoryEnabled, true);
        assert.equal(actual.autoMemoryDirectory, memoryDirectory);
        assert.deepEqual(actual.attribution, { commit: "", pr: "", sessionUrl: false });
        assert.equal(actual.permissions?.[managedMode], "auto");
        assert.deepEqual({ ...actual.env, ...managedEnv }, actual.env);
        finish();
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(fixture.contents);
  });
}

async function verifyMissingFile(root: string): Promise<void> {
  const fixtureRoot = join(root, "missing");
  await runApply("workstation", fixtureRoot);
  const path = settingsPath(fixtureRoot);
  const written = decodeSettings(readFileSync(path, "utf8"));
  assert.equal(written.autoMemoryEnabled, true);
  assert.equal(written.autoMemoryDirectory, memoryDirectory);
  assert.equal(written.permissions?.[managedMode], "auto");
  assert.deepEqual(written.env, managedEnv);
  assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o600);
}

async function verifyMalformedFile(root: string): Promise<void> {
  const fixtureRoot = join(root, "malformed");
  const original = '{"env":';
  writeSettings(fixtureRoot, original);
  await assert.rejects(
    runApply("workstation", fixtureRoot),
    /fromJson|invalid character|unexpected end/i,
  );
  assert.equal(readFileSync(settingsPath(fixtureRoot), "utf8"), original);
}

async function verifyModeAndIdempotence(root: string): Promise<void> {
  const fixtureRoot = join(root, "wrong-mode");
  const path = settingsPath(fixtureRoot);
  writeSettings(fixtureRoot, '{"theme":"light"}\n', 0o644);
  await runApply("workstation", fixtureRoot);
  const firstContents = readFileSync(path, "utf8");
  const firstMtime = statSync(path, { bigint: true }).mtimeNs;
  assert.equal(decodeSettings(firstContents).autoMemoryEnabled, true);
  assert.equal(decodeSettings(firstContents).autoMemoryDirectory, memoryDirectory);
  assert.equal(decodeSettings(firstContents).model, "claude-opus-5-5[1m]");
  assert.equal(
    decodeSettings(firstContents).modelSettings?.["claude-opus-5-5"]?.effortLevel,
    "medium",
  );
  assert.equal(decodeSettings(firstContents).effortLevel, "medium");
  assert.equal(decodeSettings(firstContents).outputStyle, "Concise");
  assert.equal(decodeSettings(firstContents).permissions?.[managedMode], "auto");
  assert.equal(Number(statSync(path, { bigint: true }).mode & 0o777n), 0o600);
  await runApply("workstation", fixtureRoot);
  assert.equal(readFileSync(path, "utf8"), firstContents);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, firstMtime);
  const reordered = `${JSON.stringify(
    Object.fromEntries(
      Object.entries(Schema.decodeUnknownSync(JsonDocument)(firstContents)).toReversed(),
    ),
  )}\n`;
  writeFileSync(path, reordered);
  const reorderedMtime = statSync(path, { bigint: true }).mtimeNs;
  await runApply("workstation", fixtureRoot);
  assert.equal(readFileSync(path, "utf8"), reordered);
  assert.equal(statSync(path, { bigint: true }).mtimeNs, reorderedMtime);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-claude-settings-"));
  try {
    const results = await Promise.allSettled([
      ...fixtures.map((fixture) => renderFixture(fixture, join(root, "render"))),
      verifyMissingFile(root),
      verifyMalformedFile(root),
      verifyModeAndIdempotence(root),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runMain(
  Effect.tryPromise({ try: main, catch: (error) => error }).pipe(
    Effect.tap(() => Console.log("ok Claude user settings preserve unrelated state")),
  ),
);
