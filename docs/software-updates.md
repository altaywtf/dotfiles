# Software Updates

Topgrade updates installed software and applies the enrolled dotfiles profile.
A launchd agent schedules it on macOS; a systemd user timer does on Linux.
[schedule.ts](../maintenance/schedule.ts) routes the commands below to
the platform implementation.

## Enable And Use

Complete [profile setup](bootstrap.md#apply-a-profile), then run from the
persistent checkout as the logged-in user:

```sh
mise run maintenance:enable
mise run maintenance:status
mise run maintenance:update
```

Use `mise tasks` for the command catalog. Schedules live in the
[macOS agent](../chezmoi/private_Library/LaunchAgents/local.dotfiles.software-update.plist.tmpl)
and [Linux timer](../chezmoi/private_dot_config/systemd/user/dotfiles-software-update.timer).

- Applying dotfiles does not enable updates; enrollment is explicit.
- macOS missed sleep events coalesce on wake; powered-off machines wait until
  startup. Linux catches up after downtime.
- Linux `maintenance:enable` needs the rendered units and systemd lingering
  (`sudo loginctl enable-linger <user>`, an administrator step); without
  lingering the timer stops at logout and `maintenance:status` fails. Console
  output goes to `journalctl --user -u dotfiles-software-update`. The
  [Topgrade config](../chezmoi/private_dot_config/topgrade.toml.tmpl) selects
  update steps; the host owns Linux packages.
- Requests acknowledge launch, not completion. Check status and the log summary.
  Updates have a one-hour execution limit. A timeout captures diagnostics,
  stops the observed update processes, reports exit code `124`, and counts as
  a failure for alerts. The next scheduled run can proceed after cleanup succeeds.
- `maintenance:update` preserves an active run. Separate `topgrade` or `brew`
  processes can overlap it; check for idle before interactive work.
- No sudo credentials or interactive input are supplied. Privileged installers
  may require an operator run. Homebrew is told not to quit running casks;
  vendor installers can still disrupt apps.
- OS installation, reboots, machine provisioning, identity enrollment, and
  remote services remain separate operations.
- Full Xcode follows [the declared pin](../chezmoi/.chezmoidata/xcode.json).
  Install or select it with `mise run xcode:install`; the scheduled updater
  does not. Live bootstrap verification checks the selected release.

## Dotfiles Convergence

- [Convergence](../maintenance/converge.ts) requires a clean default
  branch tracking `origin`, with no local commits or unfinished Git operations.
  Dirty, ahead, detached, or diverged checkouts retain local work, skip
  convergence with a warning, and do not fail the step, so in-progress edits
  send no alert. Nothing reports a checkout that stays held back; push or
  discard local work.
- [Local rule fragments](agents.md#global-rules) that link into another Git
  checkout are fetched, then fast-forwarded only when clean. Local changes,
  another branch, local commits, or an unfinished Git operation keep the
  checkout with a warning and do not fail the step. A fetch or tracking failure
  fails the step after the rest of convergence runs. Rule checkouts advance
  under umask `077`, so files Git rewrites stay owner-only.
- Commit and push source changes first. The job fast-forwards, trusts updated
  mise tasks, installs locked dependencies, and applies the selected profile.
  Runtime versions follow declarations; [gateway client logins](devbox.md#opt-in-coding-llm-gateway)
  are preserved.
- Homebrew updates run as its prefix owner. The [Topgrade template](../chezmoi/private_dot_config/topgrade.toml.tmpl)
  disables Homebrew developer mode before updates so they follow stable tags.
- Concurrent convergence runs serialize through a [checkout lock](../lib/lock.ts).
  Live or ambiguous owners retain the lock.
- Failed steps retry on the next run. Package/configuration changes are not
  rolled back; Topgrade reports independent steps separately.

## Host Hygiene

[Hygiene](../maintenance/hygiene.ts) coordinates scheduled cleanup.
[Repository cleanup](../maintenance/repositories.ts) owns discovery, eligibility,
grace periods, and removal revalidation. Preview before deleting anything:

```sh
mise run maintenance:hygiene
mise run maintenance:clean # apply with the updater idle
```

- Cleanup removes eligible merged worktrees and branches after a grace period,
  plus aged developer caches. It never removes owning clones.
- Dirty, locked, active, or unproven work stays. Missing history or failed
  inspection retains candidates; resolve the reported cause before retrying.
  A lagging local default branch can require a pull before removal.
- Read-only activity may leave no timestamps: lock active work explicitly or
  exclude the owning clone:

```sh
git worktree lock --reason "active agent task" <path>
git worktree unlock <path> # when finished
git config --local dotfiles.hygiene skip # exclude this owning clone
git config --local --unset dotfiles.hygiene # include it again
```

- The [cache sweep](../maintenance/cache-cleanup.ts) owns cleanup targets
  and age thresholds. It preserves project sources and persistent container
  data; review the preview for the current targets. Shared Homebrew cleanup
  belongs to its prefix owner.
- The sweep permanently deletes aged Codex session history under `CODEX_HOME`
  when set; preview before applying. Codex config, skills, memories, plugins,
  worktrees, and databases are never swept. A pruned session can still be
  listed without opening; remove it with `codex delete`.
- Private state: `~/.local/state/dotfiles/hygiene.json`. A live/ambiguous hygiene
  lock fails for inspection; stale process locks recover automatically.

## Notifications And Logs

```sh
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 20 ~/Library/Logs/dotfiles/software-update-history-*.log
tail -n 100 ~/Library/Logs/dotfiles/hygiene-*.log
```

On Linux the console stream is in the user journal
(`journalctl --user -u dotfiles-software-update`) and the history and hygiene
logs live under `~/.local/state/dotfiles/logs/`.

- macOS GUI failures request native notifications; permissions/Focus can
  suppress them. Success stays silent. Headless jobs use logs and optional
  failure emails.
- JSON history records start/finish, exit code, and alert outcome. Applied
  hygiene logs removals/retentions and cache output; previews/skips do not append.
- Each update archives the previous output; [log policy](../maintenance/logs.ts)
  owns retention and size limits.
  History counts are retained totals, not lifetime totals.
- Private receipts live at `~/.local/state/dotfiles/updates/<job>.json`.
  Compare `running` receipts with the scheduler; they do not prove process
  liveness. An update starts only after its initial receipt is saved. History
  logging remains best-effort; missing executables remain retryable after repair.
- The latest timeout report lives at
  `~/.local/state/dotfiles/updates/diagnostics/software-update-timeout.json`.
- On macOS, `maintenance:status` inspects the GUI updater or, when absent, the
  system updater under the stored host namespace. It reports the selected domain
  and compares that job’s plist and the user’s receipt without changing enrollment.
  It warns about plist drift and stale receipts.
  Notifications alone cannot detect a scheduler that never starts.

For always-on hosts, provision an owner-only regular file at
`~/.config/dotfiles/update-alerts.json` through the host's secret owner:

```json
{
  "endpoint": "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/email/sending/send",
  "token": "EMAIL_SENDING_API_TOKEN",
  "from": "alerts@example.test",
  "to": "admin@example.test"
}
```

- [Alert delivery](../maintenance/run.ts) posts one email to the
  [Cloudflare Email Sending API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
  when a run fails after a success, and one when a run succeeds after a
  notified failure. Consecutive failures and ordinary successes send nothing.
  Any nonzero exit counts as failure, including timeout (`124`), a blocked
  start (`125`), and a missing executable (`127`).
- Each send is one HTTPS request bounded to ten seconds, without redirects or
  retries. It counts as sent only when the API acknowledges the recipient.
  An unconfirmed transition stays pending, so the next scheduled run sends it;
  a timed-out request the API had accepted can therefore arrive twice.
- Delivery failure is logged without rerunning updates or changing their exit
  code. The token never reaches logs, receipts, or history.
- Notified state lives at `~/.local/state/dotfiles/updates/software-update-alert.json`.
  Missing config disables alerts; invalid config records failure but updates run.
- Alerts only report runs that finish. A scheduler that never starts, a
  sleeping laptop, or a powered-off host sends nothing; check
  `maintenance:status` for freshness.
- Interactive zsh warns when the receipt is older than 13 hours, which catches
  a job that fails before its wrapper runs, such as one still loaded from a
  moved checkout. `maintenance:disable` silences it until `maintenance:enable`.

## Disable, Reload, And Recover

```sh
mise run maintenance:status
mise run maintenance:disable
```

- macOS: wait for idle, disable, apply dotfiles, then enable to reload changed
  plists. Re-enabling an already loaded job does not reload it. Script-only
  changes need no launchd reload.
- Linux: `./dotfiles apply` runs `systemctl --user daemon-reload`, so changed
  units take effect without re-enrolling.
- Disabling stops the job and children. An interrupted run leaves its receipt
  at `cleanupComplete: false`; inspect logs, package state, and remaining
  processes before retrying. Never delete Homebrew locks during another package run.
- Deadline cleanup stops same-user descendants, escalating from TERM to KILL.
  A process that detaches and loses its parent before observation can escape it.
- Later runs refuse to start and report exit code `125` until the incomplete or
  unreadable receipt is removed, or when they cannot save their own gate receipt.
  Remove `~/.local/state/dotfiles/updates/software-update.json` only after
  verifying the previous update and its descendants have stopped. This bounds a
  stuck updater; it does not repair the underlying failure.

## Headless Devbox Updates

On Linux, `mise run maintenance:enable` plus lingering is the whole
enrollment; the user timer then runs without a login. On a Mac, prepare
the owner's persistent checkout and apply its devbox profile. As admin:

```sh
sudo node bootstrap/darwin/install-devbox-service-daemons.ts \
  --user example --software-updates \
  --updates-repository /Users/example/projects/dotfiles
```

- The selected user must own the Homebrew prefix and checkout/profile. The
  system software updater includes packages and tools in one result. Add
  `--check` for read-only validation.
- Disable the user's GUI updater before enrollment. System and GUI enrollment
  reject duplicates. [Devbox scheduling](../maintenance/darwin/devbox.ts)
  owns the schedule.
- `mise run maintenance:disable` fails while the system updater is loaded;
  only an administrator can stop it.
- `mise run maintenance:update` falls back to the system updater when no GUI
  job is loaded. Starting it needs root: owners with a
  [devbox sudo](devbox.md#sudo-without-a-plaintext-password-file) config use
  that helper unattended; others get a sudo prompt on a terminal, or a failure
  naming the command below. `kickstart` without `-k` preserves active runs:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
```

To reload, wait for idle, then disable/bootout each affected label and re-enroll:

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

- Disabled jobs stay disabled across boots; bootout stops active work.
- Returning to GUI updates also requires removing the system plist before
  `maintenance:enable`. See [devbox administration](devbox.md).

## Check Available Updates

- `maintenance:check` refreshes Homebrew metadata and reports macOS baselines,
  cached applicability, live-scan decisions, and incomplete/timed-out probes.
  On Linux it has no Homebrew or OS probes; the mise, npm, and coding-agent
  inventories remain.
- Coding-agent version probes include the user's managed `~/.local/bin` wrappers
  and mise shims even in noninteractive SSH sessions.
- Homebrew cask receipts are compared with installed bundle versions from
  `brew info --json=v2`. Exact target matches appear under `record_lag` and do
  not count toward the backlog. Mismatches remain pending; missing app versions
  or failed inspection remain `unknown` and count toward the backlog. This
  includes package-based casks without a readable app bundle. Self-update
  metadata alone never establishes currentness.
- [macOS inventory policy](../maintenance/darwin/macos-updates.ts) owns
  cache freshness and live-scan decisions. Stale/unavailable sources remain
  visible; cached applicability is never presented as live. Force a scan with
  `node maintenance/check.ts --fresh`.
- `maintenance:verify` adds bootstrap verification. Live macOS scans have no
  timeout because daemon cancellation is undocumented; inventory never downloads
  or installs OS updates.

## Development Workload Diagnostics

On macOS, run as the development user from the prepared checkout:

```sh
node maintenance/workloads.ts
```

This read-only snapshot of the current user's processes lists candidate test
workers, daemons, and VM helpers for manual inspection. Confirm ownership and
current use before stopping anything. Linux is unsupported.

## CLI Release Policy

The [Renovate rules](../renovate.json) and
[mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) exempt the
same CLI tools from the three-day release-age gate; runtime pins keep it, and a new
tool needs an explicit choice. Required CI still gates merges. `mise latest`
reports a version; it does not advance an exact template pin or install an update.

Renovate advances the plain TOML pins after discovering a release. Once its
change lands, apply it from a clean default-branch checkout:

```sh
node maintenance/converge.ts
mise latest github:anthropics/claude-code
mise exec -- claude --version
```

Convergence fast-forwards the checkout, renders the global mise configuration,
and runs `mise install`. Renovate's cadence and cached release catalogs can
delay discovery. For a fresh diagnostic without changing pins, run
`mise cache clear github:anthropics/claude-code`, then repeat `mise latest`.

### GitHub Authentication

Mise obtains credentials through `gh auth token` for the requested GitHub host,
including credentials stored in the system keyring. The installed launcher uses
`gh` on PATH or resolves an already-installed copy offline when only mise shims
were available. It never installs a credential helper or writes a token to disk.
A fresh host without an authenticated `gh` falls back to unauthenticated public
requests until the operator runs `gh auth login --hostname github.com`.

Check the selected source with `mise token github` (masked output). Explicit
`MISE_GITHUB_TOKEN`, `GITHUB_API_TOKEN`, or `GITHUB_TOKEN` environment variables
take precedence over the credential command. Scheduled runs need access to the
same user's credential store; the launcher cannot unlock a locked keyring.
