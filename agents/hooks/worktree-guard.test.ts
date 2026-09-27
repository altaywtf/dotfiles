import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const guard = join(import.meta.dirname, "worktree-guard.ts");

function run(home: string, command: string, cwd = home) {
  return spawnSync(process.execPath, [guard], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    input: JSON.stringify({ cwd, tool_input: { command } }),
  });
}

test("worktree guard blocks targets under ~/projects except the OpenClaw review folder", (t) => {
  const home = mkdtempSync(join(tmpdir(), "worktree-guard-"));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const repo = join(home, "projects/owner/repo");
  const openclaw = join(home, "projects/openclaw/openclaw");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(openclaw, ".worktrees"), { recursive: true });

  for (const [command, cwd] of [
    ["git worktree add ~/projects/owner/repo-wt -b fix origin/main", home],
    ["git -C ~/projects/owner/repo worktree add ../repo-wt -b fix", home],
    ["cd ~/projects/owner/repo && git worktree add .wt/fix", home],
    ["git worktree add -b fix $HOME/projects/x origin/main", home],
    ["git worktree move old ../moved", repo],
    ["git worktree add ../escape", join(openclaw, ".worktrees")],
    ["command git worktree add ~/projects/x", home],
    ["env GIT_DIR=x git worktree add ~/projects/x", home],
    ["bash -lc 'cd ~/projects/owner/repo && git worktree add ../x'", home],
    ["cat <<'EOF' > notes.md\nexample\nEOF\ngit worktree add ~/projects/x", home],
  ]) {
    const result = run(home, command, cwd);
    assert.equal(result.status, 2, command);
    assert.match(
      result.stderr,
      /~\/\.claude\/worktrees, ~\/\.codex\/worktrees, ~\/\.t3\/worktrees/,
    );
  }

  for (const [command, cwd] of [
    ["git -C ~/projects/owner/repo worktree add ~/.claude/worktrees/repo-fix -b fix", home],
    ["git worktree add .worktrees/pr-1 origin/main", openclaw],
    ["git worktree list && git worktree remove ~/projects/owner/repo-wt", repo],
    ['echo "git worktree add ~/projects/x"', home],
    ["ls", repo],
    ["cat <<'EOF' > notes.md\ngit worktree add ~/projects/x\nEOF", home],
    ["cat <<-EOF\n\tgit worktree add ~/projects/x\n\tEOF\necho done", home],
  ]) {
    const result = run(home, command, cwd);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  }
});
