# Bootstrap Guide

Run commands from the repository root as the target Unix user. Choose a
[profile](profiles.md#choose-a-profile) first.

## First-Time Prerequisites

### Linux (Ubuntu)

The host owns root-level packages: `git`, `curl`, `zsh`, `tmux`, `mise` on
the system PATH, and the login shell set to `zsh`. A managed devbox gets those
from its provisioning; elsewhere:

```sh
sudo apt-get install -y git curl zsh tmux lynis age
# sops has no Ubuntu package; install the release binary on a fixed path the
# sudo wrapper resolves.
sops_version=3.13.3
sudo curl -fsSLo /usr/local/bin/sops "https://github.com/getsops/sops/releases/download/v${sops_version}/sops-v${sops_version}.linux.$(dpkg --print-architecture)"
sudo chmod 0755 /usr/local/bin/sops
curl https://mise.run | sh   # installs ~/.local/bin/mise
export PATH="$HOME/.local/bin:$PATH"
sudo chsh -s /usr/bin/zsh "$USER"
mkdir -p ~/projects
git clone https://github.com/altaywtf/dotfiles.git ~/projects/dotfiles
cd ~/projects/dotfiles
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
```

`workstation` profiles are macOS-only; use `developer` or `devbox`.

`devbox` profiles also need two host-provided prerequisites:

- Tailscale installed and joined; `./dotfiles check devbox` probes it.
- systemd lingering for the user: `sudo loginctl enable-linger <user>`.
  Without it the [maintenance timer](software-updates.md) stops at logout, and
  `mise run maintenance:enable` refuses to enable it.

`age` and `sops` come from the host or Homebrew, not mise, because the
[sudo wrapper](../identity/sops-devbox-sudo.ts) calls them by fixed path.
Other tool pins live in the [mise configuration](../README.md#runtime-pins).

### macOS

Install Apple Command Line Tools and Homebrew, then prepare the checkout:

```zsh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git mise
mkdir -p ~/projects
git clone https://github.com/altaywtf/dotfiles.git ~/projects/dotfiles
cd ~/projects/dotfiles
./dotfiles prepare
export PATH="$(mise --no-config where node@"$(cat .node-version)")/bin:$PATH"
```

Run Homebrew commands as the user who owns its prefix.

On a Mac set up over SSH, run the power step from
[Apply a Profile](#apply-a-profile) right after `prepare`. A fresh Mac mini
idle-sleeps; SSH work then runs in DarkWake, macOS forces sleep under load
(`Dark Wake Thermal Emergency` in `pmset -g log`), and connections time out
until someone wakes it locally. Applying `sleep 0` does not wake a sleeping Mac.

### Gitless First Fetch

On a Mac without Git, fetch an archive to inspect and bootstrap:

```zsh
mkdir -p ~/projects
curl -fL https://github.com/altaywtf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/dotfiles-main.zip
ditto -x -k /tmp/dotfiles-main.zip ~/projects
mv ~/projects/dotfiles-main ~/projects/dotfiles
cd ~/projects/dotfiles
```

Install Homebrew and mise, then run `prepare` and the Node `PATH` export above.
Once Git and `gh` work, move the archive aside and clone into a fresh directory
before using Git updates or contribution commands.

## Apply a Profile

```zsh
profile=workstation # choose your profile
./homebrew/brew-bundle.ts "$profile" # macOS only
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./identity/configure-git.ts --profile "$profile"
```

- The first apply installs `gh` through mise; run `gh auth login` after it.
- Configure [Git authorship and local SSH keys](identities.md#developer-git-and-ssh)
  from explicit operator values.
- On macOS, install [the pinned Xcode](mobile-and-tv-development.md) with
  `mise run xcode:install`.
- Provision a [backed-up SOPS age identity](identities.md#sops-age-identity)
  when the profile's `requiresSopsIdentity` capability is set or you consume secrets.
- For machine-specific Homebrew packages, add a gitignored
  [local Brewfile](profiles.md#local-homebrew-additions).
- For externally supplied Homebrew packages or refused tap trust, configure
  [external capabilities](profiles.md#externally-managed-homebrew-capabilities).

Provisioning that applies from a clone and then deletes it sets
`DOTFILES_TEMPORARY_SOURCE=1` for `./dotfiles apply`. The profile then renders
no updater schedule and no Topgrade commands that would point into the deleted
clone; [software updates](software-updates.md) need a persistent checkout. Such
an apply refuses a home whose updater runs from an existing checkout, and warns
about updater units left by an earlier deleted clone.

On macOS, run these host-wide steps once from the administrator account:

```zsh
./bootstrap/darwin/configure-power.ts --profile "$profile"
./bootstrap/darwin/configure-spotlight.ts
```

Power configuration disables sleep while plugged in and leaves battery settings
unchanged. Spotlight configuration disables indexing on mounted volumes without
removing existing index data.

### Spotlight Policy

On macOS, profile checks require Spotlight indexing to be disabled. If indexing
is intentional, skip `configure-spotlight.ts` and its check:

```zsh
DOTFILES_SKIP_SPOTLIGHT_CHECK=1 ./dotfiles check "$profile"
```

To keep skipping it, export the variable in your machine-local
[`~/.config/dotfiles/zshenv.local`](../README.md#local-overrides). `apply` never
configures Spotlight. An explicit `configure-spotlight.ts` run still disables
indexing, even with the variable set.

### Workstation Options

- Install licensed Berkeley Mono Variable manually; Ghostty falls back to Menlo.
- On `personal-workstation`, run `./bootstrap/darwin/app-store/personal.ts` to remove
  the unused bundled App Store apps; uninstall may prompt for a password.
- Quit Chrome, then run `./bootstrap/darwin/configure-chrome.ts` for Lens
  policies, vertical tabs, and toolbar settings. Rerun it after adding a Chrome
  profile; Chrome has no policy for the per-profile settings.
- For simulators, SDKs, and signing certificates, follow
  [Mobile and TV development](mobile-and-tv-development.md).

### Devbox Options

Follow [Devbox setup](devbox.md) for services and secret consumers. On macOS,
the logged-in owner may apply the optional desktop baseline:

```zsh
./bootstrap/darwin/configure-desktop.ts
./verify/bootstrap.ts --profile devbox --desktop
```

For an unattended macOS devbox, turn FileVault off and enable automatic login
for its owner, so a reboot brings back user services without a local unlock.

### Verify

Run as each intended Unix user:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
```

For workstations, also run `mise run audit workstation`. For devbox profiles,
also run [devbox verification](devbox.md#verification).

## Updating an Existing Machine

Refresh the checkout:

```zsh
cd ~/projects/dotfiles
git pull --ff-only
```

Follow [Apply a profile](#apply-a-profile) with the installed role, including
its verification step. Unattended
[convergence](software-updates.md#dotfiles-convergence) uses `./dotfiles maintain`.
For package-only refreshes, use [Software updates](software-updates.md).

## Troubleshooting

| Failure                                                                    | Recovery                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Homebrew packages                                                  | Rerun `brew-bundle.ts` with the selected profile.                                                                                                                                        |
| Missing `chezmoi` or another mise tool                                     | Rerun `./dotfiles apply`; the first apply borrows the pinned `chezmoi` through `mise x` and `install-runtimes` installs the rest.                                                        |
| A systemd user service cannot find `codex`, `claude`, or another mise tool | Apply dotfiles to refresh the user manager's `PATH`, then rerun the profile check.                                                                                                       |
| Homebrew drift                                                             | Keep intentional extras in a [local Brewfile](profiles.md#local-homebrew-additions), then review and run `./homebrew/brew-bundle.ts --cleanup <profile>`, which removes everything else. |
| Git dubious ownership under `/opt/homebrew`                                | Rerun `configure-git.ts` with the selected profile.                                                                                                                                      |
| GitHub SSH authentication                                                  | Check the local key and rerun [Git configuration](identities.md#developer-git-and-ssh).                                                                                                  |
| Secret access over SSH                                                     | Check the deployment recipient and encrypted repository policy in [Identity provisioning](identities.md).                                                                                |
| SSH to a new Mac times out intermittently                                  | Check `pmset -g log` for `Idle Sleep` or `Dark Wake Thermal Emergency`; wake it locally and run `configure-power.ts`.                                                                    |
