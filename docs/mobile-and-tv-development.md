# Mobile and TV Development

Start with [bootstrap](bootstrap.md). The [Homebrew manifests](../homebrew/)
and [mise templates](../chezmoi/.chezmoitemplates/) own the shared toolchain;
projects can override runtime versions.

Simulator runtimes, Android SDK packages, emulator images, and first-run GUI
setup stay manual.

## Xcode and tvOS Simulator

Install and select the [pinned release](../chezmoi/.chezmoidata/xcode.json) as
the Homebrew prefix owner. The scheduled updater never installs Xcode.

```zsh
mise run xcode:install
mise run xcode:check
xcodebuild -downloadPlatform tvOS
xcrun simctl list devicetypes | rg 'Apple TV'
```

- `xcode:install` passes terminal input to `xcodes` for Apple ID login and
  2FA. Run it in an interactive terminal when authentication is needed.
- Over SSH, use `ssh -t` and run `security unlock-keychain` first. `xcodes`
  keeps the Apple ID session in the login keychain; a locked keychain fails
  with `OSStatus error:[-25308]`.
- Selecting the release needs sudo. Devbox hosts with a
  [sudo config](devbox.md#sudo-without-a-plaintext-password-file) use
  `sops-devbox-sudo`; elsewhere the task prints the exact `sudo` command.
- Simulator runtimes are multi-GB downloads. Run the app's build afterward to
  verify its Xcode and runtime combination.

## Android TV

On Linux, install the Android SDK under `~/Android/Sdk` first. Accept
licenses, then choose packages for the app's API level and host architecture.
This example creates an ARM64 Android TV emulator:

```zsh
print -r -- "$ANDROID_HOME"
command -v adb emulator sdkmanager avdmanager
sdkmanager --licenses
sdkmanager 'system-images;android-34;android-tv;arm64-v8a'
avdmanager create avd -n android-tv -k 'system-images;android-34;android-tv;arm64-v8a'
```

The [shell template](../chezmoi/.chezmoitemplates/zshrc) selects `ANDROID_HOME`
from the installed SDK paths. Verify:

```zsh
adb --version
emulator -list-avds
```

For a project that needs another JDK, select it in the project instead of
changing the shared toolchain:

```zsh
mise use java@temurin-17
```

## CocoaPods and Fastlane

Use the app's Ruby environment and `Gemfile`:

```zsh
cd path/to/app
bundle install
cd ios
bundle exec pod install
```

## Tizen

Install the Tizen Studio CLI and back up or restore its signing state with
[taizn](https://github.com/putdotio/taizn) (`taizn sdk install|backup|restore`).
Keep certificates, profiles, archives, and device keys out of Git.
