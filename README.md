# altaywtf/dotfiles

macOS and Ubuntu setup for one Unix user: packages, shell and Git defaults,
runtimes, coding agents, and maintenance. Private identities and secrets stay
outside Git.

## Start

- New machine: follow [Bootstrap](docs/bootstrap.md).
- Choose a [profile](docs/profiles.md#choose-a-profile).
- On a configured machine, follow [Updating an existing machine](docs/bootstrap.md#updating-an-existing-machine).

## Guides

The [repository layout](AGENTS.md#layout) maps each domain to its source owner.

| Task                                   | Guide                                                          |
| -------------------------------------- | -------------------------------------------------------------- |
| Choose packages and a user role        | [Profiles](docs/profiles.md)                                   |
| Set up age, Git, SSH, and recovery     | [Identities](docs/identities.md)                               |
| Configure shared-host services         | [Devbox](docs/devbox.md)                                       |
| Update software or clean old worktrees | [Maintenance](docs/software-updates.md)                        |
| Configure coding agents                | [Agents](docs/agents.md)                                       |
| Edit managed files                     | [Chezmoi](#chezmoi)                                            |
| Change runtime pins or find tasks      | [Mise](#mise)                                                  |
| Audit a repository or host             | [Security audits](docs/security-audits.md)                     |
| Install mobile and TV tooling          | [Mobile and TV development](docs/mobile-and-tv-development.md) |
| Change this repository                 | [Contributing](CONTRIBUTING.md)                                |

## Chezmoi

Edit tracked files under [chezmoi/](chezmoi/).
[Profile data](chezmoi/.chezmoidata/profiles.json) selects their targets;
[apply-dotfiles.ts](bootstrap/apply-dotfiles.ts) handles preview, backups, and
apply. [.chezmoiignore](chezmoi/.chezmoiignore.tmpl) owns platform and profile
exclusions; [mise](#runtime-pins) owns runtime pins.

### Workflow

For source-only changes, substitute the intended profile:

```zsh
mise trust
mise run dotfiles:diff workstation
mise run dotfiles:apply workstation
```

- `./dotfiles apply <profile>` also runs the remaining
  [bootstrap steps](docs/bootstrap.md). On Linux it reloads the systemd user
  manager and hands it the shim `PATH` from `environment.d`. The managed
  `99-zz-dotfiles.conf` sorts after the distro import of `/etc/environment`,
  so it prepends user tools to that baseline.
- Preview and apply both refresh [agent rules](docs/agents.md#global-rules).
- The wrapper backs up conflicting files and links before force-applying and
  keeps only the newest backup per target. Generated agent rule files get no
  backup.
- The [Claude settings modifier](chezmoi/private_dot_claude/modify_private_settings.json)
  sets selected defaults and preserves other fields, including `env`. When
  every managed value already matches, it returns the file unchanged, so
  Claude's key order is neither rewritten nor backed up.

For changes to apply behavior, test in isolated homes. Focused domains skip the
complete-only home fixture, so run it directly:

```zsh
mise run verify:domain config
mise run verify:domain profiles
node verify/home-fixture.ts
```

### Local Overrides

| Path                                                  | Use                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `~/.ssh/config.local`                                 | Host-specific SSH directives                                   |
| `~/.ssh/config.d/*.conf`                              | Fragments written by other tools                               |
| `~/.config/dotfiles/zshenv.local`                     | Machine-specific, non-secret shell exports                     |
| `~/.config/dotfiles/agents.start.md`, `agents.end.md` | Private agent rules                                            |
| `~/.config/dotfiles/claude-automode.json`             | Private Claude [auto mode](docs/agents.md) rules               |
| `~/.config/dotfiles/codex.rules`                      | Private Codex [command rules](docs/agents.md)                  |
| `~/.config/dotfiles/devbox.env`                       | [Per-user devbox settings](docs/devbox.md#local-configuration) |

- Route tools that write SSH config to their own `config.d` fragment instead
  of `~/.ssh/config`. On macOS, SSH also includes Colima's generated
  `~/.colima/ssh_config`.
- Create `zshenv.local` by hand with mode `0600`. The shell reads it only as a
  readable regular file and ignores symlinks at the file or its `dotfiles`
  directory.
- Apply keeps blocks other tools add to `~/.zshenv` and `~/.zshrc` between
  `# >>> NAME (managed) >>>` and `# <<< NAME (managed) <<<` lines, re-appended
  after the [managed content](chezmoi/.chezmoitemplates/zsh-managed-blocks).
  It replaces everything else in those files. A start line without its
  matching end fails apply and leaves the file untouched.
- To stop Teleport adding keys to an incompatible SSH agent, export
  `TELEPORT_ADD_KEYS_TO_AGENT=no` in `zshenv.local`.

### Source Boundaries

- Use `private_` for owner-only files and directories.
- `exact_` at home-directory scope deletes unmanaged files. Keep live app and
  auth state out of `chezmoi add`.
- Package lists and runtime installation have their own owners. Add a
  lifecycle script only for an explicit bootstrap requirement.

## Mise

[Root mise.toml](mise.toml) owns repository tasks.
[The profile template](chezmoi/.chezmoitemplates/mise.toml) and its
[darwin](chezmoi/.chezmoitemplates/darwin/mise.toml) and
[linux](chezmoi/.chezmoitemplates/linux/mise.toml) siblings own installed
runtime and tool pins; [mise-tasks.toml](chezmoi/.chezmoitemplates/mise-tasks.toml)
owns the packages installed inside those runtimes. Chezmoi concatenates them
into `~/.config/mise/config.toml`. Keep task entries as command delegations;
parsing and policy belong to the [domain owners](AGENTS.md#layout).

### Tasks

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
- [Contributing](CONTRIBUTING.md#verify) owns repository verification
  commands.

Live checks inspect the current Unix user's machine, separate from repository
verification. Run them only for the installed profile:

```zsh
mise run verify:bootstrap workstation # choose the installed profile
mise run verify:devbox-services       # macOS only
```

Bootstrap trusts existing mise configs in `~/.codex/worktrees` and
`~/.claude/worktrees`; the global
[mise settings](chezmoi/private_dot_config/mise/config.toml.tmpl) trust new
ones there through `trusted_config_paths`. To trust existing ones again:

```zsh
mise run bootstrap:trust-agent-worktrees
```

### Runtime Pins

Edit [the profile template](chezmoi/.chezmoitemplates/mise.toml) or the OS
sibling that owns the pin, preview with `mise run dotfiles:diff <profile>`, and
run `mise run verify`. Keep the templates plain TOML so Renovate can parse
them; the Linux CI job resolves every pinned tool with `mise install --dry-run`.
Prefer exact versions. [Renovate rules](renovate.json) own update holds, age
gates, and pins that must move together.

- [Runtime installation](bootstrap/install.ts) also runs the
  `dotfiles:runtime-packages` task, so package-only pin changes converge when
  runtimes are already installed. A plain `mise install` skips that task.
- The rust pin is a fallback; a checkout's `rust-toolchain.toml` wins because
  `rust` is in `idiomatic_version_file_enable_tools`.
- pnpm is pinned to its standalone release binary. In a project whose
  `packageManager` or `devEngines` names another version, pnpm switches to it.
- The [launcher](dotfiles) runs this repository's pnpm at its `packageManager`
  pin before the profile's mise config exists.
