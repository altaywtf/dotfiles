# Contributing

## Prepare

Install the [platform prerequisites](docs/bootstrap.md) (`git` and `mise`) and
clone the repo. In each new checkout or worktree, install the verification
tools at the template pins and the repository dependencies, without applying a
profile:

```zsh
mise --no-config use --global $(sed -nE 's/^(chezmoi|shellcheck|actionlint|gitleaks|trufflehog) = "([^"]+)"$/\1@\2/p' chezmoi/.chezmoitemplates/mise.toml)
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
mise trust
```

## Verify

```zsh
pnpm exec vp fmt              # format before committing
pnpm exec vp check
pnpm exec vp test
pnpm exec knip
mise run verify:domain config # one domain from verify/checks.json
mise run verify:fast          # all deterministic checks
mise run verify               # also scans Git history for secrets (needs trufflehog)
```

Focused domain runs skip `scope: "complete"` checks in
[checks.json](verify/checks.json). The optional
[pre-push hook](verify/install-pre-push-hook.ts) rejects whitespace errors and
conflict markers; it runs no tests.

History cannot drop a committed false positive. After review, pin it by commit,
file, line, and detector in
[trufflehog-allowlist.json](audit/secrets/trufflehog-allowlist.json) and tag the
live line `trufflehog:ignore`.

## Deliver

- Use Conventional Commits; update the [owning guide](README.md#guides) when behavior changes.
- PRs need the macOS `verify` job of [verify.yml](.github/workflows/verify.yml).
- Run `mise run verify` locally before a direct push; push CI does not run it.
- A new workflow blocks merges only after you add it to the ruleset.
- Git tags own release versions; keep `package.json` private and unversioned. [.releaserc.json](.releaserc.json) maps commit types to releases.
- PR CI does not run the release job. Prove release-tool compatibility before updating its pins; holds live in [renovate.json](renovate.json).
