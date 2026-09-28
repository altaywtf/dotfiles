# Identity Provisioning

Provision credentials per Unix user and host. Keep age, SSH, GitHub, and provider
credentials independently replaceable; profiles select software, not access.

Configure explicit Git authorship and local SSH signing. The
[profile model](../chezmoi/.chezmoidata/profiles.json) declares
`capabilities.requiresSopsIdentity`; other profiles need an age identity when
they consume encrypted secrets.

## Developer Git and SSH

Provide an owner-only, unencrypted local SSH private key for unattended signing.
Export recovery keys in OpenSSH format without a passphrase and save them
outside this repository:

```zsh
chmod 0600 ~/.ssh/developer_ed25519
ssh-keygen -y -f ~/.ssh/developer_ed25519 > ~/.ssh/developer_ed25519.pub
chmod 0644 ~/.ssh/developer_ed25519.pub
```

Use explicit operator values:

```zsh
profile=workstation
GIT_USER_NAME='Developer Name' \
GIT_USER_EMAIL='developer@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/developer_ed25519" \
GIT_SSH_IDENTITY_FILE="$HOME/.ssh/developer_ed25519" \
  ./identity/configure-git.ts --profile "$profile" --non-interactive
```

- Authentication may use a different key through `GIT_SSH_IDENTITY_FILE`.
- Register public keys with GitHub separately for authentication and signing.
- Authorship and signing go in `~/.gitconfig.local`; the managed GitHub SSH block
  goes in `~/.ssh/github.config` and disables ambient agent identities.
- Keep unrelated SSH directives in `~/.ssh/config.local`. Move aside conflicting
  `Host github.com` blocks or an unmanaged `~/.ssh/github.config` before setup.
- Inbound SSH needs the administrator's public key in `authorized_keys`, not a
  private key on the target user.

## SOPS Age Identity

An age **identity** is the private decryption key; its public address is the
**recipient**. After the host supplies `age` and `sops` (Homebrew on macOS,
[host packages](bootstrap.md#linux-ubuntu) on Linux):

```zsh
./identity/configure-sops-age-identity.ts
./identity/configure-sops-age-identity.ts --check
./identity/configure-sops-age-identity.ts --print-recipient
```

Provisioning creates a missing key and proves a SOPS round trip. `--check`
verifies without changing the identity; `--print-recipient` prints only the
public recipient.

The [identity helper](../identity/configure-sops-age-identity.ts) owns
`identityPath()` and `validateIdentity()`: platform paths,
`XDG_CONFIG_HOME`/`SOPS_AGE_KEY_FILE` overrides, and ownership requirements.
Keep the [sudo identity](devbox.md#sudo-without-a-plaintext-password-file)
separate from this general identity.

Before protecting live ciphertext:

1. [Back up and verify recovery](#back-up-and-verify-recovery).
2. Give the encrypted repository owner only the public `age1...` recipient.
3. Add it to that repository's `.sops.yaml` and run `sops updatekeys` on each
   affected encrypted file.
4. Prove the deployment can decrypt its authorized payloads.

Git access permits fetching ciphertext; the recipient policy permits decryption.

## Back Up and Verify Recovery

Keep one human-controlled item per deployment or workload, with separately
labeled key attachments. An independent recovery identity has its own item and
must not be installed on an unattended deployment. Unattended workloads must
not access the recovery system.

### 1Password Item Convention

For 1Password, use this convention; other recovery systems should preserve the
same distinction and verification evidence:

| Metadata                                                        | Convention                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Deployment title                                                | `identity — <principal>@<host>`, where the principal is the Unix user or workload                       |
| Independent recovery title                                      | `identity — <scope> recovery`                                                                           |
| `Identity.kind`                                                 | `deployment` or `recovery`                                                                              |
| `Identity.principal`                                            | The owning principal; use the recovery scope for an independent recovery identity                       |
| `Identity.age-recipient`                                        | Public age recipient as a text field, not a concealed field; label additional recipients by key purpose |
| `Deployment.host`, `Deployment.unix-user`, `Deployment.profile` | Current deployment metadata, where applicable                                                           |
| `Lifecycle.status`                                              | `active`, `transitional`, or `retained-recovery` when lifecycle tracking is needed                      |
| Tags                                                            | `identity`, `sops`, and exactly one of `deployment` or `recovery`                                       |

Label attachments by purpose: `age-identity`, `sudo-age-identity`, `ssh-key`,
or the applicable App key. Keep filenames, creation dates, public fingerprints
and runtime paths clear; preserve additional account recovery artifacts.
A workload item that groups deployments must label each attachment's deployment
and recipient separately. Grouping does not grant shared access.

Edit existing items in place to preserve their stable IDs and consumer
references. Keep item IDs and private recovery references out of Git. Private
keys belong in file attachments, not notes; public recipients remain readable
metadata. An archived deployment key remains `Identity.kind=deployment` with
`Lifecycle.status=retained-recovery`; retaining it does not make it an
independent recovery identity.

### Verify Recovery

An interactive operator may back up and restore deployment attachments with
the owner's authorization. This does not authorize access to independent human
recovery keys or grant unattended workloads access to the recovery system.

Before relying on an identity or retiring its predecessor:

1. Attach its private identity file to the correct item.
2. Restore the saved attachment to an owner-only temporary path.
3. Run `age-keygen -y /path/to/restored-keys.txt` and compare its public recipient
   with the intended deployment or recovery recipient. For a deployment, use
   `./identity/configure-sops-age-identity.ts --print-recipient` on that host.
4. Prove the restored key decrypts an authorized payload without printing its
   contents, in an isolated environment where that attachment is the only
   decryption source. Repeat the same probe without the attachment and require
   failure. [SOPS loads multiple key sources](https://github.com/getsops/sops/blob/main/age/keysource.go);
   setting `SOPS_AGE_KEY_FILE` alone does not isolate the test.
5. Verify other attachments against their live source or public identity;
   record the verification date and remove restored temporary copies.

Matching an item's public metadata alone does not prove recovery. Keep private
keys, tokens and decrypted files out of Git, logs, shell history, chat, and
issue or pull-request bodies.

## Encrypted Secret Repositories

Each consumer owns its `.sops.yaml`, encrypted payloads, wrappers, and recipient
policy. Dotfiles supplies tools and local identity verification. The optional
[SOPS vault template](https://github.com/uinaf/sops-vault-template) is a starting
point for a private vault: replace its example recipients and run its
`mise run verify` before use.

Prefer a separate provider credential per identity. Shared credentials need an
explicit recipient set and human recovery recipient. Public recipients,
fingerprints, Git authorship, GitHub App IDs, and ciphertext may be tracked;
private keys, provider tokens, plaintext env files, and private recovery-item
references may not.

## Move or Retire a Deployment

By default, create a new age identity for a new host:

1. Provision and verify its recovery copy.
2. Add the new recipient to the owning `.sops.yaml`.
3. Run `sops updatekeys --yes path/to/secrets.sops.yaml` for affected files.
4. Prove access to its own payloads and exclusion from sibling identities' files.
5. Remove the old recipient and update the encrypted files again.
6. Rotate underlying secrets: old Git revisions remain decryptable by the old key.
7. Remove the retired local identity only after its consumers have moved.

An owner may explicitly approve moving a retained key instead. Verify the
actual destination's public recipient and payload access, test the saved
recovery attachment independently, and update deployment metadata and consumer
references. A host-name change does not revoke a key; copies on the old and new
hosts retain the same decryption authority. When the recipient is unchanged,
metadata correction alone needs no `sops updatekeys` or ciphertext rewrap.

Archive or delete an item only after proving it has no live consumers and its
replacement and independent recovery work. Preserve any keys still needed to
decrypt historical ciphertext: re-encrypting current files does not change old
Git revisions. Keep required historical keys as labeled retained recovery
material before deleting an obsolete item; do not remove the last copy.
