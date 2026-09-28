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
  `99-zz-dotfiles.conf` runs after the distro import of `/etc/environment`,
  preserving its baseline while prepending user tools.
- Both preview and apply refresh [agent rules](agents.md#global-rules).
- The wrapper backs up conflicting files and links before force-applying,
  keeping only the newest backup per target; generated agent rule files get
  none. The Claude settings template returns the file unchanged when every
  managed value already matches, so Claude's own key order is neither
  rewritten nor backed up.

For changes to apply behavior, run the isolated fixtures rather than applying
to your home:

```zsh
mise run verify:domain config
mise run verify:domain profiles
node verify/home-fixture.ts
```

## Local Overrides

| Path                                                  | Use                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.ssh/config.local`                                 | Host-specific SSH directives                                                                 |
| `~/.ssh/config.d/*.conf`                              | Fragments written by other tools                                                             |
| `~/.config/dotfiles/zshenv.local`                     | Machine-specific, non-secret shell exports                                                   |
| `~/.config/dotfiles/agents.start.md`, `agents.end.md` | Private agent rules                                                                          |
| `~/.config/dotfiles/claude-automode.json`             | Private Claude [auto mode](agents.md) rules                                                  |
| `~/.config/dotfiles/devbox.env`                       | [Per-user devbox settings](devbox.md#local-configuration), including the T3 service override |

- SSH includes Colima's generated `~/.colima/ssh_config`. Route writers to
  their own fragments rather than modifying `~/.ssh/config`.
- Create `zshenv.local` manually with mode `0600`. The shell reads it only as
  a readable regular file; symlinks at the file or its `dotfiles` directory
  are ignored. Keep service tokens out of shell startup.
- `TELEPORT_ADD_KEYS_TO_AGENT=no` can prevent Teleport from adding keys to an
  incompatible SSH agent.
- The [Claude settings modifier](../chezmoi/private_dot_claude/modify_private_settings.json)
  changes selected defaults while preserving other fields, including `env`.
  Provider routing belongs to the [gateway configurator](devbox.md#opt-in-coding-llm-gateway).

## Source Boundaries

- Keep private identities, host data, credentials, and local overrides out of Git.
- Use `private_` for owner-only files and directories.
- Do not use `exact_` at home-directory scope or import live app/auth state with
  `chezmoi add`.
- Add lifecycle scripts only when an explicit bootstrap requirement needs them;
  keep package lists and runtime installation in their existing owners.
