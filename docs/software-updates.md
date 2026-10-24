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

Schedules live in the
[macOS agent](../chezmoi/private_Library/LaunchAgents/local.dotfiles.software-update.plist.tmpl)
and [Linux timer](../chezmoi/private_dot_config/systemd/user/dotfiles-software-update.timer).
The [Topgrade config](../chezmoi/private_dot_config/topgrade.toml.tmpl) selects
update steps; the host owns Linux packages.

- Applying dotfiles does not enable updates; enrollment is explicit.
- macOS missed sleep events coalesce on wake; powered-off machines wait until
  startup. Linux catches up after downtime.
- A macOS slot that fires in DarkWake waits for a full wake and gives up
  before the next slot. The Mac is never kept awake for an update.
- Linux enrollment needs systemd lingering, an administrator step:
  `sudo loginctl enable-linger <user>`. Without it the timer stops at logout
  and `maintenance:status` fails.
- `maintenance:update` acknowledges launch, not completion. Check status and
  the log summary.
- Updates have a one-hour limit. A timeout captures diagnostics, stops the
  update processes, and exits `124`.
- `maintenance:update` preserves an active run. Separate `topgrade` or `brew`
  processes can overlap it; check for idle before interactive work.
- Runs get no sudo credentials or interactive input. Privileged installers
  may need an operator run.
- Self-updating casks stay with their vendor updaters, and Homebrew does not
  quit running casks. Vendor installers can still disrupt apps.
- OS installation, reboots, provisioning, identity enrollment, Xcode, and
  remote services stay separate operations. See
  [Xcode](mobile-and-tv-development.md#xcode-and-tvos-simulator).

## Dotfiles Convergence

- [Convergence](../maintenance/converge.ts) requires a clean default branch
  tracking `origin`, with no local commits or unfinished Git operations.
  Dirty, ahead, detached, or diverged checkouts keep local work and skip
  convergence with a warning, so in-progress edits send no alert. Nothing
  reports a checkout that stays held back; push or discard local work.
- [Local rule fragments](agents.md#global-rules) that link into another Git
  checkout fast-forward only when clean; otherwise they stay put with a
  warning. A fetch or tracking failure fails the step after the rest of
  convergence runs. Rule checkouts advance under umask `077`, so rewritten
  files stay owner-only.
- Commit and push source changes first. The job fast-forwards, trusts updated
  mise tasks, installs locked dependencies, and applies the selected profile.
  Coding-client logins are preserved.
- Homebrew updates run as the prefix owner, with developer mode off so they
  follow stable tags.
- Concurrent runs serialize through a [checkout lock](../lib/lock.ts). Live or
  ambiguous owners keep the lock.
- Failed steps retry on the next run. Package and configuration changes are
  not rolled back.

## Host Hygiene

[Hygiene](../maintenance/hygiene.ts) coordinates scheduled cleanup.
[Repository cleanup](../maintenance/repositories.ts) owns discovery,
eligibility, grace periods, and removal revalidation. Preview before deleting
anything:

```sh
mise run maintenance:hygiene
mise run maintenance:clean # apply with the updater idle
```

- Cleanup removes eligible merged worktrees and branches after a grace period.
  It never removes owning clones.
- Dirty, locked, active, or unproven work stays. Missing history or failed
  inspection keeps candidates; resolve the reported cause first. A lagging
  local default branch can need a pull before removal.
- Read-only activity may leave no timestamps. Lock active work explicitly or
  exclude the owning clone:

```sh
git worktree lock --reason "active agent task" <path>
git worktree unlock <path> # when finished
git config --local dotfiles.hygiene skip # exclude this owning clone
git config --local --unset dotfiles.hygiene # include it again
```

The [cache sweep](../maintenance/cache-cleanup.ts) owns targets and age
thresholds; the preview lists them. It preserves project sources and
persistent container data. Its surprises:

- It deletes idle, Git-ignored Cargo `target/` and SwiftPM `.build/` trees in
  agent worktrees and `~/projects`, open pull requests included. The next
  build is cold.
- `mise prune` uninstalls runtime versions no tracked mise config uses. A
  project whose config mise has not seen loses its runtime until the next
  install.
- It permanently deletes aged Codex session history under `CODEX_HOME`. A
  pruned session can still be listed but not opened; remove it with
  `codex delete`.

Hygiene state lives in `~/.local/state/dotfiles/hygiene.json`. A live or
ambiguous hygiene lock fails for inspection; stale locks recover
automatically.

## Notifications And Logs

```sh
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 20 ~/Library/Logs/dotfiles/software-update-history-*.log
tail -n 100 ~/Library/Logs/dotfiles/hygiene-*.log
```

On Linux the console stream is in the user journal
(`journalctl --user -u dotfiles-software-update`). History and hygiene logs
live under `~/.local/state/dotfiles/logs/`.

- macOS GUI failures request native notifications; permissions or Focus can
  suppress them. Success stays silent. Headless jobs use logs and optional
  failure emails.
- [Log policy](../maintenance/logs.ts) owns archiving, retention, and size
  limits.
- Receipts live at `~/.local/state/dotfiles/updates/<job>.json`. A `running`
  receipt does not prove the process is alive; compare it with the scheduler.
- The latest timeout report lives at
  `~/.local/state/dotfiles/updates/diagnostics/software-update-timeout.json`.
- On macOS, `maintenance:status` inspects the GUI updater, or the system
  updater when no GUI job exists. It warns about plist drift and stale
  receipts without changing enrollment.
- Interactive [zsh](../chezmoi/.chezmoitemplates/zshrc) warns about a stale
  receipt. This catches a job that fails before its wrapper runs, such as one
  loaded from a moved checkout. `maintenance:disable` silences it.

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

- [Alert delivery](../maintenance/run.ts) sends one email through the
  [Cloudflare Email Sending API](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
  when a run fails after a success, and one when it recovers. Any nonzero
  exit counts as failure: timeout `124`, blocked start `125`, missing
  executable `127`.
- An unconfirmed send stays pending for the next run, so an email can arrive
  twice. Delivery failure never changes the update's exit code.
- Missing config disables alerts; invalid config logs a failure, and updates
  still run.
- Alerts only report runs that finish. A scheduler that never starts, a
  sleeping laptop, or a powered-off host sends nothing; check
  `maintenance:status` for freshness.

## Disable, Reload, And Recover

```sh
mise run maintenance:status
mise run maintenance:disable
```

- macOS: wait for idle, disable, apply dotfiles, then enable to reload changed
  plists. Re-enabling a loaded job does not reload it. Script-only changes
  need no reload.
- Linux: `./dotfiles apply` reloads changed units without re-enrolling.
- Disabling stops the job and its children. An interrupted run leaves its
  receipt at `cleanupComplete: false`; inspect logs, package state, and
  remaining processes before retrying. Never delete Homebrew locks during
  another package run.
- Deadline cleanup stops same-user descendants. A process that detaches
  before observation can escape it.
- Later runs exit `125` until the incomplete or unreadable receipt is removed.
  Remove `~/.local/state/dotfiles/updates/software-update.json` only after
  verifying the previous update and its descendants have stopped. This unblocks
  the updater; it does not repair the underlying failure.

## Headless Devbox Updates

On Linux, `mise run maintenance:enable` plus lingering is the whole
enrollment. On a Mac, prepare the owner's persistent checkout and apply its
devbox profile. As admin:

```sh
sudo node bootstrap/darwin/install-devbox-service-daemons.ts \
  --user example --software-updates \
  --updates-repository /Users/example/projects/dotfiles
```

- The selected user must own the Homebrew prefix and the checkout. Add
  `--check` for read-only validation.
- Disable the user's GUI updater first; system and GUI enrollment reject
  duplicates. [Devbox scheduling](../maintenance/darwin/devbox.ts) owns the
  schedule.
- `mise run maintenance:disable` fails while the system updater is loaded;
  only an administrator can stop it.
- `mise run maintenance:update` falls back to the system updater when no GUI
  job is loaded. Starting it needs root: owners with a
  [devbox sudo](devbox.md#sudo-without-a-plaintext-password-file) config use
  that helper unattended; others get a sudo prompt or a failure naming the
  command below. `kickstart` without `-k` preserves active runs:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
```

To reload, wait for idle, then disable and boot out each affected label and
re-enroll:

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

- Disabled jobs stay disabled across boots; bootout stops active work.
- Returning to GUI updates also requires removing the system plist before
  `maintenance:enable`. See [devbox administration](devbox.md).

## Check Available Updates

- `maintenance:check` refreshes Homebrew metadata and reports pending updates
  for macOS, Homebrew, mise, npm, and coding agents. Linux has no Homebrew or
  OS probes.
- Template mise pins not yet applied or installed stay pending even when
  `mise outdated` reports nothing.
- A cask whose installed app already matches the target appears under
  `record_lag` and does not count toward the backlog. A cask without a
  readable app version stays `unknown` and counts.
- [macOS inventory policy](../maintenance/darwin/macos-updates.ts) owns cache
  freshness and live-scan decisions. Cached results are never shown as live.
  Force a scan with `node maintenance/check.ts --fresh`.
- `maintenance:verify` adds bootstrap verification. Live macOS scans have no
  timeout, because daemon cancellation is undocumented. Inventory never
  downloads or installs OS updates.

## Development Workload Diagnostics

On macOS, run as the development user from the prepared checkout:

```sh
node maintenance/workloads.ts
```

This read-only snapshot lists candidate test workers, daemons, and VM helpers
for manual inspection. Confirm ownership and current use before stopping
anything. Linux is unsupported.

## CLI Release Policy

The [mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) exempt
selected CLI tools from the three-day release-age gate, and the
[Renovate rules](../renovate.json) exempt their patch and minor updates.
[Runtime pin tests](../verify/runtime-pins.test.ts) keep both lists equal.
Required CI still gates merges.

Renovate advances the plain TOML pins. `mise latest` only reports a version; it
does not advance a pin. Once the pin change lands, apply it from a clean
default-branch checkout:

```sh
node maintenance/converge.ts
mise latest github:anthropics/claude-code
mise exec -- claude --version
```

Renovate's cadence and cached release catalogs can delay discovery. For a
fresh diagnostic without changing pins, run
`mise cache clear github:anthropics/claude-code`, then repeat `mise latest`.

### GitHub Authentication

Mise gets GitHub credentials from `gh auth token`, through the installed
[credential helper](../chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_mise-github-token).
It writes no token to disk. Without an authenticated `gh`, requests fall back
to unauthenticated until the operator runs
`gh auth login --hostname github.com`.

Check the selected source with `mise token github` (masked output).
`MISE_GITHUB_TOKEN`, `GITHUB_API_TOKEN`, or `GITHUB_TOKEN` override the helper.
Scheduled runs need the same user's credential store unlocked; the helper
cannot unlock a keyring.
