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

- Tasks install and run the repository's own Node (`.node-version`) and pnpm
  (`package.json` `packageManager`), so they work before a profile is applied.
  mise drops undeclared tool paths from the inherited `PATH`, so a caller's
  exported Node never reaches tasks.
- [Contributing](../CONTRIBUTING.md#verify) owns repository verification
  commands.

Live checks inspect the current Unix user's machine, separate from repository
verification. Run them only for the installed profile:

```zsh
mise run verify:bootstrap workstation # choose the installed profile
mise run verify:devbox-services       # macOS only
```

Bootstrap trusts existing mise configs in `~/.codex/worktrees` and
`~/.claude/worktrees`; the global
[mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) trust new
ones there through `trusted_config_paths`. To trust existing ones again:

```zsh
mise run bootstrap:trust-agent-worktrees
```

## Runtime Pins

Edit [the profile template](../chezmoi/.chezmoitemplates/mise.toml) or the
OS sibling that owns the pin, preview with `mise run dotfiles:diff <profile>`,
and run `mise run verify`. Keep the templates plain TOML so Renovate can parse
them; the Linux CI job resolves every pinned tool with `mise install --dry-run`.
Prefer exact versions. [Renovate rules](../renovate.json) own update holds, age
gates, and pins that must move together.

- [Runtime installation](../bootstrap/install.ts) also runs the
  `dotfiles:runtime-packages` task, so package-only pin changes converge when
  runtimes are already installed. A plain `mise install` skips that task.
- The rust pin is a fallback; a checkout's `rust-toolchain.toml` wins because
  `rust` is in `idiomatic_version_file_enable_tools`.
- pnpm is pinned to its standalone release binary. In a project whose
  `packageManager` or `devEngines` names another version, pnpm switches to it.
- The [launcher](../dotfiles) runs this repository's pnpm at its
  `packageManager` pin before the profile's mise config exists.
