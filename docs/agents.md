# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers.

## Harness Defaults

Every harness starts in its auto-approval mode; switch to full access per
session. Setup replaces drifted values on each run.

| Harness     | Owner                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Claude Code | [settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json)        |
| Codex       | [Codex configuration](../agents/codex/config.ts)                                       |
| Slopguard   | [Slopguard configuration](../chezmoi/private_dot_config/slopguard/private_config.yaml) |

Slopguard values are account defaults. Repository configuration, environment
variables, and explicit flags override them.

Claude usage metrics stay on: `DISABLE_TELEMETRY` also stops feature-flag
fetching, which auto mode, Remote Control, and cross-machine messaging need.
Model-training choices are account settings, not client configuration.

[Codex project trust](../agents/codex/projects.ts) applies on setup and
maintenance:

- Personal and devbox profiles trust each Git checkout at `~/projects/NAME`
  or `~/projects/OWNER/NAME`. Linked worktrees inherit their main checkout's
  trust.
- Existing entries keep their trust level.
- Entries for missing checkout-shaped paths under `~/projects` are removed, so
  the [security audit](security-audits.md) stays quiet. Broad entries the
  audit warns about stay for the operator.
- Every profile restricts the Codex state the devbox audit checks to owner-only
  access, since Codex creates it with the process umask.

## Global Rules

[Rule sources](../agents/rules.json) supply the shared text, joined in listed
order; it must start with a `##` heading.
[Chezmoi](../chezmoi/private_AGENTS.md.tmpl) combines it with private fragments
into `~/AGENTS.md`; `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link there.
Generated rule files are replaced without backups, so keep private edits in
fragments:

| File                                      | Effect                                            |
| ----------------------------------------- | ------------------------------------------------- |
| `~/.config/dotfiles/agents.start.md`      | Markdown before the shared rules                  |
| `~/.config/dotfiles/agents.end.md`        | Markdown after the shared rules                   |
| `~/.config/dotfiles/claude-automode.json` | Claude `autoMode`; without it, `autoMode` is kept |
| `~/.config/dotfiles/codex.rules`          | Renders to `~/.codex/rules/local.rules`           |

- Fragments are optional and literal. Each file or resolved symlink target
  must be a regular file owned by the current user with no group or other
  write access. Apply restricts a group- or other-readable target, such as one
  a `git pull` under umask `022` rewrote, to owner-only access and warns; a
  preview only reports it.
- Codex keeps rules approved in its TUI in `default.rules`.
- To keep fragments in a private directory, store it once with
  `./dotfiles apply PROFILE --rules-source DIR`. Each apply then links each
  file above to the same name in `DIR`, except `agents.start.md` to
  `DIR/agents.md` and `agents.end.md` to `DIR/agents.<short hostname>.md`.
  It links only files `DIR` has, refuses to replace a regular file, and
  removes its own links to files `DIR` no longer has.
- When a fragment links into a Git checkout, the
  [scheduled updater](software-updates.md#dotfiles-convergence) fast-forwards
  that checkout before rendering. A checkout with local work is kept with a
  warning.

Preview and apply through the [profile setup workflow](bootstrap.md#apply-a-profile).

The [rule loader](../agents/rules.ts) owns remote validation and the cache
fallback. Invalid content leaves the existing cache intact. If fetching or
scanning is unavailable, setup needs a valid cache. Set
`DOTFILES_AGENT_RULES_OFFLINE=1` to use cached rules without fetching.

## Skill Sync

Keep stack-specific skills, such as React, TanStack, shadcn, and Swift, in the
consuming repository. The `slopskills` skill from the
[workflow plugin](../agents/plugins/developer.json) selects and installs them.
The [developer manifest](../agents/skills/developer.json) holds the skills
every profile installs.

Run from the checkout after bootstrap has stored the profile:

```zsh
mise run agents:sync
mise run agents:update
```

- `update` also refreshes **all global skills**, including manually installed
  extras, and managed plugins.
- Third-party manifest skills pin a commit as
  `https://github.com/OWNER/REPO/tree/SHA`, so `update` keeps them at that
  commit. Renovate proposes new commits.
- A failed global skill update leaves the completed manifest sync in place.
- These commands do not pull Git or refresh rule files.

The [profile model](../chezmoi/.chezmoidata/profiles.json) selects
`agentLayers`. Edit the selected layer's manifest:

| Selection   | Manifests                      | Implementation                     |
| ----------- | ------------------------------ | ---------------------------------- |
| Skills      | [skills/](../agents/skills/)   | [sync.ts](../agents/sync.ts)       |
| Plugins     | [plugins/](../agents/plugins/) | [plugins.ts](../agents/plugins.ts) |
| MCP servers | [mcps/](../agents/mcps/)       | [mcps.ts](../agents/mcps.ts)       |

Each parser defines its manifest fields and supported harnesses.

### Local Overlay

Machine-specific skills and MCP servers go in an optional gitignored
`agents/local.json`, the agent counterpart of
[`Brewfile.local`](profiles.md#local-homebrew-additions):

```json
{
  "skills": [{ "name": "local-skill", "source": "owner/skill-repository" }],
  "servers": [
    { "name": "local-mcp", "url": "https://example.invalid/mcp", "harnesses": ["claude"] }
  ]
}
```

- Both keys are optional and use the manifest entry shapes; any other key
  fails. The [overlay reader](../agents/local.ts) requires a regular file owned
  by the current user without group or other write access.
- Entries form a final `local` layer that can only add. An entry identical to
  a profile entry is ignored. The same name with a different shape fails, so
  a local file never silently changes a shared selection.
- Overlay entries share the ownership lock, so deleting one removes it on the
  next sync. A sync from another checkout keeps them while the owning checkout
  exists.
- Keep credentials out of it. OAuth state stays in each harness's own store.

### Ownership

Each sync keeps its ownership lock in
`~/.local/state/dotfiles/agents/{skills,plugins,mcps}.lock.json`, outside the
checkout, so applying from a temporary clone keeps ownership. Syncs from
different checkouts run one at a time.
[Ownership planning](../agents/ownership.ts) decides removals:

- Missing locks initialize ownership without removing existing installations.
- Later runs remove dropped selections and keep never-owned extras.
- Plugin and MCP removals awaiting a missing CLI stay owned until it returns.
- Failed installs or removals leave that sync's lock unchanged; earlier
  commands may already have changed the host. Fix the reported failure and
  rerun.
- A Claude plugin synced from claude.ai (`<name>@synced` in
  `claude plugin list --json`) belongs to claude.ai. The sync skips its Claude
  install and uninstalls any same-named user-scope copy, which would shadow
  it. Codex installs are unaffected.
- When Claude is not signed in for the run (`loggedIn` in `claude auth status`
  is not true, or unreadable), as under the scheduled updater without keychain
  access, the sync leaves Claude plugins and their lock entries unchanged and
  still syncs Codex.

## MCP Authentication

OAuth MCP sessions expire per harness. Plugin-shipped servers sign in through
each harness's MCP menu. [Doctor](../agents/doctor.ts) checks manifest servers
in every installed harness and prints a repair command per row:

```zsh
mise run agents:doctor
```

Over SSH the callback port stays on the remote host: run the login under
`ssh -t` (Claude and Codex need a TTY) and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

## Verify

The `agents` domain covers harness settings, rules, skills, plugins, and MCP
integration. The `config` domain covers the remaining managed-home
configuration.

```zsh
mise run verify:domain agents
mise run verify:domain config
```
