# Mise Tasks

[Root mise.toml](../mise.toml) owns repository tasks.
[The profile template](../chezmoi/.chezmoitemplates/mise.toml) and its
[darwin](../chezmoi/.chezmoitemplates/darwin/mise.toml) and
[linux](../chezmoi/.chezmoitemplates/linux/mise.toml) siblings own installed
runtime and tool pins; [mise-tasks.toml](../chezmoi/.chezmoitemplates/mise-tasks.toml)
owns the packages installed inside those runtimes. Chezmoi concatenates them
into `~/.config/mise/config.toml`. Keep task entries as command delegations;
parsing and policy belong to the [domain owners](../AGENTS.md#layout).

## Tasks

Trust each checkout before using mise; without trust, task discovery and
runtime installation fail.

```zsh
mise trust
mise tasks
mise tasks validate
```

- Tasks run with the repository's own Node (`.node-version`) and pnpm
  (`package.json` `packageManager`), installing them on first use, so they work
  before a profile is applied. mise drops undeclared tool paths from the
  inherited `PATH`, so a caller's exported Node does not reach tasks.
- [Contributing](../CONTRIBUTING.md#verify) owns repository verification commands
  and their CI requirements.

Live checks inspect the current Unix user's machine. Run only for its intended
profile; these are separate from repository verification:

```zsh
mise run verify:bootstrap workstation # choose the installed profile
mise run verify:devbox-services       # macOS only
```

For generated agent worktrees whose mise configs need trust:

```zsh
mise run bootstrap:trust-agent-worktrees
```

Bootstrap runs this helper for existing configs near `~/.codex/worktrees`,
`~/.claude/worktrees`, and `~/.t3/worktrees`. The global
[mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) trust new
configs under the same roots through `trusted_config_paths`.

## Runtime Pins

Edit [the profile template](../chezmoi/.chezmoitemplates/mise.toml) or the
OS sibling that owns the pin, preview with `mise run dotfiles:diff <profile>`,
and run `mise run verify`. The templates stay plain TOML so Renovate can parse
them; the Linux CI job resolves every pinned tool with `mise install --dry-run`.
Use exact versions where practical. [Renovate rules](../renovate.json) own
update holds, age gates, and groups of pins that must move together.

[Runtime installation](../bootstrap/install.ts) also runs the
runtime-package task, so package-only pin changes converge when runtimes are
already installed. Ordinary project installs do not run that task. The rust pin is the fallback
toolchain; a checkout's `rust-toolchain.toml` wins because `rust` is listed in
`idiomatic_version_file_enable_tools`. pnpm is a mise pin of pnpm's
standalone release binary; in a project whose `packageManager` or `devEngines`
field names another version, pnpm switches to that version itself. The
[launcher](../dotfiles) runs this repository's pnpm at its `packageManager`
pin before the profile's mise config exists.
