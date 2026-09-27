# Agent Setup

The selected [profile](profiles.md) controls global rules, skills, plugins,
and MCP servers.

[Codex configuration](../agents/codex/config.ts) owns native configuration writes
and managed defaults. Bootstrap validates the profile and invokes it; gateway
configuration uses the same writer for enrollment and restoration. Gateway setup
preserves the selected Codex model and reasoning effort; model defaults belong
to Codex configuration.

[Gateway enrollment](../agents/gateway/enrollment.ts) owns input validation,
configuration, and rollback. Setup and maintenance preserve vendor logins.
The [gateway command](../bootstrap/configure-llm-gateway.ts) exposes apply,
check, and rollback operations.
Grok maintenance replaces only the managed gateway block, preserving newer
preferences. Adding or removing `grokBin` changes the client set in place, so
Codex and Claude keep everything added since enrollment. Rollback retains its
original enrollment snapshot semantics.
If a native TOML rewrite drops block comments, the exact configured gateway
sections are still recognized; conflicting values remain an error.

[Codex project trust](../agents/codex/projects.ts) runs with the Codex defaults
on setup and maintenance. Personal and devbox profiles trust each Git checkout
at `~/projects/NAME` or `~/projects/OWNER/NAME`; linked worktrees inherit their
main checkout's trust. Existing entries keep their trust level. Entries for
checkout-shaped paths under `~/projects` that no longer exist are removed so the
[security audit](security-audits.md) stays quiet; other entries, including broad
ones the audit warns about, are left for the operator. Every profile also
removes group and other access from the Codex state the devbox audit checks,
since Codex creates it with the process umask.

Personal profiles install a [worktree guard](../agents/hooks/worktree-guard.ts)
as a `PreToolUse` Bash hook in Claude Code settings and `~/.codex/hooks.json`.
It blocks `git worktree add` or `move` into `~/projects`, except OpenClaw's
`~/projects/openclaw/openclaw/.worktrees/`, and points at the harness worktree
folders. Paths built from variables pass unchecked. Codex skips a new or changed
hook until it is trusted in `/hooks`; other profiles remove the hook.

## Permissions and Privacy

Every harness starts in its auto-approval mode; switch to full access per
session. Setup replaces drifted values on each run.

| Harness     | Owner                                                                           | Managed defaults                                                                                                            |
| ----------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | [settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json) | auto mode; no error reports, `/feedback`, or session surveys                                                                |
| Codex       | [Codex configuration](../agents/codex/config.ts)                                | on-request approvals routed to auto review in the `:workspace` profile; no analytics, feedback, or Statsig metrics          |
| Grok        | [Grok configuration](../agents/grok/config.ts)                                  | auto permission mode; no self-update, telemetry, feedback, trace, workspace, or codebase uploads; retired plugin ids pruned |

Grok's launcher runs whatever `~/.grok/bin/grok` links to, and mise installs
the package without running the postinstall step that restages that link.
Grok setup moves a stale link aside so the pinned launcher stages its own
version, restoring it if staging fails; the doctor flags global npm installs.

Claude usage metrics stay on: `DISABLE_TELEMETRY` also stops feature-flag
fetching, which auto mode, Remote Control, and cross-machine messaging need.
Model-training choices are account settings, not client configuration.

## Global Rules

[Rule sources](../agents/rules.json) supply the shared text.
[Chezmoi](../chezmoi/private_AGENTS.md.tmpl) combines it with private fragments
into `~/AGENTS.md`; `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` link there.
Grok reads `~/.claude/CLAUDE.md` through its default Claude compatibility,
so it needs no separate link.
Edit shared rules at their configured source and private instructions in:

| File                                 | Position            |
| ------------------------------------ | ------------------- |
| `~/.config/dotfiles/agents.start.md` | Before shared rules |
| `~/.config/dotfiles/agents.end.md`   | After shared rules  |

- Fragments are optional, literal Markdown. Each file or resolved symlink target
  must be a regular file owned by the current user with no group or other write
  access. Apply restricts a group- or other-readable target, such as one a
  `git pull` under umask `022` rewrote, to owner-only access and warns; a
  preview only reports it.
- Generated rule files are replaced without backups. Keep private edits in fragments.
- When a fragment links into a Git checkout, the
  [scheduled updater](software-updates.md#dotfiles-convergence) fast-forwards that
  checkout before rendering. A checkout with local work is kept with a warning.

Preview and apply through the [profile setup workflow](bootstrap.md#apply-a-profile).

The [rule loader](../agents/rules.ts) owns remote validation and cache fallback.
[Local fragment validation](../agents/rules-local.ts) checks file ownership and permissions.
Invalid content leaves the existing cache intact. If fetching or scanning is
unavailable, setup needs a valid cache to continue. Set
`DOTFILES_AGENT_RULES_OFFLINE=1` to require cached rules without fetching.

## Skill Sync

Keep React, TanStack, shadcn, and Swift skills in the consuming repository. Use `slopskills` from
the [configured workflow plugin](../agents/plugins/developer.json) to select
and install them from repository evidence and the current task.
The [developer manifest](../agents/skills/developer.json) lists the skills every
profile installs.
The plugin catalog supplies stack recommendations; explicit global selections
do not need duplicate repo-local installs.

Run from the checkout after bootstrap has stored the profile:

```zsh
mise run agents:sync
mise run agents:update
```

- `update` also refreshes **all global skills**, including manually installed
  extras, and managed plugins.
- A failed global skill update leaves the completed manifest sync in place.
- These commands do not pull Git or refresh rule files.

Edit the selected layer under each manifest directory:

| Selection   | Manifests                      | Implementation                     |
| ----------- | ------------------------------ | ---------------------------------- |
| Skills      | [skills/](../agents/skills/)   | [sync.ts](../agents/sync.ts)       |
| Plugins     | [plugins/](../agents/plugins/) | [plugins.ts](../agents/plugins.ts) |
| MCP servers | [mcps/](../agents/mcps/)       | [mcps.ts](../agents/mcps.ts)       |

The [profile model](../chezmoi/.chezmoidata/profiles.json) selects `agentLayers`;
each parser defines its manifest fields and supported harnesses.
An agent layer groups skill, plugin, and MCP selections for reuse across profiles.
The [MCP catalog](../agents/mcps/catalog.ts) validates and composes server
declarations for both sync and doctor. The [skill catalog](../agents/skills/catalog.ts)
validates declarations and ownership locks for sync and maintenance inventory.

### Local Overlay

Machine-specific skills and MCP servers that no shared layer should carry go
in an optional gitignored `agents/local.json`, the agent counterpart of
[`Brewfile.local`](profiles.md#local-homebrew-additions):

```json
{
  "skills": [{ "name": "local-skill", "source": "owner/skill-repository" }],
  "servers": [
    { "name": "local-mcp", "url": "https://example.invalid/mcp", "harnesses": ["claude"] }
  ]
}
```

- Both keys are optional and use the manifest entry shapes above; any other key
  fails. The [overlay reader](../agents/local.ts) requires a regular file owned
  by the current user without group or other write access.
- Entries are composed after the selected profile layers as a final `local`
  layer and can only add. An entry identical to a profile entry is ignored; the
  same name with a different shape fails, so a local file never silently
  changes a shared selection. Remove an entry by deleting it from the file.
- Overlay entries enter the same ownership lock, so dropping one removes it on
  the next sync like any dropped manifest entry. The lock records which
  checkout's overlay installed them; a sync from another checkout keeps them
  while the owning checkout exists. Sync, doctor, and the maintenance inventory all read the
  overlay; sync prints its path when used.
- Keep credentials out of it. OAuth state stays in each harness's own store.

Each sync keeps its ownership lock in `~/.local/state/dotfiles/agents/{skills,plugins,mcps}.lock.json`,
outside the checkout, so applying from a temporary clone keeps ownership. A lock
left at the old `agents/*.lock.json` path of the checkout, or of its main
worktree, moves there on the next sync. Syncs hold a per-user lock beside it, so
syncs from different checkouts run one at a time:

- Missing locks initialize ownership without removing existing installations.
- Subsequent runs remove dropped selections while preserving never-owned extras.
- Plugin and MCP removals awaiting a missing CLI remain owned until it returns.
- Failed installs or removals leave that sync's lock unchanged; earlier successful
  commands may already have changed the host. Fix the reported failure and rerun.

[Ownership planning](../agents/ownership.ts) computes plugin and MCP removals
and the next lock from selected entries, previous ownership, and available
harnesses. Syncs execute those removals and pass deferred entries back to the
plan; the lock is written only after successful apply and removal operations.
Plugin-specific ownership changes stay in
[plugin sync](../agents/plugins.ts).

## MCP Sync

Executor and other OAuth servers expire their sessions per harness. Check
every installed harness at once and get the repair command per row:

```zsh
mise run agents:doctor
```

Use the repair command printed by [doctor.ts](../agents/doctor.ts).

Over SSH the callback port stays on the remote host: run the login under
`ssh -t` (Claude and Codex need a TTY) and forward the printed loopback port
with `ssh -L PORT:127.0.0.1:PORT` before opening the URL locally.

The doctor also reports Grok installation drift and prints the repair command:
any `grok` on `PATH` other than the mise pin, a mise shim that dispatches
elsewhere, or a global npm install.
Review it before removing a conflicting installation.

## Hindsight Memory

Personal profiles run `configure-hindsight` after agent sync.
[Hindsight setup](../agents/hindsight.ts) keeps the
`@vectorize-io/hindsight-coding-agents` runtime at the published version and
wires every installed managed harness through the upstream installer, which
rewrites only its own hook and MCP entries. The runtime's own `autoUpdate`
re-stages code but never rewires hosts; a harness whose MCP entry lacks
`HINDSIGHT_MCP_HARNESS` fails its handshake, so the step reinstalls whenever the
version or that wiring drifts. Daily maintenance repeats the step.

When a published release lacks a fix, `CLIENT_OVERRIDE` in that file pins a
build of it: the step downloads the tarball, checks its SHA-256, and installs
it instead while npm still publishes the release it patches. The first newer
release replaces it; delete the override then.

The server endpoint and token stay in owner-only `~/.hindsight/coding-agent.json`;
setup requires them and never writes them. Each machine gets its own token from
the owning private system; never copy one machine's token to another, so a
single machine can be rotated or revoked alone. To rotate, replace `apiToken`
in that file; restart running sessions so their MCP servers reload it.

A directory whose repositories belong to another tenant gets a
`paths.<prefix>` entry with that tenant's `apiToken` (and `apiUrl` if it
differs). The published runtime selects credentials only per bank, so the
setup step copies each entry's credentials into
`banks.coding-agent::<repository>` for every Git repository directly under the
prefix, and `--check` reports a repository that lacks them. The longest prefix
wins. This is the only thing setup writes to the file, and it skips configs
with a custom `bankId` or `bankIdTemplate`.
Provision a new machine once:

```zsh
npx -y @vectorize-io/hindsight-coding-agents@latest install claude-code \
  --server self-hosted --api-url URL --api-token TOKEN
./bootstrap/configure-hindsight.ts
./bootstrap/configure-hindsight.ts --check
```

## Verify

The `agents` domain covers harness settings, gateways, rules, skills, plugins,
and MCP integration. The `config` domain covers the remaining managed-home
configuration.

```zsh
mise run verify:domain agents
mise run verify:domain config
```
