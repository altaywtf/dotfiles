# Software Updates

Topgrade updates installed software and applies the enrolled profile, on a
launchd agent (macOS) or systemd user timer (Linux).
[schedule.ts](../maintenance/schedule.ts) routes the commands below;
the [Topgrade config](../chezmoi/private_dot_config/topgrade.toml.tmpl) selects
steps.

## Enable and Use

After [profile setup](bootstrap.md#apply-a-profile), run from the persistent
checkout as the logged-in user:

```sh
mise run maintenance:enable
mise run maintenance:status
mise run maintenance:update   # starts a run; check status and logs for the result
```

- Applying dotfiles never enables updates.
- Linux needs systemd lingering (`sudo loginctl enable-linger <user>`), or the
  timer stops at logout.
- Runs get no sudo or interactive input; privileged installers may need an
  operator run. OS installs, reboots, and [Xcode](mobile-and-tv-development.md)
  stay manual.
- A run stops after one hour and exits `124`.
- Separate `topgrade` or `brew` processes can overlap a run; check for idle
  before interactive package work.

## Dotfiles Convergence

[converge.ts](../maintenance/converge.ts) fast-forwards the checkout, installs
locked dependencies, and applies the profile. Changes are never rolled back;
failed steps retry next run.

- It needs a clean default branch tracking `origin`. Dirty, ahead, detached, or
  diverged checkouts skip with only a warning, so push or discard local work.
- Rule-fragment checkouts ([Global Rules](agents.md#global-rules)) fast-forward
  only when clean.
- Commit and push source changes first.

## Host Hygiene

Preview before deleting anything:

```sh
mise run maintenance:hygiene
mise run maintenance:clean # apply with the updater idle
```

Cleanup removes merged worktrees and branches after a grace period, never
owning clones, and keeps dirty, locked, active, or unproven work. Read-only
activity may leave no timestamps, so lock active work or exclude a clone:

```sh
git worktree lock --reason "active agent task" <path>
git worktree unlock <path> # when finished
git config --local dotfiles.hygiene skip # exclude this owning clone
git config --local --unset dotfiles.hygiene # include it again
```

The [cache sweep](../maintenance/cache-cleanup.ts) also:

- deletes idle, ignored Cargo `target/` and SwiftPM `.build/` trees in agent
  worktrees and `~/projects`, open pull requests included;
- runs `mise prune`, so a project whose config mise has not seen loses its
  runtime until the next install;
- permanently deletes aged Codex session history; remove a listed but
  unopenable session with `codex delete`.

## Logs and Alerts

```sh
tail -n 80 ~/Library/Logs/dotfiles/software-update.log
tail -n 20 ~/Library/Logs/dotfiles/software-update-history-*.log
tail -n 100 ~/Library/Logs/dotfiles/hygiene-*.log
journalctl --user -u dotfiles-software-update   # Linux; other logs in ~/.local/state/dotfiles/logs/
```

- Receipts live at `~/.local/state/dotfiles/updates/<job>.json`. A `running`
  receipt does not prove the process is alive; compare it with the scheduler.
- The latest timeout report is
  `~/.local/state/dotfiles/updates/diagnostics/software-update-timeout.json`.
- macOS GUI failures post a notification; success stays silent.

For failure email on always-on hosts, provision an owner-only
`~/.config/dotfiles/update-alerts.json` through the host's secret owner:

```json
{
  "endpoint": "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/email/sending/send",
  "token": "EMAIL_SENDING_API_TOKEN",
  "from": "alerts@example.test",
  "to": "admin@example.test"
}
```

[run.ts](../maintenance/run.ts) emails once on the first failure and once on
recovery. A scheduler that never starts, or a sleeping or powered-off host,
sends nothing; check `maintenance:status` for freshness.

## Disable, Reload, and Recover

```sh
mise run maintenance:status
mise run maintenance:disable
```

- macOS: to reload changed plists, wait for idle, disable, apply dotfiles, then
  enable. Script-only changes need no reload.
- Linux: `./dotfiles apply` reloads changed units.
- An interrupted run leaves its receipt at `cleanupComplete: false`, and later
  runs exit `125` until it is removed. Inspect logs, package state, and
  leftover processes; once the previous update and its children have stopped,
  remove `~/.local/state/dotfiles/updates/software-update.json`.
- Never delete Homebrew locks during another package run.

## Headless Devbox Updates

On Linux, `maintenance:enable` plus lingering is the whole enrollment. On a
Mac, apply the owner's devbox profile in a persistent checkout, disable the
user's GUI updater, then as admin:

```sh
sudo node bootstrap/darwin/install-devbox-service-daemons.ts \
  --user example --software-updates \
  --updates-repository /Users/example/projects/dotfiles   # add --check to validate
```

- The user must own the Homebrew prefix and the checkout.
- `maintenance:disable` fails while the system updater is loaded; only an
  administrator can stop it.
- `maintenance:update` starts the system updater when no GUI job is loaded,
  through the [devbox sudo](devbox.md#sudo-without-a-plaintext-password-file)
  helper or a sudo prompt. `kickstart` without `-k` preserves active runs:

```sh
launchctl print system/local.dotfiles.software-update.example
sudo launchctl kickstart system/local.dotfiles.software-update.example
```

To reload, wait for idle, then disable and boot out each affected label and
re-enroll. To return to GUI updates, also remove the system plist before
`maintenance:enable`.

```sh
sudo launchctl disable system/local.dotfiles.software-update.example
sudo launchctl bootout system/local.dotfiles.software-update.example
```

## Check Available Updates

```sh
mise run maintenance:check        # pending macOS, Homebrew, mise, npm, and agent updates
node maintenance/check.ts --fresh # force a live macOS scan
mise run maintenance:verify       # adds bootstrap verification
```

Template pins not yet applied stay pending even when `mise outdated` is empty.

## Development Workload Diagnostics

On macOS, as the development user, `node maintenance/workloads.ts` lists
candidate test workers, daemons, and VM helpers read-only. Confirm ownership
and current use before stopping anything.

## CLI Pins

Renovate advances the plain TOML pins; `mise latest` only reports. The
[mise settings](../chezmoi/private_dot_config/mise/config.toml.tmpl) and
[renovate.json](../renovate.json) exempt the same CLI tools from release-age
gates; [runtime-pins.test.ts](../verify/runtime-pins.test.ts) keeps them equal.
Once a pin change lands, apply it from a clean default-branch checkout:

```sh
node maintenance/converge.ts
mise exec -- claude --version
```

For a fresh lookup without changing pins:
`mise cache clear github:anthropics/claude-code && mise latest github:anthropics/claude-code`.

### GitHub Authentication

Mise reads GitHub credentials from `gh auth token` through the
[credential helper](../chezmoi/private_dot_local/private_libexec/private_dotfiles/private_executable_mise-github-token).
Without an authenticated `gh`, run `gh auth login --hostname github.com`.
`mise token github` shows the selected source, masked. `MISE_GITHUB_TOKEN`,
`GITHUB_API_TOKEN`, or `GITHUB_TOKEN` override the helper. Scheduled runs need
the user's credential store unlocked.
