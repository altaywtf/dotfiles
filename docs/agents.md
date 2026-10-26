# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers. Setup replaces drifted harness defaults on each run; the
[Claude settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json),
[Codex configuration](../agents/codex/config.ts), and
[Slopguard configuration](../chezmoi/private_dot_config/slopguard/private_config.yaml)
own them.

Keep Claude telemetry on: `DISABLE_TELEMETRY` also stops the feature-flag
fetch that auto mode, Remote Control, and cross-machine messaging need.

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

- Each fragment, or its symlink target, must be owned by the user and
  writable by nobody else.
- To keep fragments in a private directory, run
  `./dotfiles apply PROFILE --agent-source DIR` once. Apply then links
  `agents.start.md` to `DIR/rules/agents.md`, `agents.end.md` to
  `DIR/rules/agents.<short hostname>.md`, and the other fragments to the same
  name in `DIR/settings/`.
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
- Sync removes only entries its locks under `~/.local/state/dotfiles/agents/`
  record, so manual installs survive.
- Machine-specific skills, MCP servers, and plugins go in an optional,
  gitignored `agents/local.json` with `skills`, `servers`, and `plugins` arrays
  in the manifest entry shapes. Entries only add; keep credentials out of it.
- A plugin `marketplace` is `owner/repo`, an HTTPS or SSH Git URL, or an
  absolute path. Sources other than `owner/repo` need a `marketplaceId`.

## MCP Authentication

Plugin-shipped servers sign in through each harness's MCP menu. For manifest
servers, `mise run agents:doctor` prints a repair command per row.

Over SSH, run the login under `ssh -t` and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.
