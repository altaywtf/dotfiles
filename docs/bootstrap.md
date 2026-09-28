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
# sops has no Ubuntu package; install the release binary on the fixed path the
# sudo askpass helper resolves.
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
```

Skip the Homebrew steps below; `gh auth login` comes after the first apply
installs `gh`. `workstation` profiles are macOS-only; `./dotfiles apply`
refuses them here, so use `developer` or `devbox`.

The `devbox` profiles also expect two host-provided prerequisites, both
probed by `./dotfiles check devbox`:

- Tailscale installed and joined.
- systemd lingering for the user: `sudo loginctl enable-linger <user>`. The
  [maintenance timer](software-updates.md) and the
  [T3 Code service](devbox.md#system-services), on by default for
  `personal-devbox`, stop at logout without it.

Tool pins live in the [mise configuration](mise.md#runtime-pins).
`age` and `sops` stay host packages on both platforms because the
[sudo askpass helper](../identity/sudo-age-askpass.sh) calls them by fixed path.
For per-user SDK setup, follow [Mobile and TV development](mobile-and-tv-development.md).

### macOS

Install Apple Command Line Tools and Homebrew:

```zsh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install the clone tools and prepare the checkout; `gh auth login` follows the
first apply, which installs `gh` through mise:

```zsh
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

`prepare` installs the pinned Node runtime and locked repository dependencies.

### Gitless First Fetch

If Git is unavailable, fetch an archive to inspect and bootstrap:

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

Before applying a `devbox` or personal profile, provision the owner-only
[LLM gateway config](devbox.md#opt-in-coding-llm-gateway); personal profiles
also need the [Hindsight server config](agents.md#hindsight-memory). Setup
preserves saved coding-client logins.

```zsh
profile=workstation # choose your profile
./homebrew/brew-bundle.ts "$profile" # macOS only
mise trust
./dotfiles diff "$profile"
./dotfiles apply "$profile"
./identity/configure-git.ts --profile "$profile"
```

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

On macOS, profile checks require Spotlight indexing to be disabled by default.
If indexing is intentional, omit the `configure-spotlight.ts` setup step and
skip its verification with:

```zsh
DOTFILES_SKIP_SPOTLIGHT_CHECK=1 ./dotfiles check "$profile"
```

For subsequent checks, export `DOTFILES_SKIP_SPOTLIGHT_CHECK=1` in your
machine-local [`~/.config/dotfiles/zshenv.local`](chezmoi.md#local-overrides).
Checks report the policy as skipped and leave indexing unchanged. `apply` does
not configure Spotlight. An explicit
`./bootstrap/darwin/configure-spotlight.ts` still disables indexing and verifies
the result, even with this flag set.

### Workstation Options

- Install licensed Berkeley Mono Variable manually; Ghostty falls back to Menlo.
- On `personal-workstation`, run `./bootstrap/darwin/app-store/personal.ts` to remove
  the unused bundled App Store apps; uninstall may prompt for a password.
- Quit Chrome before running `./bootstrap/darwin/configure-chrome.ts` to apply
  Lens policies and the vertical-tabs setting.
- Quit Helium before running `./bootstrap/darwin/configure-helium.ts` to enable
  vertical tabs in every existing Helium user profile, or seed `Default` before
  first launch. Setup and maintenance never run it; rerun it for new profiles.
  Other preferences, including the sidebar side, stay unchanged. The setting uses
  [Helium's profile layout preference](https://github.com/imputnet/helium/blob/main/patches/helium/ui/layout/core.patch).
  The same step disables the `helium-noise-canvas` and `helium-noise-audio`
  flags in `Local State`. Together they make Stytch device fingerprinting
  return a block verdict, which sends magic-link sign-ins to
  `stytch.com/redirect-error`; each flag alone is not enough. Other flags stay.
- The same script also writes `External Extensions/<id>.json` files so every
  Helium profile installs 1Password. New installs stay disabled until you accept
  Helium's "extension added" prompt; an existing Web Store install stays
  enabled. The files point at Helium's extension proxy because Helium ignores
  the Web Store update URL there. Deleting a file uninstalls that extension
  from every profile.
- For simulators, SDKs, and signing certificates, follow
  [Mobile and TV development](mobile-and-tv-development.md).

### Devbox Options

Follow [Devbox setup](devbox.md) for services and secret consumers. On macOS,
the logged-in owner may apply the optional desktop baseline:

```zsh
./bootstrap/darwin/configure-desktop.ts
./verify/bootstrap.ts --profile devbox --desktop
```

An unattended macOS devbox turns FileVault off and logs its owner in
automatically, so a reboot brings back user services without a local unlock.

### Verify

Run as each intended Unix user:

```zsh
mise run maintenance:check
./dotfiles check "$profile"
mise run audit host
```

For workstations, also run `mise run audit workstation`. For devbox profiles:

```zsh
./verify/darwin/devbox-services.ts # macOS only
mise run audit devbox
```

## Homebrew Updates

Enroll [headless updates](software-updates.md#headless-devbox-updates) for
scheduled execution without a GUI session.

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

| Failure                                                                    | Recovery                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Homebrew packages                                                  | Rerun `brew-bundle.ts` with the selected profile.                                                                                                                                                                                                   |
| Missing `chezmoi` or another mise tool                                     | Rerun `./dotfiles apply`; the first apply borrows the pinned `chezmoi` through `mise x` and `install-runtimes` installs the rest.                                                                                                                   |
| A systemd user service cannot find `codex`, `claude`, or another mise tool | Apply dotfiles to refresh the user manager's `PATH`, then [restart the running T3 service](devbox.md#refresh-a-linux-services-path) and rerun the profile check.                                                                                    |
| Homebrew drift                                                             | Keep intentional machine-specific packages in a [local Brewfile](profiles.md#local-homebrew-additions), then review and run `./homebrew/brew-bundle.ts --cleanup <profile>`. This removes packages outside the selected profile and local Brewfile. |
| Git dubious ownership under `/opt/homebrew`                                | Rerun `configure-git.ts` with the selected profile.                                                                                                                                                                                                 |
| GitHub SSH authentication                                                  | Check the local key and rerun [Git configuration](identities.md#developer-git-and-ssh).                                                                                                                                                             |
| Secret access over SSH                                                     | Check the deployment recipient and encrypted repository policy in [Identity provisioning](identities.md).                                                                                                                                           |
| SSH to a new Mac times out intermittently                                  | Check `pmset -g log` for `Idle Sleep` or `Dark Wake Thermal Emergency`; wake it locally and run `configure-power.ts`.                                                                                                                               |
