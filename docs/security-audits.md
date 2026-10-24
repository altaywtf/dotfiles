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

Use `mise run verify` for the repository's full deterministic checks and
secret scans. Direct audit entrypoints accept `--json`.

Treat scanner output and retained reports as sensitive. Local Gitleaks reports
sanitized locators and counts; other scanners may print matched secrets. Share
JSON summaries, not raw output.

## Interpret Findings

- [Gitleaks policy](../audit/secrets/gitleaks-policy.json) owns rule severity;
  `summarizeFindings()` in the [finding classifier](../audit/secrets/findings.ts)
  applies it. Inspect `generic-api-key` findings before dismissing them: the
  detector often matches shell assignments.
- [Gitleaks allowlists](../.gitleaks.toml) hold exact synthetic fixture values
  only: no real keys, whole paths, commits, or provider rules.
- Live credential stores get permission and structure checks instead of the
  generic scan. For example, `~/.npmrc` must be owner-only with
  registry-scoped auth. Backups stay scan targets.
- The [workstation](../audit/workstation.ts) and [devbox](../audit/devbox.ts)
  policies own individual checks and path coverage. A passing devbox audit
  does not prove privacy for every project descendant.

For a real secret:

1. Rotate or revoke it in the owning system.
2. Remove it from the repository and history when needed.
3. Record detector, affected surface, and rotation outcome without the value.

## Repository and Scope Policy

- [Repository scan selection](../audit/repo.ts) owns local scan scope;
  [Contributing](../CONTRIBUTING.md#deliver) covers what CI scans.
- In a linked worktree, the TruffleHog filesystem pass scans only tracked and
  unignored files, so ignored trees such as `node_modules` stay out.
- Set accepted GitHub scopes and drift thresholds in the installed
  `~/.config/dotfiles/audit.env`, or select another file with
  `AUDIT_POLICY_FILE=/path/to/file`. See the
  [policy template](../chezmoi/private_dot_config/private_dotfiles/private_audit.env)
  and `loadAuditSettings()` in the [policy loader](../audit/engine.ts). Keep it
  public-safe: no credentials or identity-specific values.

## Deeper Host Checks

```zsh
node audit/host.ts --allow-sudo-prompt
```

Lynis reports are deleted after summarizing. `--keep-artifacts DIR` keeps them
for manual review; they include hostnames, paths, packages, and network
details.

mSCP is optional and lives outside this repository. Prepare its baseline:

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

- Replace `26` with the host's macOS major version. Return to the dotfiles
  checkout before running its audit commands.
- [repo.ts](../audit/repo.ts) derives the generated `build/` script path from
  `sw_vers`. Pass `--mscp-script PATH` for a custom path, and
  `--allow-sudo-prompt` for privileged checks.
- The adapter only runs the script's `--check`; review exceptions before any
  remediation.
- References: [Lynis](https://cisofy.com/documentation/lynis/),
  [mSCP](https://pages.nist.gov/macos_security/).

## Scan Completeness

Malformed or missing Gitleaks reports and incomplete scanner runs fail the
audit regardless of finding severity. File symlinks take part in discovery;
broken links and nested directory links produce coverage warnings instead of
vanishing or looping.

The [audit runtime](../audit/runtime.ts) and scanner adapters own deadlines
and output limits; exceeding either fails the command. Local TruffleHog output
is discarded, and its exit status supplies the sanitized finding.
