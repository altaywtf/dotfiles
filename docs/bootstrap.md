# Bootstrap Guide

Run commands from the repository root as the target Unix user. Choose a
[profile](profiles.md) first.

## First-Time Prerequisites

### Linux (Ubuntu)

The host owns root-level packages: `git`, `curl`, `zsh`, `tmux`, `mise` on
the system PATH, and `zsh` as login shell. A managed devbox gets them from its
provisioning; elsewhere:

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

- `workstation` profiles are macOS-only; use `developer` or `devbox`.
- `age` and `sops` come from the host or Homebrew, never mise: the
  [sudo wrapper](../identity/sops-devbox-sudo.ts) calls them by fixed path.
- `devbox` profiles also need Tailscale installed and joined, and systemd
  lingering: `sudo loginctl enable-linger <user>`. Without lingering the
  [maintenance timer](software-updates.md) stops at logout.

### macOS

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

- Run Homebrew commands as the user who owns its prefix.
- On a Mac set up over SSH, run `configure-power.ts` from
  [Apply a Profile](#apply-a-profile) right after `prepare`. A fresh Mac mini
  idle-sleeps, and SSH sessions then time out until someone wakes it locally.

Without Git, fetch an archive instead of cloning:

```zsh
mkdir -p ~/projects
curl -fL https://github.com/altaywtf/dotfiles/archive/refs/heads/main.zip \
  -o /tmp/dotfiles-main.zip
ditto -x -k /tmp/dotfiles-main.zip ~/projects
mv ~/projects/dotfiles-main ~/projects/dotfiles
```

Once Git and `gh` work, move the archive aside and clone fresh before any Git
update or contribution.

## Apply a Profile

```zsh
profile=workstation # choose your profile
./homebrew/brew-bundle.ts "$profile" # macOS only
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./identity/configure-git.ts --profile "$profile"
gh auth login
```

- Configure [Git authorship and SSH keys](identities.md#developer-git-and-ssh).
- On macOS, install [the pinned Xcode](mobile-and-tv-development.md) with
  `mise run xcode:install`.
- Provision a [SOPS age identity](identities.md#sops-age-identity) when the
  profile sets `requiresSopsIdentity` or you consume secrets.
- Extra Homebrew packages go in a
  [local Brewfile](profiles.md#local-homebrew-additions) or
  [external capabilities](profiles.md#externally-managed-homebrew-capabilities).
- Provisioning that applies from a clone and then deletes it sets
  `DOTFILES_TEMPORARY_SOURCE=1` for `./dotfiles apply`; the profile then
  renders no updater.

On macOS, run these host-wide steps once from the administrator account:

```zsh
./bootstrap/darwin/configure-power.ts --profile "$profile"   # no sleep on power
./bootstrap/darwin/configure-spotlight.ts                    # no indexing
```

Profile checks fail while Spotlight indexes. To keep indexing, skip
`configure-spotlight.ts` and export `DOTFILES_SKIP_SPOTLIGHT_CHECK=1` in
[`zshenv.local`](../README.md#local-overrides).

### Workstation Options

- Install licensed Berkeley Mono Variable manually; Ghostty falls back to Menlo.
- On `personal-workstation`, `./bootstrap/darwin/app-store/personal.ts`
  removes unused bundled App Store apps; it may prompt for a password.
- Quit Chrome, then run `./bootstrap/darwin/configure-chrome.ts`. Rerun it
  after adding a Chrome profile.

### Devbox Options

Follow [Devbox setup](devbox.md). On macOS, the logged-in owner may apply the
optional desktop baseline:

```zsh
./bootstrap/darwin/configure-desktop.ts
./verify/bootstrap.ts --profile devbox --desktop
```

For an unattended macOS devbox, turn FileVault off and enable automatic login
for its owner, so a reboot restores user services without a local unlock.

### Verify

Run as each intended Unix user:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
mise run audit workstation   # workstations
```

Devbox profiles also run [devbox verification](devbox.md#verification).

## Update an Existing Machine

```zsh
cd ~/projects/dotfiles
git pull --ff-only
```

Then follow [Apply a Profile](#apply-a-profile) with the installed profile.
For package-only refreshes, use [Software updates](software-updates.md).

## Troubleshooting

| Failure                                                                    | Recovery                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A systemd user service cannot find `codex`, `claude`, or another mise tool | Apply dotfiles to refresh the user manager's `PATH`, then rerun the profile check.                                                                                                       |
| Homebrew drift                                                             | Keep intentional extras in a [local Brewfile](profiles.md#local-homebrew-additions), then review and run `./homebrew/brew-bundle.ts --cleanup <profile>`, which removes everything else. |
| Git dubious ownership under `/opt/homebrew`                                | Rerun `configure-git.ts` with the selected profile.                                                                                                                                      |
| GitHub SSH authentication                                                  | Check the local key and rerun [Git configuration](identities.md#developer-git-and-ssh).                                                                                                  |
| Secret access over SSH                                                     | Check the deployment recipient and encrypted repository policy in [Identity provisioning](identities.md).                                                                                |
| SSH to a new Mac times out intermittently                                  | Check `pmset -g log` for `Idle Sleep` or `Dark Wake Thermal Emergency`; wake it locally and run `configure-power.ts`.                                                                    |
