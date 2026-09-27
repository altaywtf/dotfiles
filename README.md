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
| Edit managed files                     | [Chezmoi](docs/chezmoi.md)                                     |
| Change runtime pins or find tasks      | [Mise](docs/mise.md)                                           |
| Audit a repository or host             | [Security audits](docs/security-audits.md)                     |
| Install mobile and TV tooling          | [Mobile and TV development](docs/mobile-and-tv-development.md) |
| Change this repository                 | [Contributing](CONTRIBUTING.md)                                |

[Security reporting](SECURITY.md) · [MIT license](LICENSE)
