# Comix Mihon Source Extension

This folder is a standalone Android source extension for [Mihon](https://mihon.app/) and Tachiyomi-compatible readers. It is **not** the Chrome/Firefox WebExtension; it has no browser APIs and is a separate APK with its own build pipeline.

Once installed in Mihon, the source gives you the same "download all" and "per chapter" experience as the desktop extension — except those actions are part of Mihon's built-in download manager, not custom buttons. An extension's job in Mihon is to expose the catalog (browse / search / chapters / pages); the reader and downloader UI are owned by the app itself.

## How users install it

### One-tap install (auto-updates)

1. Install [Mihon](https://mihon.app/download).
2. **More → Settings → Browse → Extension repos → +**, then paste:
   ```
   https://raw.githubusercontent.com/N3uralCreativity/comix-downloader/repo/index.min.json
   ```
3. **Browse → Extensions** → install **Comix**.
4. **Browse → Comix** → pick a title → tap **⋮ → Download → All** (or use the per-chapter download icons).

### Manual APK install

1. Download `comix-mihon-vX.Y.Z.apk` from [Releases](https://github.com/N3uralCreativity/comix-downloader/releases).
2. Install on Android (allow unknown app installs if prompted).
3. Open Mihon → **Browse → Comix**.

If Android reports that another Comix source extension is already installed, uninstall the existing one first. Third-party Mihon extensions should only be installed from sources you trust; Mihon does not host content, it only reads from the configured source site.

## Source metadata

- Name: `Comix`
- Language: `en`
- Base URL: `https://comix.to`
- Source class: `HttpSource`
- Package: `eu.kanade.tachiyomi.extension.en.comix`
- NSFW flag: `1`

## Build requirements

- JDK 17+
- Android SDK with API 35 + `build-tools;35.0.0`
- Network access for Gradle dependencies

## Build the APK

From this folder:

```powershell
.\gradlew.bat :src:en:comix:assembleRelease
```

On macOS/Linux:

```sh
./gradlew :src:en:comix:assembleRelease
```

Output:

```
src/en/comix/build/outputs/apk/release/
```

The release workflow renames the APK to `comix-mihon-vX.Y.Z.apk` and attaches it to the GitHub release.

## Publish the Mihon repo

The release workflow runs `repo-tools/build-index.py` after building the APK. The script:

1. Extracts package, versionCode, versionName from the APK with `aapt`.
2. Reads the signing-cert SHA-256 fingerprint with `apksigner` for `repo.json`.
3. Computes the deterministic source id (`Comix`/`en`) and writes `index.min.json` + `index.json`.
4. Stages the APK under `apk/` and the launcher icon under `icon/`.

The result is force-pushed to the orphan `repo` branch, which Mihon clients fetch via raw.githubusercontent.com.

To dry-run the index locally:

```sh
python3 mihon-support/repo-tools/build-index.py \
  --apk path/to/comix-mihon-vX.Y.Z.apk \
  --out /tmp/repo-staging
```

You need `aapt` and `apksigner` on `PATH` (both ship with Android SDK build-tools).

## Maintainer: signing key for clean updates

For Mihon to **auto-update** the extension across releases, every APK must be signed with the **same** certificate. Mihon stores the SHA-256 fingerprint from `repo.json` on first install and rejects updates whose APK signature doesn't match.

The Gradle config picks the release signing config when `signingkey.jks` exists at the repo root and three env vars are set: `KEY_STORE_PASSWORD`, `ALIAS`, `KEY_PASSWORD`. Otherwise it falls back to the **debug** keystore, which differs from machine to machine — meaning every CI release would invalidate the previous one.

For a stable release pipeline:

1. Generate a keystore once: `keytool -genkey -v -keystore signingkey.jks -alias comix -keyalg RSA -keysize 2048 -validity 10000`.
2. Encode it: `base64 -w0 signingkey.jks > keystore.b64` (or `[Convert]::ToBase64String([IO.File]::ReadAllBytes('signingkey.jks'))` on PowerShell).
3. Add four repo secrets in GitHub → Settings → Secrets and variables → Actions:
   - `SIGNING_KEYSTORE_B64` — the base64 blob
   - `KEY_STORE_PASSWORD`, `ALIAS`, `KEY_PASSWORD`
4. Decode `SIGNING_KEYSTORE_B64` to `signingkey.jks` inside the workflow before `gradlew assembleRelease` (a single `echo "$SECRET" | base64 -d > signingkey.jks` step).
5. Keep the keystore offline. **Never commit it.**

Until that's in place, every fresh release published to the `repo` branch will force users to uninstall and reinstall manually.

## Windows SSL note

If Gradle fails on Windows with a `PKIX path building failed` dependency download error, run:

```powershell
$env:GRADLE_OPTS="-Djavax.net.ssl.trustStoreType=Windows-ROOT"
.\gradlew.bat :src:en:comix:assembleRelease
```
