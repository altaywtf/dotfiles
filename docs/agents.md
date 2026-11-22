# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCPs. Setup replaces drifted harness defaults on each run; the
[Claude settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json)
and [Codex configuration](../agents/codex/config.ts) own them.

Keep Claude telemetry on: `DISABLE_TELEMETRY` also stops the feature-flag
fetch that auto mode, Remote Control, and cross-machine messaging need.

## Global Rules

[rules/shared.json](../agents/rules/shared.json) lists the shared rule sources; the text must
start with a `##` heading. Apply renders `~/.agents/AGENTS.md`, which
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link to. Apply replaces these
files without backup, so keep private edits in fragments:

| File                                      | Effect                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/dotfiles/agents.start.md`      | Markdown before the shared rules                                                                                                                                                                                                                                                                                                                                             |
| `~/.config/dotfiles/agents.end.md`        | Markdown after the shared rules                                                                                                                                                                                                                                                                                                                                              |
| `~/.config/dotfiles/claude-automode.json` | Claude `autoMode`; without it, `autoMode` is kept                                                                                                                                                                                                                                                                                                                            |
| `~/.config/dotfiles/claude-settings.json` | Deep-merged over the managed Claude settings                                                                                                                                                                                                                                                                                                                                 |
| `~/.config/dotfiles/codex.json`           | Codex key paths to values; each replaces the managed value                                                                                                                                                                                                                                                                                                                   |
| `~/.config/dotfiles/codex.rules`          | Renders to `~/.codex/rules/local.rules`                                                                                                                                                                                                                                                                                                                                      |
| `~/.config/dotfiles/t3-gateway.json`      | Personal workstations and devboxes: T3 Code, the Codex CLI and app, and the `claude` shell command run on their usual homes, plugins and MCPs, but through the `baseUrl` gateway with the `keyCommand` key. Pi's Anthropic and OpenAI providers use the same gateway. The Claude desktop app keeps its own login. `keyCommand` runs without your shell's `PATH` or directory |

- Each fragment, or its symlink target, must be owned by the user and
  writable by nobody else.
- To keep fragments in a private directory, run
  `./dotfiles apply PROFILE --agent-source DIR` once. Apply then links
  `agents.start.md` to `DIR/rules/agents.md`, `agents.end.md` to
  `DIR/rules/agents.<short hostname>.md`, and the other fragments to the same
  name in `DIR/settings/`.
- An agent source provides only `rules/` and `settings/`. Ship its skills and
  MCPs as a plugin, and list that plugin in a [plugins/](../agents/plugins/)
  layer.
- Setup needs a valid rule cache when fetching fails.
  `DOTFILES_AGENT_RULES_OFFLINE=1` uses the cache without fetching.

## Skill Sync

Keep stack-specific skills in the consuming repository; the `slopskills` skill
from the [workflow plugin](../agents/plugins/developer.json) installs them.
One-time setup skills such as `effect-ts` install globally.
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
- Machine-specific skills, MCPs, and plugins go in an optional,
  gitignored `agents/local.json` with `skills`, `mcps`, and `plugins` arrays
  in the manifest entry shapes. Entries only add; keep credentials out of it.
- A remote MCP that needs a bearer token sets `headersHelper` to an absolute
  or `~/` path and `harnesses` to `["claude"]`; Codex has no equivalent. The
  helper prints the headers as JSON and reads the token from a mode-0600 file
  or a secret manager.
- A remote MCP whose OAuth provider refuses dynamic client registration sets
  `oauth` to `{ "clientId": "…", "callbackPort": 8080 }`. Register
  `http://localhost:PORT/callback` for Claude Code and the
  `mcp_servers.NAME.oauth.callback_url` that sync writes to
  `~/.codex/config.toml` for Codex. `oauth` and `headersHelper` are mutually
  exclusive.
- A plugin `marketplace` is `owner/repo`, an HTTPS or SSH Git URL, or an
  absolute path. Sources other than `owner/repo` need a `marketplaceId`.
- Pi gets every Claude plugin through `pi-claude-marketplace`: sync owns
  `~/.pi/agent/claude-plugins.json`, so add Pi-only plugins with
  `/claude:plugin install --local`.
- When `agy` is installed, plugin sync installs Claude-layer plugins into
  `~/.gemini/config/plugins/` and links each enabled plugin into existing T3
  Code Antigravity profiles under `~/.t3/userdata/providers/antigravity/*/config/plugins/`.
- On personal and devbox profiles, sync also trusts `~/projects` and
  `~/.t3/worktrees` in `~/.pi/agent/trust.json`; it only adds entries, so
  manage other folders with Pi's `/trust`.

## MCP Authentication

Plugin-shipped MCPs sign in through each harness's MCP menu (`/mcp` in Pi). For manifest
MCPs, `mise run agents:doctor` prints a repair command per row.

Over SSH, run the login under `ssh -t` and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.
