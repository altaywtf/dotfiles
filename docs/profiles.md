# User Profiles

A profile configures one Unix user; host permissions provide isolation.
[profiles.json](../chezmoi/.chezmoidata/profiles.json) owns each profile's
capabilities, Homebrew layers, agent selections, and install steps.

## Choose a Profile

| Profile                | Role                                                  |
| ---------------------- | ----------------------------------------------------- |
| `developer`            | Default: runtimes and coding agents for any Unix user |
| `devbox`               | Human-operated SSH coding host                        |
| `workstation`          | Human laptop or desktop (macOS only)                  |
| `personal-devbox`      | Single-owner devbox with personal tools               |
| `personal-workstation` | Workstation with personal apps (macOS only)           |

`node bootstrap/cli.ts --help` covers the stored-profile default and
`--switch-profile`. To add an install step, declare it in the
[profile validator](../profiles/model.ts) and handle it in the
[installer](../bootstrap/install.ts).

## Host and User Boundaries

- An authorized administrator owns host-wide Homebrew, Tailscale, power,
  Spotlight, LaunchDaemon, and systemd lingering changes.
- Each Mac has one Homebrew owner. Profiles manage that owner's package layers
  and leave other users' permissions alone.
- Unattended runtime packages, machine credentials, and Linux host packages
  belong to the hosting configuration.

## Local Homebrew Additions

Machine-specific packages go in an optional, gitignored `Brewfile.local` at the
checkout root, owned by the current user and writable by nobody else. Its Ruby
runs on every bundle, so review it before setup or cleanup.

## Externally Managed Homebrew Capabilities

For packages another trusted installer supplies, create
`~/.config/dotfiles/external-homebrew.plist`. `ExternalHomebrew` in
[external-capabilities.ts](../homebrew/external-capabilities.ts) owns the
schema; the [fixtures](../homebrew/verify/external-homebrew.ts) show examples.
Packages only an outside installer supplies go in the profile's
`externalHomebrew` list, so the bundle never trusts their tap.

Run the [bundle step](bootstrap.md#apply-a-profile) to validate the file. Use
this file instead of Homebrew Bundle skip variables.
