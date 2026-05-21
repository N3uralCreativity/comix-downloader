# Comix Mihon Source Extension

This folder contains a separate Android source extension for Mihon/Tachiyomi-compatible readers. It is not the Chrome/Firefox WebExtension and it does not use browser APIs such as `chrome.tabs`, `chrome.downloads`, content scripts, or service workers.

## Source

- Name: `Comix`
- Language: `en`
- Base URL: `https://comix.to`
- Source API: Mihon/Tachiyomi `HttpSource`

## Build Requirements

- JDK 17 or newer
- Android SDK with API 34 installed
- Network access for Gradle dependencies

## Build

From this folder:

```powershell
.\gradlew.bat :src:en:comix:assembleRelease
```

On macOS/Linux:

```sh
./gradlew :src:en:comix:assembleRelease
```

The release APK is generated under:

```text
src/en/comix/build/outputs/apk/release/
```

The GitHub release workflow renames the APK to:

```text
comix-mihon-vX.Y.Z.apk
```

## Manual Installation

1. Download `comix-mihon-vX.Y.Z.apk` from GitHub Releases.
2. Install the APK on Android.
3. Allow unknown app installs if Android asks.
4. Open Mihon.
5. Go to Browse / Sources.
6. Select `Comix`.

If Android reports that another Comix source extension is already installed, uninstall the other Comix source first and then install this APK.

Third-party Mihon extensions should only be installed from sources you trust. Mihon does not host content; this extension only reads from the configured source site.

## Windows SSL Note

If Gradle fails on Windows with a `PKIX path building failed` dependency download error, run the build with:

```powershell
$env:GRADLE_OPTS="-Djavax.net.ssl.trustStoreType=Windows-ROOT"
.\gradlew.bat :src:en:comix:assembleRelease
```
