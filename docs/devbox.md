# Devbox Setup

Start with [Bootstrap](bootstrap.md) and [Identity provisioning](identities.md).
Isolate each identity in its own Unix user, home, credentials, and service
state.

## Photos Analysis on macOS

Devbox profiles disable `com.apple.photoanalysisd` for the user, and
`./dotfiles check` fails while it is enabled. iCloud Photos syncing is
separate: System Settings → Apple Account → iCloud → Photos. After leaving a
devbox profile, restore analysis if wanted:

```sh
launchctl enable gui/$(id -u)/com.apple.photoanalysisd
```

## Local Configuration

Optional per-user settings live in `~/.config/dotfiles/devbox.env`, mode `0600`:

```sh
DEVBOX_USER=example
```

Human GitHub access uses personal SSH keys. Unattended access uses
repository-scoped GitHub App tokens over HTTPS and a separate commit identity.

## Sudo Without a Plaintext Password File

Store `SUDO_PASSWORD_AGE` in the user's SOPS payload, encrypted to a dedicated
sudo age identity. Add these paths to `devbox.env`:

```sh
SOPS_SUDO_SECRET_FILE="$HOME/projects/example/vault/secrets/identity/user-sudo.sops.json"
SUDO_AGE_IDENTITY_FILE="$HOME/.config/dotfiles/sudo-age-identity.txt"
```

Run a fixed command, or leave the child unprivileged while allowing its own sudo
calls:

```zsh
./identity/sops-devbox-sudo.ts -- /bin/launchctl kickstart -k system/example.service
./identity/sops-devbox-sudo.ts --nested -- /path/to/service-restart.sh
```

A narrow sudoers allowlist stays the authorization boundary.

## System Services

Install system services only when the owner asks. On macOS, install Colima's
boot service from an administrator account:

```zsh
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima --check
```

- Retire competing user LaunchAgents first.
- The service runs the user's own `~/.local/bin/colima-ensure`, which dotfiles
  does not ship. It must exit 0 when `colima status` succeeds and otherwise run
  `colima start` with the host's sizing.

## Updates and Cleanup

- macOS: enroll [headless updates](software-updates.md#headless-devbox-updates)
  as the Homebrew owner.
- Linux: each user enables the [maintenance timer](software-updates.md#enable-and-use).
- Cleanup: [Host hygiene](software-updates.md#host-hygiene).

## Verification

Run as the intended Unix user:

```zsh
./dotfiles check devbox # use personal-devbox for that profile
./verify/darwin/devbox-services.ts # macOS only
mise run audit devbox --format json
```

Audit prose can contain secrets. Report detector, path, and line from the JSON
without copying matched values. For leftover development services, use the
read-only [workload diagnostic](software-updates.md#development-workload-diagnostics).

## Replace a Mac Devbox

Keep the old devbox working until the new one passes every check below.

1. Set the final host name before enrolling anything that records it.
2. Follow [Bootstrap](bootstrap.md) as the new Homebrew owner with the old
   host's profile.
3. Create a new SSH key and [age identity](identities.md#move-or-retire-a-deployment)
   with a verified recovery copy.
4. On the old host, push or archive unpushed branches, stashes, worktrees, and
   ignored work. Clone repositories in full, not blobless: tests that swap
   `HOME` cannot fetch missing blobs over SSH. Sign in to coding agents and
   browsers afresh.
5. Enroll [headless updates](software-updates.md#headless-devbox-updates) and
   any requested [system services](#system-services).
6. Run [verification](#verification), then each moved repository's own gate.

Then retire the old host's services, updater, and age recipient, each with its
own proof.
