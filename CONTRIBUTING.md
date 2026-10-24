# Contributing

## Prepare

- Install the [platform prerequisites](docs/bootstrap.md) (`git` and `mise`) and clone the repo.
- In each new checkout or worktree, install the verification tools at the template pins, then install repository dependencies without applying a profile. Only the `verify:history` scan uses `trufflehog`, so CI omits it:

```zsh
mise --no-config use --global $(sed -nE 's/^(chezmoi|shellcheck|actionlint|gitleaks|trufflehog) = "([^"]+)"$/\1@\2/p' chezmoi/.chezmoitemplates/mise.toml)
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
mise trust
```

## Verify

Use the repository-local Vite+ CLI:

```zsh
pnpm exec vp check
pnpm exec vp test
pnpm exec knip
pnpm exec vp fmt # format before committing
```

[vite.config.ts](vite.config.ts) owns formatting, type-aware lint, and tests;
[knip.ts](knip.ts) owns the unused-code check.

The full gate adds platform and isolated-home checks:

```zsh
mise run verify:domain config # choose the affected domain
mise run verify:fast          # all deterministic checks
mise run verify               # also scan Git history for secrets
```

- [checks.json](verify/checks.json) owns domains, commands, and proof; focused
  runs omit `scope: "complete"` checks.
- The optional [pre-push hook](verify/install-pre-push-hook.ts) rejects outgoing commits with whitespace errors or conflict markers, merge diffs included. It runs no tests.

## Deliver

- Use Conventional Commits; update the [owning guide](README.md#guides) when behavior changes.
- PRs run [verification](.github/workflows/verify.yml) on macOS and Ubuntu; only the macOS `verify` job is required.
- Run `mise run verify` locally before a direct push. On push, CI runs only the shared scan, which lints changed workflows, then evaluates a release. GitHub secret scanning and push protection guard pushed secrets.
- GitHub auto-merges eligible Renovate PRs after required CI passes. A new workflow blocks merges only after you add it to the ruleset. Admins keep direct pushes.
- Git tags own release versions; keep `package.json` private and unversioned. [.releaserc.json](.releaserc.json) maps commit types to releases.
- [pnpm-workspace.yaml](pnpm-workspace.yaml) exempts the Effect packages from the minimum release age by bare name, so version bumps touch only `package.json`.
- PR CI does not run the [release job](.github/workflows/verify.yml). Prove release-tool compatibility before updating its pins; holds live in [renovate.json](renovate.json).
