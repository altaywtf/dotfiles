# User Profiles

Profiles configure one Unix user; host permissions provide isolation.

## Choose a Profile

| Profile                | Role                                                  |
| ---------------------- | ----------------------------------------------------- |
| `developer`            | Default: runtimes and coding agents for any Unix user |
| `devbox`               | Human-operated SSH coding host                        |
| `workstation`          | Human laptop or desktop                               |
| `personal-devbox`      | Single-owner devbox with personal tools               |
| `personal-workstation` | Workstation with personal apps                        |

- `./dotfiles diff|apply|check` without a profile uses the stored
  `~/.config/dotfiles/profile`, or `developer` on a fresh user. Apply writes
  that marker as `0600`. Commands refuse a marker that is a symlink, owned by
  another user, or group- or world-writable.
- `./dotfiles apply <profile>` refuses a profile other than the stored one.
  Pass `--switch-profile` to change a user's role on purpose.
- `workstation` profiles configure a macOS desktop, so apply refuses them on
  Linux. `developer` and the `devbox` profiles run on both.
- [profiles.json](../chezmoi/.chezmoidata/profiles.json) owns capabilities,
  Homebrew layers, agent selections, and install steps. The referenced
  Brewfiles own macOS packages; [mise templates](../README.md#runtime-pins) own runtime and tool pins.

## Host and User Boundaries

- An authorized administrator owns host-wide Homebrew, Tailscale, power,
  Spotlight, LaunchDaemon, and systemd lingering changes.
- Each Mac has one Homebrew owner. Profiles manage that owner's package layers
  and leave other users' permissions alone.
- Unattended runtime packages, machine credentials, and Linux host packages
  belong to the hosting configuration. Profiles enroll human-operated users and
  manage the files [Chezmoi](../chezmoi/.chezmoiignore.tmpl) selects.
- [Identity provisioning](identities.md) owns authorship, signing, SSH, age, and
  recovery.

## Apply a Profile

Follow [Bootstrap](bootstrap.md#apply-a-profile), including its identity
prerequisites. To add an install step, declare it in the
[profile validator](../profiles/model.ts) and handle it in the
[installer](../bootstrap/install.ts); the validator rejects unknown steps before
any command runs.

## Local Homebrew Additions

Machine-specific packages that no shared profile should carry go in an optional,
gitignored `Brewfile.local` at the checkout root:

- It must be a regular file owned by the current user without group or other
  write access. A symlink, directory, or writable file fails setup and
  verification.
- Its contents are trusted Homebrew Bundle Ruby, evaluated after the profile's
  layers. Review it before running setup or cleanup.
- [homebrew.ts](../homebrew/homebrew.ts) owns inclusion (`withLocalBrewfile`,
  `profileBrewfiles`); `brew-bundle.ts --shared-only` excludes it.

Applications from another installer belong in the external capability file
below.

## Externally Managed Homebrew Capabilities

Profiles can accept packages supplied by another trusted installer:

- Create `~/.config/dotfiles/external-homebrew.plist`: a regular XML plist,
  owned by the user, without group or other write access.
- Its schema is `ExternalHomebrew` in
  [external-capabilities.ts](../homebrew/external-capabilities.ts); the
  [fixtures](../homebrew/verify/external-homebrew.ts) show the `command` and
  `bundle` validators.
- Each entry names a package from the profile's Brewfiles, the local Brewfile,
  or the profile's `externalHomebrew` list in
  [profiles.json](../chezmoi/.chezmoidata/profiles.json). That list covers
  packages only an outside installer supplies, so the bundle never trusts their
  tap.
- Run the [bundle step](bootstrap.md#apply-a-profile) to validate the file.
  Resolve failed probes or permission checks before retrying. Use this file
  instead of ambient Homebrew Bundle skip variables.
