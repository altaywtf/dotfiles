# Mobile and TV Development

Start with [bootstrap](bootstrap.md). Simulator runtimes, Android SDK
packages, emulator images, and first-run GUI setup stay manual.

## Xcode and tvOS Simulator

Install the [pinned release](../chezmoi/.chezmoidata/xcode.json) as the
Homebrew prefix owner; the scheduled updater never installs Xcode.

```zsh
mise run xcode:install
mise run xcode:check
xcodebuild -downloadPlatform tvOS
```

- `xcode:install` needs an interactive terminal for Apple ID login and 2FA.
  Over SSH, use `ssh -t` and run `security unlock-keychain` first; a locked
  keychain fails with `OSStatus error:[-25308]`.
- Selecting the release needs sudo: devbox hosts with a
  [sudo config](devbox.md#sudo-without-a-plaintext-password-file) use it,
  others get the exact `sudo` command to run.
- Run the app's build afterward to verify its Xcode and runtime combination.

## Android TV

On Linux, install the Android SDK under `~/Android/Sdk`, where the shell
looks for it. Select another JDK per project (`mise use java@temurin-17`), not
in the shared toolchain. Run CocoaPods and Fastlane through the app's
`Gemfile` with `bundle exec`.

## Tizen

Install the Tizen Studio CLI and back up or restore its signing state with
[taizn](https://github.com/putdotio/taizn) (`taizn sdk install|backup|restore`).
Keep certificates, profiles, archives, and device keys out of Git.
