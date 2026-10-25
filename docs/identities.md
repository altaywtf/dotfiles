# Identity Provisioning

Provision credentials per Unix user and host. Keep age, SSH, GitHub, and
provider credentials independently replaceable; profiles select software, not
access.

## Developer Git and SSH

Unattended signing needs an owner-only, unencrypted OpenSSH private key. Back
it up outside this repository, then derive its public key:

```zsh
chmod 0600 ~/.ssh/developer_ed25519
ssh-keygen -y -f ~/.ssh/developer_ed25519 > ~/.ssh/developer_ed25519.pub
chmod 0644 ~/.ssh/developer_ed25519.pub
```

Configure authorship and signing with explicit operator values:

```zsh
profile=workstation
GIT_USER_NAME='Developer Name' \
GIT_USER_EMAIL='developer@example.com' \
GIT_SIGNING_KEY="$HOME/.ssh/developer_ed25519" \
GIT_SSH_IDENTITY_FILE="$HOME/.ssh/developer_ed25519" \
  ./identity/configure-git.ts --profile "$profile" --non-interactive
```

- Register public keys with GitHub separately for authentication and signing.
- Move aside conflicting `Host github.com` blocks or an unmanaged
  `~/.ssh/github.config` before setup. Other SSH directives go in
  `~/.ssh/config.local`.
- Inbound SSH needs the administrator's public key in `authorized_keys`, not a
  private key on the target user.

## SOPS Age Identity

The age **identity** is the private key; its **recipient** is the public
address. Once the host supplies `age` and `sops`:

```zsh
./identity/configure-sops-age-identity.ts                    # create and prove a round trip
./identity/configure-sops-age-identity.ts --check            # verify only
./identity/configure-sops-age-identity.ts --print-recipient  # public recipient only
```

Keep the [sudo identity](devbox.md#sudo-without-a-plaintext-password-file)
separate from this one. Before protecting live ciphertext:

1. [Back up and verify recovery](#back-up-and-verify-recovery).
2. Give the encrypted repository owner only the public `age1...` recipient.
3. Add it to that repository's `.sops.yaml` and run `sops updatekeys` on each
   affected file.
4. Prove the deployment can decrypt its authorized payloads.

## Back Up and Verify Recovery

Keep one human-controlled item per deployment or workload. An independent
recovery identity has its own item and stays with humans; unattended
deployments reach neither it nor the recovery system.

### 1Password Item Convention

| Metadata                                                        | Convention                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Deployment title                                                | `identity — <principal>@<host>`; the principal is the Unix user or workload |
| Independent recovery title                                      | `identity — <scope> recovery`                                               |
| `Identity.kind`                                                 | `deployment` or `recovery`                                                  |
| `Identity.principal`                                            | The owning principal, or the recovery scope                                 |
| `Identity.age-recipient`                                        | Public recipient as a text field; label extra recipients by key purpose     |
| `Deployment.host`, `Deployment.unix-user`, `Deployment.profile` | Current deployment metadata, where applicable                               |
| `Lifecycle.status`                                              | `active`, `transitional`, or `retained-recovery`                            |
| Tags                                                            | `identity`, `sops`, and exactly one of `deployment` or `recovery`           |

- Label attachments by purpose: `age-identity`, `sudo-age-identity`,
  `ssh-key`, or the App key. Record filenames, creation dates, public
  fingerprints, and runtime paths.
- Private keys go in file attachments, not notes. Item IDs and private
  recovery references stay out of Git.
- Edit items in place to keep their IDs and consumer references.
- An archived deployment key stays `Identity.kind=deployment` with
  `Lifecycle.status=retained-recovery`.

### Verify Recovery

Backing up deployment attachments needs the owner's authorization and never
grants access to independent recovery keys. Before relying on an identity or
retiring its predecessor:

1. Attach its private identity file to the correct item.
2. Restore the attachment to an owner-only temporary path.
3. Compare `age-keygen -y /path/to/restored-keys.txt` with the intended
   recipient; on the deployment host, `--print-recipient` gives it.
4. In an isolated environment where the attachment is the only key source,
   decrypt an authorized payload without printing it. Repeat without the
   attachment and require failure. `SOPS_AGE_KEY_FILE` alone does not isolate
   the test: [SOPS loads several key sources](https://github.com/getsops/sops/blob/main/age/keysource.go).
5. Verify other attachments against their live source, record the date, and
   remove the restored copies.

## Encrypted Secret Repositories

Each consumer owns its `.sops.yaml`, encrypted payloads, wrappers, and
recipient policy. The optional
[SOPS vault template](https://github.com/uinaf/sops-vault-template) starts a
private vault: replace its example recipients and run its `mise run verify`.

Prefer a separate provider credential per identity. Public recipients,
fingerprints, Git authorship, GitHub App IDs, and ciphertext may be tracked;
private keys, provider tokens, plaintext env files, and recovery-item
references may not.

## Move or Retire a Deployment

Create a new age identity for a new host:

1. Provision it and verify its recovery copy.
2. Add the new recipient to the owning `.sops.yaml`.
3. Run `sops updatekeys --yes path/to/secrets.sops.yaml` for affected files.
4. Prove access to its own payloads and exclusion from sibling identities' files.
5. Remove the old recipient and update the encrypted files again.
6. Rotate the underlying secrets: old Git revisions stay decryptable by the old key.
7. Remove the retired local identity after its consumers have moved.

Moving a retained key instead needs the owner's approval; a host rename does
not revoke a key. Archive or delete an item only after it has no live
consumers and its replacement and recovery work. Keep keys still needed for
historical ciphertext as retained recovery material. Never remove the last copy.
