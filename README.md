# altaywtf/dotfiles

macOS and Ubuntu setup for one Unix user: packages, shell and Git defaults,
runtimes, coding agents, and maintenance. Private identities and secrets stay
outside Git.

## Start

- New machine: follow [Bootstrap](docs/bootstrap.md) with a [profile](docs/profiles.md).
- Configured machine: [update it](docs/bootstrap.md#update-an-existing-machine).

## Guides

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

Edit tracked files under [chezmoi/](chezmoi/), then preview and apply with the
intended profile:

```zsh
mise trust
mise run dotfiles:diff workstation
mise run dotfiles:apply workstation
```

- `./dotfiles apply <profile>` also runs the remaining
  [bootstrap steps](docs/bootstrap.md).
- Apply backs up conflicting files, keeping the newest backup per target.
  Generated agent rule files get no backup.
- Use `private_` for owner-only files. `exact_` at home-directory scope deletes
  unmanaged files; keep live app and auth state out of `chezmoi add`.

To test apply behavior in isolated homes:

```zsh
mise run verify:domain config
mise run verify:domain profiles
node verify/home-fixture.ts   # focused domains skip it
```

### Local Overrides

| Path                                                  | Use                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `~/.ssh/config.local`                                 | Host-specific SSH directives                                   |
| `~/.ssh/config.d/*.conf`                              | Fragments written by other tools                               |
| `~/.config/dotfiles/zshenv.local`                     | Machine-specific, non-secret shell exports                     |
| `~/.config/dotfiles/agents.start.md`, `agents.end.md` | Private agent rules                                            |
| `~/.config/dotfiles/claude-automode.json`             | Private Claude auto mode rules                                 |
| `~/.config/dotfiles/codex.rules`                      | Private Codex command rules                                    |
| `~/.config/dotfiles/devbox.env`                       | [Per-user devbox settings](docs/devbox.md#local-configuration) |

- Point tools that write SSH config at their own `config.d` fragment, not
  `~/.ssh/config`.
- Create `zshenv.local` by hand with mode `0600`. The shell ignores it when it
  or its directory is a symlink.
- Apply replaces `~/.zshenv` and `~/.zshrc` except blocks between
  `# >>> NAME (managed) >>>` and `# <<< NAME (managed) <<<`. A start line
  without its end fails apply and leaves the file untouched.
- To stop Teleport adding keys to an incompatible SSH agent, export
  `TELEPORT_ADD_KEYS_TO_AGENT=no` in `zshenv.local`.

## Mise

[mise.toml](mise.toml) owns repository tasks; keep them as command delegations
to domain code. Trust each checkout first, or task discovery fails:

```zsh
mise trust
mise tasks
```

Live checks inspect the current user's machine; run them only for the
installed profile:

```zsh
mise run verify:bootstrap workstation # the installed profile
mise run verify:devbox-services       # macOS only
mise run bootstrap:trust-agent-worktrees # re-trust existing agent worktrees
```

### Runtime Pins

Edit [the profile template](chezmoi/.chezmoitemplates/mise.toml) or the
[darwin](chezmoi/.chezmoitemplates/darwin/mise.toml) or
[linux](chezmoi/.chezmoitemplates/linux/mise.toml) sibling that owns the pin,
preview with `mise run dotfiles:diff <profile>`, and run `mise run verify`.
[mise-tasks.toml](chezmoi/.chezmoitemplates/mise-tasks.toml) owns packages
installed inside runtimes.

- Keep the templates plain TOML with exact versions so Renovate can parse
  them. [renovate.json](renovate.json) owns holds and pins that move together.
- Package-only pin changes converge through `./dotfiles apply`; a plain
  `mise install` skips the `dotfiles:runtime-packages` task.
- A checkout's `rust-toolchain.toml` overrides the rust pin; a project's
  `packageManager` or `devEngines` overrides the pnpm pin.
