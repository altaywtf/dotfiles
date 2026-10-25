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

- Without a profile argument, `./dotfiles diff|apply|check` uses the stored
  `~/.config/dotfiles/profile`, or `developer` on a fresh user.
- `./dotfiles apply` refuses a profile other than the stored one. Pass
  `--switch-profile` to change a user's role on purpose.
- To add an install step, declare it in the
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
checkout root. It must be a regular file owned by the current user without
group or other write access. Its Ruby runs after the profile's layers, so
review it before setup or cleanup. `brew-bundle.ts --shared-only` excludes it.

## Externally Managed Homebrew Capabilities

For packages another trusted installer supplies, create
`~/.config/dotfiles/external-homebrew.plist`: a regular XML plist owned by the
user, without group or other write access. `ExternalHomebrew` in
[external-capabilities.ts](../homebrew/external-capabilities.ts) owns the
schema; the [fixtures](../homebrew/verify/external-homebrew.ts) show examples.
Packages only an outside installer supplies go in the profile's
`externalHomebrew` list, so the bundle never trusts their tap.

Run the [bundle step](bootstrap.md#apply-a-profile) to validate the file. Use
this file instead of Homebrew Bundle skip variables.
