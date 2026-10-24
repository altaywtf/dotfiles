# Chezmoi Source State

Edit tracked files under [chezmoi/](../chezmoi/).
[Profile data](../chezmoi/.chezmoidata/profiles.json) selects their targets;
[apply-dotfiles.ts](../bootstrap/apply-dotfiles.ts) handles preview,
backups, and apply. [.chezmoiignore](../chezmoi/.chezmoiignore.tmpl) owns platform
and profile exclusions; [mise](mise.md#runtime-pins) owns runtime pins.

## Workflow

For source-only changes, substitute the intended profile:

```zsh
mise trust
mise run dotfiles:diff workstation
mise run dotfiles:apply workstation
```

- `./dotfiles apply <profile>` also runs the remaining
  [bootstrap steps](bootstrap.md). On Linux it reloads the systemd user
  manager and hands it the shim `PATH` from `environment.d`. The managed
  `99-zz-dotfiles.conf` sorts after the distro import of `/etc/environment`,
  so it prepends user tools to that baseline.
- Preview and apply both refresh [agent rules](agents.md#global-rules).
- The wrapper backs up conflicting files and links before force-applying and
  keeps only the newest backup per target. Generated agent rule files get no
  backup.
- The [Claude settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json)
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

## Local Overrides

| Path                                                  | Use                                                       |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `~/.ssh/config.local`                                 | Host-specific SSH directives                              |
| `~/.ssh/config.d/*.conf`                              | Fragments written by other tools                          |
| `~/.config/dotfiles/zshenv.local`                     | Machine-specific, non-secret shell exports                |
| `~/.config/dotfiles/agents.start.md`, `agents.end.md` | Private agent rules                                       |
| `~/.config/dotfiles/claude-automode.json`             | Private Claude [auto mode](agents.md) rules               |
| `~/.config/dotfiles/codex.rules`                      | Private Codex [command rules](agents.md)                  |
| `~/.config/dotfiles/devbox.env`                       | [Per-user devbox settings](devbox.md#local-configuration) |

- Route tools that write SSH config to their own `config.d` fragment instead
  of `~/.ssh/config`. On macOS, SSH also includes Colima's generated
  `~/.colima/ssh_config`.
- Create `zshenv.local` by hand with mode `0600`. The shell reads it only as a
  readable regular file and ignores symlinks at the file or its `dotfiles`
  directory.
- Apply keeps blocks other tools add to `~/.zshenv` and `~/.zshrc` between
  `# >>> NAME (managed) >>>` and `# <<< NAME (managed) <<<` lines, re-appended
  after the [managed content](../chezmoi/.chezmoitemplates/zsh-managed-blocks).
  It replaces everything else in those files. A start line without its
  matching end fails apply and leaves the file untouched.
- To stop Teleport adding keys to an incompatible SSH agent, export
  `TELEPORT_ADD_KEYS_TO_AGENT=no` in `zshenv.local`.

## Source Boundaries

- Use `private_` for owner-only files and directories.
- `exact_` at home-directory scope deletes unmanaged files. Keep live app and
  auth state out of `chezmoi add`.
- Package lists and runtime installation have their own owners. Add a
  lifecycle script only for an explicit bootstrap requirement.
