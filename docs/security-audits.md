# Security Audits

Audits report findings without applying remediation. Prepare tooling with
`./dotfiles prepare`; run host checks as the user being audited.

## Run an Audit

Choose a scope from the [`audit` task](../mise.toml) and its
[scope dispatcher](../audit/run.ts). For example:

```zsh
mise run audit workstation
mise run audit devbox --format json
```

Use `mise run verify` for the repository’s full deterministic checks and
secret scans. Direct audit entrypoints accept `--json`.

Treat scanner output and retained reports as sensitive. Local Gitleaks reports
sanitized locators/counts; other scanners may print matched secrets. Share
JSON summaries, not raw output.

## Interpret Findings

- [Gitleaks policy](../audit/secrets/gitleaks-policy.json) owns rule severity; the
  [finding classifier](../audit/secrets/findings.ts), `summarizeFindings()`, applies it.
  Inspect `generic-api-key` findings before dismissing them: the detector
  frequently matches shell assignments.
- [Gitleaks allowlists](../.gitleaks.toml) may contain exact synthetic fixture
  values only; never real keys, whole paths, commits, or provider rules.
- Live credential stores receive permission/structure checks. For example,
  `~/.npmrc` must be owner-only with registry-scoped auth; the generic scan
  excludes it. Backups remain scan targets.
- Inspect the owning [workstation](../audit/workstation.ts) or
  [devbox](../audit/devbox.ts) policy for individual checks and path coverage.
  A passing devbox audit does not establish privacy for every project descendant.

For a real secret:

1. Rotate or revoke it in the owning system.
2. Remove it from the repository and history when needed.
3. Record detector, affected surface, and rotation outcome without the value.

## Repository and Scope Policy

- [Repository scan selection](../audit/repo.ts) owns local scan scope. In CI,
  the last step of the [`verify` job](../.github/workflows/verify.yml) runs the
  shared push-time scan on each push to `main`; in this public repository it
  lints changed workflows and leaves secrets to GitHub secret scanning and push
  protection.
- In a linked worktree, the TruffleHog filesystem pass scans only tracked and
  unignored files, so dependency trees such as `node_modules` stay out.
  Ignored files are not scanned.
- Edit the installed `~/.config/dotfiles/audit.env` for accepted GitHub scopes
  and drift thresholds; see the [policy template](../chezmoi/private_dot_config/private_dotfiles/private_audit.env)
  and [policy loader](../audit/engine.ts), `loadAuditSettings()`. Keep it public-safe:
  no credentials or identity-specific values. Use `AUDIT_POLICY_FILE=/path/to/file`
  to select an override.

## Deeper Host Checks

```zsh
node audit/host.ts --allow-sudo-prompt
```

- Lynis reports are temporary and deleted after summarizing.
- Use `--keep-artifacts DIR` for manual review only: reports include hostnames,
  paths, packages, and network details.

mSCP is optional and installed outside this repository. Prepare its baseline:

```zsh
mkdir -p ~/projects/security
cd ~/projects/security
git clone https://github.com/usnistgov/macos_security.git
cd macos_security
uv venv --python 3.13
uv pip install --python .venv/bin/python -r requirements.txt
PATH="$PWD/.venv/bin:$PATH" ./mscp.py --os_name macos --os_version 26 baseline -k 800-53r5_moderate
PATH="$PWD/.venv/bin:$PATH" ./mscp.py --os_name macos --os_version 26 guidance \
  custom/baselines/800-53r5_moderate_macos_26.0.yaml --script --no-docs
```

- Replace `26` with the host's macOS major version; return to the dotfiles
  checkout before running its audit commands.
- The audit derives the generated `build/` script path from `sw_vers`.
  Pass `--mscp-script PATH` to [repo.ts](../audit/repo.ts) for a custom path.
- `node audit/repo.ts --allow-sudo-prompt` permits privileged checks.
  The adapter never runs `--fix`; review exceptions before applying remediation.
- References: [Lynis](https://cisofy.com/documentation/lynis/),
  [mSCP](https://pages.nist.gov/macos_security/).

## Scan Completeness

Malformed or missing Gitleaks reports and incomplete scanner execution fail the
audit independently of finding severity. File symlinks participate in discovery;
broken links and nested directory links produce coverage warnings instead of
silently disappearing or expanding the scan through directory cycles.

The [audit runtime](../audit/runtime.ts) bounds execution and captured output;
scanner and compliance adapters select longer deadlines. Exceeding either limit
fails the command. Local TruffleHog output is discarded, with its exit status
supplying the sanitized finding.
