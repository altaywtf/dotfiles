# AGENTS.md

Public macOS and Ubuntu bootstrap framework. `CLAUDE.md` links here; keep one
authored agent guide.

## Layout

| Path                             | Responsibility                                |
| -------------------------------- | --------------------------------------------- |
| [dotfiles](dotfiles)             | Pre-Node launcher                             |
| [mise.toml](mise.toml)           | Repository tasks                              |
| [vite.config.ts](vite.config.ts) | Lint, formatting, and test policy             |
| [bootstrap/](bootstrap/)         | Per-user setup orchestration                  |
| [maintenance/](maintenance/)     | Updates, scheduling, and cleanup              |
| [homebrew/](homebrew/)           | Brewfiles, composition, and prefix management |
| [agents/](agents/)               | Harness integration and manifests             |
| [profiles/](profiles/)           | Profile resolution and validation             |
| [identity/](identity/)           | Git, SSH, and age setup                       |
| [audit/](audit/)                 | Security audits                               |
| [verify/](verify/)               | Repository gates and integration fixtures     |
| [lib/](lib/)                     | Infrastructure shared across domains          |
| [chezmoi/](chezmoi/)             | Managed home files in Chezmoi's source layout |
| [docs/](docs/)                   | Operator procedures and rationale             |

Keep implementations, configuration, and unit tests with their domain. Put
platform code under that domain's `darwin/` or `linux/` directory; create
neither until needed. Use `lib/` only for code that several domains share.
Policy and inventories live in code or config; Markdown links to them and
explains manual actions, recovery, and rationale.

[Managed files](bootstrap/managed-files.ts) own backup handling.
[Audit scanning](audit/secrets/), [repository cleanup](maintenance/repositories.ts),
and [external Homebrew capabilities](homebrew/external-capabilities.ts) keep their
policies separate from their callers. [Agent catalogs](agents/skills/catalog.ts)
serve both synchronization and read-only inventory.

## Work

- Identify the affected profile or repository-only tooling, then read its [task guide](README.md#guides).
- Keep repository-local instructions, secrets, and services with their consumer. Linux host packages and provisioning belong to the host.
- Pin binary-release tools in the [mise templates](chezmoi/.chezmoitemplates/mise.toml) and their OS siblings, as plain TOML for Renovate. [Homebrew](homebrew/) owns compiled packages, GUI apps, system services, and tools called by fixed privileged paths.
- Keep the repository standalone; it runs without a companion workspace manager.
- Document manual setup when automation would need opaque app-state edits or machine-specific credential juggling.
- Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow required links. Look up uncovered APIs in `node_modules/effect/src`.
- Write automation in TypeScript/Effect. Bundle installed client adapters so they run without the checkout or its dependencies. Keep shell to the pre-Node launcher and small native exec shims such as sudo askpass and Git signing.
- Import test APIs from `vite-plus/test`. Keep Chezmoi templates in their native syntax.

## Boundaries

- Git holds no secrets, keys, certificates, local config, generated env files, or device keys. Identities and credential references come from the operator.
- Coding-agent auth, approvals, sessions, caches, worktrees, browser profiles, app state, and secret-manager sessions stay out of Git, summaries included.
- Keep service tokens out of shell startup, plists, supervisor configs, and tracked or generated env files. Follow [identity provisioning](docs/identities.md).
- Keep examples public-safe. Installed names and prose are vendor-neutral; owner names appear only in real external coordinates. Private hosts, users, workspaces, repositories, and credential coordinates appear only in personal-layer agent sources that only personal profiles install.

## Verify and Deliver

- Follow [Contributing](CONTRIBUTING.md) for setup, checks, and delivery. Pick focused checks by domain from [checks.json](verify/checks.json); docs-only changes need no live profile checks or audits.
- Run live checks only on the matching host and user. A green push workflow proves release evaluation, not verification.
- A push to `main` rolls out: machines with the [scheduled updater](docs/software-updates.md#dotfiles-convergence) fast-forward a clean checkout and apply their profile, without rollback.
- Use proper-case headings and sentence-case prose.
