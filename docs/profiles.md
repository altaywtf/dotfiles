# User Profiles

Profiles configure one Unix user; host permissions provide isolation.

## Choose a Profile

| Profile                | Role                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `developer`            | Default: runtimes and coding agents for any Unix user       |
| `devbox`               | Human-operated SSH coding host with gateway routing         |
| `workstation`          | Human laptop or desktop                                     |
| `personal-devbox`      | Single-owner devbox with personal tools and gateway routing |
| `personal-workstation` | Workstation with personal apps and gateway routing          |

- `./dotfiles diff|apply|check` without a profile uses the stored
  `~/.config/dotfiles/profile`, or `developer` on a fresh user. Apply writes
  that marker as `0600` under any umask; commands refuse a marker that is a
  symlink, owned by another user, or group- or world-writable.
- `./dotfiles apply <profile>` refuses a profile other than the stored one;
  pass `--switch-profile` to change a user's role on purpose.
- [profiles.json](../chezmoi/.chezmoidata/profiles.json) owns capabilities,
  Homebrew layers, agent selections, and install steps. The referenced
  Brewfiles own macOS packages; [mise templates](mise.md) own runtime and tool pins.
- `workstation` profiles configure a macOS desktop; `./dotfiles apply` refuses
  them on Linux. `developer` and the `devbox` profiles run on both.

## Host and User Boundaries

- An authorized administrator owns host-wide Homebrew, Tailscale, power,
  Spotlight, LaunchDaemon, and systemd lingering changes.
- Each Mac has one Homebrew owner. Profiles manage that owner's package layers
  directly; they do not repair permissions for other users.
- Use Unix ownership, groups, filesystem permissions, and scoped identities for
  isolation.
- Unattended runtime packages, machine credentials, and Linux host packages
  belong to the hosting configuration. Profiles here enroll human-operated
  users and manage the files selected by [Chezmoi](../chezmoi/.chezmoiignore.tmpl).
- [Identity provisioning](identities.md) owns authorship, signing, SSH, age, and
  recovery. Identity values remain untracked operator input.

## Apply a Profile

Follow [Bootstrap](bootstrap.md#apply-a-profile), including its gateway and
identity prerequisites. Personal apply preserves coding-client logins.
The [profile validator](../profiles/model.ts) rejects unknown installation steps
before setup or maintenance runs any commands. New steps must be declared there
and handled by the [installer](../bootstrap/install.ts).

## Local Homebrew Additions

Machine-specific packages that no shared profile should carry go in an optional
`Brewfile.local` at the checkout root:

- The file is gitignored and belongs to the checkout owner. It must be a regular
  file owned by the current user without group/other write access; a symlink,
  directory, or writable file fails setup and verification.
- Contents are trusted Homebrew Bundle Ruby, evaluated after the selected
  profile's layers. Review the file before running setup or cleanup.
- [Layer composition and cleanup](../homebrew/homebrew.ts) own inclusion rules
  (`withLocalBrewfile`, `profileBrewfiles`); `--shared-only` excludes local additions.

Use it for packages Homebrew installs. Applications supplied by another
installer belong in the external capability file below, which accepts names
declared here.

## Externally Managed Homebrew Capabilities

Profiles can accept packages supplied by another trusted installer:

- Create `~/.config/dotfiles/external-homebrew.plist`: a regular XML plist,
  owned by the user, without group/other write access.
- Follow `ExternalHomebrew`, `CommandCapability`, and `BundleCapability` in
  [external-capabilities.ts](../homebrew/external-capabilities.ts); the
  [fixtures](../homebrew/verify/external-homebrew.ts) show both validation modes.
  Entries must name packages declared by the profile or local Brewfile.
- Run the [bundle step](bootstrap.md#apply-a-profile) to validate the file.
  Resolve failed probes or permission checks before retrying; use this file
  instead of ambient Homebrew Bundle skip variables.

The profile's `externalHomebrew` entries in
[profiles.json](../chezmoi/.chezmoidata/profiles.json) require an authorized
installer outside the bundle. Declare how to validate them in this file;
they do not require trusting the package's tap.
