import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "chezmoi");
export const sharedFixtureRules =
  "## General guidelines\n\nFixture shared rule.\n\n### Delivery\n\nShared fixture delivery rule.\n";

const temporaryDirectories: string[] = [];

export function cleanupFixtures(): void {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
}

export function agentRulesCache(home: string): string {
  return join(home, ".local/state/dotfiles/agent-rules.md");
}

export function createFixture(): { config: string; home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-agents-local-"));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  const config = join(root, "chezmoi.toml");
  mkdirSync(home, { recursive: true });
  mkdirSync(dirname(agentRulesCache(home)), { recursive: true });
  writeFileSync(config, "");
  writeFileSync(agentRulesCache(home), sharedFixtureRules, { mode: 0o600 });
  return { config, home, root };
}

export function runChezmoiResult(
  home: string,
  config: string,
  command: "apply" | "diff",
  source = sourceDir,
  profile = "workstation",
) {
  const args = [
    "--config",
    config,
    "--source",
    source,
    "--destination",
    home,
    "--override-data",
    JSON.stringify({ agentRulesPath: agentRulesCache(home), dotfilesProfile: profile }),
  ];
  if (command === "apply") {
    args.push("--force");
  }
  args.push(command);

  return spawnSync("chezmoi", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
    },
  });
}

export function runChezmoi(
  home: string,
  config: string,
  command: "apply" | "diff",
  source = sourceDir,
  profile = "workstation",
): string {
  const result = runChezmoiResult(home, config, command, source, profile);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export function runWrapperResult(
  home: string,
  profile = "workstation",
  extraArgs: readonly string[] = [],
) {
  return spawnSync(
    join(repoRoot, "bootstrap/apply-dotfiles.ts"),
    ["--profile", profile, ...extraArgs],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        DOTFILES_AGENT_RULES_OFFLINE: "1",
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_STATE_HOME: join(home, ".local/state"),
      },
    },
  );
}

export function runWrapper(home: string, profile = "workstation"): string {
  const result = runWrapperResult(home, profile);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export function assertManagedRules(home: string): string {
  const rules = join(home, "AGENTS.md");
  assert.equal(lstatSync(rules).isFile(), true);
  assert.equal(lstatSync(rules).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(home, ".claude/CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(home, ".codex/AGENTS.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(home, ".claude/CLAUDE.md")), "../AGENTS.md");
  assert.equal(readlinkSync(join(home, ".codex/AGENTS.md")), "../AGENTS.md");
  return readFileSync(rules, "utf8");
}
