# Devbox Setup

- Start with [Bootstrap](bootstrap.md) and [Identity provisioning](identities.md).
- Isolate each identity in its own Unix user, home, credentials, and service state.

## Photos Analysis on macOS

Dotfiles apply disables `com.apple.photoanalysisd` for the current user on
macOS `devbox` and `personal-devbox` profiles. Existing analysis processes may
remain until logout. Workstation and developer profiles leave the setting alone.

This stops Photos background analysis, not iCloud Photos syncing, and deletes no
photos. Disable syncing separately in System Settings → Apple Account → iCloud
→ Photos → Sync this Mac. Other media and photo-library services remain enabled.

After switching away from a devbox profile, restore analysis explicitly if wanted:

```sh
launchctl enable gui/$(id -u)/com.apple.photoanalysisd
```

## Local Configuration

Optional per-user settings live in `~/.config/dotfiles/devbox.env`, mode `0600`:

```sh
DEVBOX_USER=example
T3_SERVICE=1
```

`T3_SERVICE` overrides the profile's
[T3 Code background service](#system-services) default: `T3_SERVICE=0` opts a
`personal-devbox` user out and removes an installed service on the next apply,
and `T3_SERVICE=1` opts a `devbox` user in.

- Resolve SOPS secrets only in the consuming process. Keep plaintext tokens out
  of shell startup, plists, and supervisor configuration.
- Human GitHub access uses personal SSH keys; unattended access should use
  repository-scoped GitHub App tokens over HTTPS and a separate commit identity.

## Sudo Without a Plaintext Password File

Store `SUDO_PASSWORD_AGE` in the user's SOPS payload. Encrypt that inner value to
a dedicated sudo age identity. Add these paths to the owner-only local config:

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

The password is decrypted in the askpass process. A narrow sudoers allowlist
remains the authorization boundary.

## Opt-In Coding LLM Gateway

Personal profiles require `~/.config/dotfiles/llm-gateway.json`, mode `0600`.
Standard profiles can enroll explicitly. Obtain resolved credentials from the
owning private system. Start with this example and replace the credentials
and URLs:

```json
{
  "version": 3,
  "credentials": {
    "gatewai": "<resolved Gatewai key>"
  },
  "gatewaiBaseUrl": "https://gatewai.example/v1"
}
```

[`GatewayShape` and `parseGatewayConfig`](../agents/gateway/gateway-config.ts)
own optional fields and validation. Enrollment configures Codex and Claude
through Gatewai and preserves unrelated provider settings.

Credentials stay in owner-only configuration or client stores. Enrollment and
maintenance refuse gateway state other than version 9.

```zsh
./bootstrap/configure-llm-gateway.ts
./bootstrap/configure-llm-gateway.ts --check
```

Gateway setup and maintenance preserve existing vendor logins; sign out through
each client's own command when you no longer need one. Grok enrollment backs up
its previous authentication for rollback.

### Client Troubleshooting

- **Codex:** `codex login status` can report `Not logged in` with working
  command-based gateway auth. A live check is
  `echo ok | codex exec --ephemeral --skip-git-repo-check -` (uses provider quota).
  Harnesses using `--ignore-user-config` must launch
  `~/.local/libexec/dotfiles/codex-gatewai` to retain gateway routing.
- **Claude:** enrollment refuses conflicting `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, Bedrock, or Vertex settings. Resolve those deliberately
  before retrying.

### Rollback

```zsh
./bootstrap/configure-llm-gateway.ts --rollback
```

- Restores saved client configuration; removes helpers.
- Restores the saved Grok login when one existed before enrollment.

## System Services

Install system services only when the owner asks; otherwise Colima starts on
demand. On macOS, install Colima's boot service from an authorized administrator
account for the user who owns Colima:

```zsh
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima
sudo ./bootstrap/darwin/install-devbox-service-daemons.ts --user example --colima --check
```

- Retire competing user LaunchAgents before installation.
- The service runs the user's own `~/.local/bin/colima-ensure`; dotfiles does
  not ship it. Make it exit 0 when `colima status` succeeds and otherwise run
  `colima start` with the host's sizing.
- Reference owner-only wrappers or files; never embed secrets.

`personal-devbox` hosts are durable home machines, so `./dotfiles apply`
installs the T3 Code service there by default. `devbox` hosts are scoped,
on-demand boxes and install it only with `T3_SERVICE=1` in
[local configuration](#local-configuration). Workstations run no service; the
T3 desktop app is the server there. Unattended maintenance does not enroll new
services. T3 owns later updates; the
[installation step](../bootstrap/install-t3-service.ts) preserves existing
units unless `T3_SERVICE=0` asks for removal through `t3 service uninstall`. Inspect it with:

```zsh
t3 service status
```

`./dotfiles check` proves the unit exists wherever the service is wanted and
is gone after `T3_SERVICE=0`. On Linux it also checks lingering and the running
service's `PATH`. The systemd user
manager does not read shell startup files; for missing tools, follow
[bootstrap troubleshooting](bootstrap.md#troubleshooting). Enable lingering
as an administrator: `sudo loginctl enable-linger <user>`.

Keep `--base-dir` stable across updates; see the upstream
[background service guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md).

### Refresh a Linux Service's PATH

Applying dotfiles updates the systemd user manager's `PATH`. An already-running
T3 service keeps its old environment until restarted; apply warns about it but
does not restart the service. After that warning, or when the profile check
reports missing mise shims, run these commands as the service's Unix user from
the dotfiles checkout:

```sh
systemctl --user restart t3code.service
systemctl --user is-active t3code.service
./dotfiles check
```

Restarting can interrupt connected T3 sessions; finish active work first.
`daemon-reload` alone does not refresh a running process's environment.

### macOS Service Sessions

On macOS, keep the user logged in and the Mac awake; the LaunchAgent stops at
logout. Installing over SSH for a user with no GUI session writes the
LaunchAgent but cannot start it; the step reports the deferred start and the
service comes up at that user's next login, so a green apply does not by
itself prove the service is running.

## Software Updates and Cleanup

On macOS, enroll [headless updates](software-updates.md#headless-devbox-updates)
as the Homebrew owner to update packages and tools without a GUI login. On Linux, each user
enables the [systemd maintenance timer](software-updates.md#enable-and-use).

Use [Host hygiene](software-updates.md#host-hygiene) to preview cleanup,
protect active work, or apply removals with the updater idle.

## Verification

Run as the intended Unix user:

```zsh
./dotfiles check devbox # use personal-devbox for that profile
./verify/darwin/devbox-services.ts # macOS only
mise run audit devbox --format json
```

Audit prose can contain secrets. Collect JSON and report detector, path, and
line without copying matched values.

On macOS devbox profiles, `./dotfiles check` fails when
[Photos analysis](#photos-analysis-on-macos) is enabled; `./dotfiles apply`
restores the policy.

For suspected leftover development services, use the read-only
[workload diagnostic](software-updates.md#development-workload-diagnostics).

## Replace a Mac Devbox

Enroll the new Mac as a separate deployment. Keep the old devbox working until
the new one passes every check below.

1. Set the final host name before enrolling anything that records it.
2. Follow [Bootstrap](bootstrap.md) as the new Homebrew owner with the old
   host's profile.
3. Create a new SSH key and [age identity](identities.md#move-or-retire-a-deployment)
   with a verified recovery copy. Obtain a separate gateway credential from its
   owner; do not copy the old host's.
4. On the old host, push or deliberately archive unpushed branches, stashes,
   worktrees, and ignored work. Clone repositories on the new host from their
   remotes, including every repository registry the workspace route does not
   cover. Clone in full, not blobless: tests that swap `HOME` cannot fetch missing blobs over
   SSH. Never copy coding-agent logins, sessions, caches, or browser profiles.
5. Enroll [headless updates](software-updates.md#headless-devbox-updates) and
   any requested [system services](#system-services).
6. Run [verification](#verification), then each moved repository's own build
   and test gate on the new host.

Then retire the old host's services, updater, gateway credential, and age
recipient separately, each with its own proof.
