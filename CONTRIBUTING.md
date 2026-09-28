# Contributing

## Prepare

- Install the [platform prerequisites](docs/bootstrap.md) (`git` and `mise`) and clone the repo.
- In a new checkout or worktree, install the verification tools at the template pins and prepare. CI omits `trufflehog`, which only the `verify:history` scan uses:

```zsh
mise --no-config use --global $(sed -nE 's/^(chezmoi|shellcheck|actionlint|gitleaks|trufflehog) = "([^"]+)"$/\1@\2/p' chezmoi/.chezmoitemplates/mise.toml)
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
mise trust
```

`prepare` installs repository dependencies without applying a machine profile.

## Verify

Use the repository-local Vite+ CLI; no global installation is required:

```zsh
pnpm exec vp check
pnpm exec vp test
pnpm exec knip
pnpm exec vp fmt # format before committing
```

[vite.config.ts](vite.config.ts) owns formatting, type-aware lint, and Vitest;
[knip.ts](knip.ts) checks unused files, exports, and dependencies.

The full gate includes Vite+ plus platform and isolated-home checks:

```zsh
mise run verify:domain config # choose the affected domain
mise run verify:fast          # all deterministic checks
mise run verify               # also scan Git history for secrets
```

- [checks.json](verify/checks.json) owns domains, commands, and proof; focused
  runs omit `scope: "complete"` fixtures.
- Run live profile checks and [audits](docs/security-audits.md) only on the intended host and user.
- The optional [pre-push hook](verify/install-pre-push-hook.ts) checks outgoing commits for whitespace and conflict markers, including merge diffs against each parent; it does not run tests.

## Deliver

- Use Conventional Commits; update the [owning guide](README.md#guides) when behavior changes.
- PRs run [verification](.github/workflows/verify.yml) on macOS and Ubuntu. The Ubuntu job also previews the `developer` profile in a fresh home, resolves every Linux mise pin, and checks the rendered systemd units. Only the macOS `verify` job is a required check. Direct pushes require `mise run verify` locally; on push, `verify` only runs the shared secret and workflow scan, and the release job evaluates releases.
- GitHub auto-merges eligible Renovate PRs after required CI passes. Add new mandatory checks to the ruleset; adding a workflow alone does not block merges. Admins retain direct pushes.
- Git tags own release versions; keep `package.json` private and unversioned. Commit rules: [.releaserc.json](.releaserc.json).
- [pnpm-workspace.yaml](pnpm-workspace.yaml) excludes the Effect RC packages from the minimum release age by bare name so version bumps touch only `package.json`.
- PR CI does not exercise the [release job](.github/workflows/verify.yml). Prove release-tool compatibility before updating its pins; holds live in [renovate.json](renovate.json).
