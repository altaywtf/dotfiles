import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "vite-plus/test";
import { fileURLToPath } from "node:url";

import { main } from "./doctor.ts";
import { type Runtime } from "./runtime.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class BufferWriter {
  value = "";
  write(message: string): void {
    this.value += message;
  }
}

type Reply = { status?: number; stdout?: string; stderr?: string };

class FixtureRuntime implements Runtime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout = new BufferWriter();
  readonly stderr = new BufferWriter();
  readonly installedCommands = new Set(["claude", "codex", "sh"]);
  readonly repoDir: string;
  readonly replies: ReadonlyMap<string, Reply>;

  constructor(repoDir: string, home: string, replies: ReadonlyMap<string, Reply>) {
    this.repoDir = repoDir;
    this.env = { HOME: home, PWD: "/fixture/project" };
    this.replies = new Map(
      [...replies].map(([command, reply]) => [
        command,
        { ...reply, stdout: reply.stdout?.replaceAll("$HOME", home) },
      ]),
    );
  }

  commandExists(command: string): boolean {
    return this.installedCommands.has(command);
  }

  run(command: string, args: readonly string[]) {
    if (command.endsWith("/resolve-profile.ts"))
      return { status: 0, stdout: "workstation\n", stderr: "" };
    const reply = this.replies.get(`${command} ${args.join(" ")}`) ?? {};
    return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { force: true, recursive: true });
});

function createFixture(): { repoDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-doctor-"));
  temporaryDirectories.push(root);
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repoDir, "chezmoi/.chezmoidata"), { recursive: true });
  mkdirSync(join(repoDir, "agents/mcps"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(repoDir, "chezmoi/.chezmoidata/profiles.json"),
    readFileSync(join(repoRoot, "chezmoi/.chezmoidata/profiles.json")),
  );
  for (const layer of ["developer", "workstation", "devbox", "personal"]) {
    writeFileSync(
      join(repoDir, `agents/mcps/${layer}.json`),
      JSON.stringify({
        mcps:
          layer === "developer"
            ? [{ name: "shared-mcp", url: "https://mcp.fixture.test/mcp" }]
            : [],
      }),
    );
  }
  return { repoDir, home };
}

const healthy = new Map<string, Reply>([
  [
    "claude mcp get shared-mcp",
    { stdout: "shared-mcp:\n  Status: ✔ Connected\n  URL: https://mcp.fixture.test/mcp\n" },
  ],
  [
    "codex mcp list --json",
    { stdout: JSON.stringify([{ name: "shared-mcp", auth_status: "o_auth" }]) },
  ],
]);

test("reports every harness usable and exits 0", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /ok {4}Claude Code: shared-mcp - connected/);
  assert.match(runtime.stdout.value, /\? {5}Codex: shared-mcp - o_auth/);
  assert.match(runtime.stdout.value, /All managed MCPs are usable\./);
  assert.doesNotMatch(runtime.stdout.value, /repair:/);
});

test("names the login command for each expired harness and exits 1", () => {
  const { repoDir, home } = createFixture();
  const replies = new Map(healthy);
  replies.set("claude mcp get shared-mcp", {
    stdout: "shared-mcp:\n  Status: ! Needs authentication\n",
  });
  const runtime = new FixtureRuntime(repoDir, home, replies);
  assert.equal(main([], runtime), 1);
  assert.match(
    runtime.stdout.value,
    /LOGIN Claude Code: shared-mcp[^\n]*\n {6}repair: claude mcp login shared-mcp/,
  );
  assert.match(runtime.stdout.value, /1 MCP state\(s\) need attention\./);
});

test("skips harnesses that are not installed", () => {
  const { repoDir, home } = createFixture();
  const runtime = new FixtureRuntime(repoDir, home, healthy);
  runtime.installedCommands.delete("codex");
  assert.equal(main([], runtime), 0);
  assert.match(runtime.stdout.value, /Skipping Codex: 'codex' is not installed/);
});
