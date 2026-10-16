# Mobile and TV Development

Start with [bootstrap](bootstrap.md). The [Homebrew manifests](../homebrew/)
and [mise templates](../chezmoi/.chezmoitemplates/) own the shared toolchain;
projects can override runtime versions.

Simulator runtimes, Android SDK packages, emulator images, and first-run GUI
setup stay manual.

## Xcode and tvOS Simulator

Install and select the [pinned release](../chezmoi/.chezmoidata/xcode.json) as
the Homebrew prefix owner. Xcode downloads are on demand; the scheduled
updater does not download Xcode.

```zsh
mise run xcode:install
mise run xcode:check
xcodebuild -downloadPlatform tvOS
xcrun simctl list devicetypes | rg 'Apple TV'
```

The install task passes terminal input to `xcodes` for its Apple Developer
login and 2FA prompts. Run it in an interactive terminal when authentication
is needed. Over SSH, use `ssh -t` and run `security unlock-keychain` first;
`xcodes` stores the Apple ID session in the login keychain, and a locked
keychain fails with `OSStatus error:[-25308]`. Selecting the release needs
sudo: devbox hosts with a [sudo config](devbox.md#sudo-without-a-plaintext-password-file)
use `sops-devbox-sudo`; otherwise the task prints the exact `sudo` command to
run. Simulator runtimes are a multi-GB download. Run the
application’s build afterward to verify its Xcode/runtime combination.

## Android TV

On Linux, install the Android SDK under `~/Android/Sdk` before continuing.
Accept licenses, then choose packages for the app’s API level and host
architecture. This example creates an ARM64 Android TV emulator:

```zsh
print -r -- "$ANDROID_HOME"
command -v adb emulator sdkmanager avdmanager
sdkmanager --licenses
sdkmanager 'system-images;android-34;android-tv;arm64-v8a'
avdmanager create avd -n android-tv -k 'system-images;android-34;android-tv;arm64-v8a'
```

The [shell template](../chezmoi/.chezmoitemplates/zshrc) selects `ANDROID_HOME` from
the installed SDK paths. Verify:

```zsh
adb --version
emulator -list-avds
```

For a project that requires JDK 17, install and select it in the project
instead of changing the shared toolchain:

```zsh
mise install java@temurin-17
export JAVA_HOME="$(mise where java@temurin-17)"
```

## CocoaPods and Fastlane

Use the application's Ruby environment and `Gemfile`:

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
