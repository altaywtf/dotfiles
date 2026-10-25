# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers. Setup replaces drifted harness defaults on each run; the
[Claude settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json),
[Codex configuration](../agents/codex/config.ts), and
[Slopguard configuration](../chezmoi/private_dot_config/slopguard/private_config.yaml)
own them.

- Keep Claude telemetry on: `DISABLE_TELEMETRY` also stops the feature-flag
  fetch that auto mode, Remote Control, and cross-machine messaging need.
- [Codex project trust](../agents/codex/projects.ts) trusts each checkout at
  `~/projects/NAME` or `~/projects/OWNER/NAME` on personal and devbox profiles,
  and drops entries for missing checkouts.

## Global Rules

[rules.json](../agents/rules.json) lists the shared rule sources; the text must
start with a `##` heading. Apply renders `~/AGENTS.md`, which
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link to. Apply replaces these
files without backup, so keep private edits in fragments:

| File                                      | Effect                                            |
| ----------------------------------------- | ------------------------------------------------- |
| `~/.config/dotfiles/agents.start.md`      | Markdown before the shared rules                  |
| `~/.config/dotfiles/agents.end.md`        | Markdown after the shared rules                   |
| `~/.config/dotfiles/claude-automode.json` | Claude `autoMode`; without it, `autoMode` is kept |
| `~/.config/dotfiles/codex.rules`          | Renders to `~/.codex/rules/local.rules`           |

- Each fragment, or its symlink target, must be a regular file owned by the
  user without group or other write access. Apply tightens readable targets to
  owner-only and warns.
- To keep fragments in a private directory, run
  `./dotfiles apply PROFILE --rules-source DIR` once. Apply then links each
  fragment to the same name in `DIR`, except `agents.start.md` to
  `DIR/agents.md` and `agents.end.md` to `DIR/agents.<short hostname>.md`.
- The [scheduled updater](software-updates.md#dotfiles-convergence)
  fast-forwards a clean Git checkout behind those links before rendering.
- Setup needs a valid rule cache when fetching fails.
  `DOTFILES_AGENT_RULES_OFFLINE=1` uses the cache without fetching.

## Skill Sync

Keep stack-specific skills in the consuming repository; the `slopskills` skill
from the [workflow plugin](../agents/plugins/developer.json) installs them.
[profiles.json](../chezmoi/.chezmoidata/profiles.json) selects `agentLayers`;
edit the selected layer's manifest under [skills/](../agents/skills/),
[plugins/](../agents/plugins/), or [mcps/](../agents/mcps/).

```zsh
mise run agents:sync
mise run agents:update   # also refreshes every global skill, manual extras included
```

- Third-party manifest skills pin a commit
  (`https://github.com/OWNER/REPO/tree/SHA`); Renovate proposes new ones.
- Neither command pulls Git or refreshes rule files.

### Local Overlay

Machine-specific skills and MCP servers go in an optional, gitignored
`agents/local.json`, owned by the user without group or other write access:

```json
{
  "skills": [{ "name": "local-skill", "source": "owner/skill-repository" }],
  "servers": [
    { "name": "local-mcp", "url": "https://example.invalid/mcp", "harnesses": ["claude"] }
  ]
}
```

Entries can only add. Reusing a shared entry's name with a different shape
fails. Keep credentials out of it.

### Ownership

Sync records what it installed in
`~/.local/state/dotfiles/agents/{skills,plugins,mcps}.lock.json` and removes
only those entries when they leave the selection.

- A failed install or removal leaves the lock unchanged; fix the reported
  failure and rerun.
- A Claude plugin synced from claude.ai (`<name>@synced` in
  `claude plugin list --json`) belongs to claude.ai. Sync skips it and removes
  a same-named user-scope copy.
- When Claude is not signed in, as under the scheduled updater, sync leaves
  Claude plugins alone and still syncs Codex.

## MCP Authentication

Plugin-shipped servers sign in through each harness's MCP menu. For manifest
servers, `doctor` prints a repair command per row:

```zsh
mise run agents:doctor
```

Over SSH, run the login under `ssh -t` and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

## Verify

```zsh
mise run verify:domain agents
mise run verify:domain config
```
