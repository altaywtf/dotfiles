# Security Audits

Audits report findings and change nothing. Run host checks as the audited user
after `./dotfiles prepare`. Scopes live in the [`audit` task](../mise.toml) and
[audit/run.ts](../audit/run.ts):

```zsh
mise run audit workstation
mise run audit devbox --format json
```

Scanner output and kept reports are sensitive: some scanners print matched
secrets. Share JSON summaries, not raw output.

## Findings

- [gitleaks-policy.json](../audit/secrets/gitleaks-policy.json) owns rule
  severity. Inspect `generic-api-key` findings before dismissing them; the
  detector often matches shell assignments.
- [.gitleaks.toml](../.gitleaks.toml) allowlists exact synthetic fixture values
  only: no real keys, whole paths, commits, or provider rules.
- A passing devbox audit does not prove privacy for every project descendant.
- Missing or malformed scanner reports, incomplete runs, and exceeded
  deadlines fail the audit whatever the findings.

For a real secret:

1. Rotate or revoke it in the owning system.
2. Remove it from the repository and history when needed.
3. Record detector, affected surface, and rotation outcome without the value.

## Policy

Set accepted GitHub scopes and drift thresholds in
`~/.config/dotfiles/audit.env`, or point `AUDIT_POLICY_FILE` at another file.
Start from the
[policy template](../chezmoi/private_dot_config/private_dotfiles/private_audit.env)
and keep it free of credentials and identity-specific values.

## Deeper Host Checks

```zsh
node audit/host.ts --allow-sudo-prompt
node audit/host.ts --keep-artifacts DIR   # keep Lynis reports; they hold hostnames, paths, and network details
```

The optional mSCP check needs its baseline outside this repository. Replace
`26` with the host's macOS major version:

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

`node audit/repo.ts` runs only the script's `--check`; pass
`--mscp-script PATH` for a custom location and `--allow-sudo-prompt` for
privileged checks. Review exceptions before any remediation.
