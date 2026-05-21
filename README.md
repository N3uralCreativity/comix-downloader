<div align="center">

# Comix Downloader

### Download manga from [comix.to](https://comix.to)

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-brightgreen?logo=googlechrome&logoColor=white)](https://github.com/N3uralCreativity/comix-downloader/releases)
[![Firefox Extension](https://img.shields.io/badge/Firefox-Temporary%20Extension-orange?logo=firefoxbrowser&logoColor=white)](https://github.com/N3uralCreativity/comix-downloader/releases)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**by [N3uralCreativity](https://github.com/N3uralCreativity)**

</div>

---

## What It Does

Comix Downloader adds download buttons directly to comix.to title pages. You can grab a single chapter or use **Download All** to download the whole series.

Large series are split into multiple ZIP parts automatically, for example `...-part-01.zip`, `...-part-02.zip`, and so on. This avoids the browser memory issue that can happen when trying to build one huge archive.

---

## Download All

Hit **Download All** on any title page. The extension collects every chapter across the manga's chapter pagination, downloads each chapter into its own folder, and saves the result as one or more ZIP files.

![Download All button on title page](assets/screenshot-title.png)

During a Download All session, the extension opens and closes background browser tabs to extract each chapter. This is normal. Your current tab is not touched, but you may notice tabs briefly appearing. Do not close the browser while a download is in progress.

![Download progress popup](assets/screenshot-progress.png)

---

## Individual Chapters

Each chapter gets its own download button in the chapter list.

![Per-chapter download buttons](assets/screenshot-chapters.png)

---

## Install on Chrome

1. Open the [latest release](https://github.com/N3uralCreativity/comix-downloader/releases/latest).
2. Download `comix-downloader-chrome-vX.Y.Z.zip`.
3. Extract the ZIP.
4. Open Chrome and go to `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the extracted folder.
7. Open any [comix.to](https://comix.to) title page.

---

## Install on Firefox

Firefox support is currently shipped as a temporary unpacked extension. It works for testing and normal use during the current browser session, but Firefox removes temporary extensions after restart.

1. Open the [latest release](https://github.com/N3uralCreativity/comix-downloader/releases/latest).
2. Download `comix-downloader-firefox-vX.Y.Z.zip`.
3. Extract the ZIP.
4. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
5. Click **Load Temporary Add-on**.
6. Select the extracted folder's `manifest.json`.
7. Open any [comix.to](https://comix.to) title page.

A permanent Firefox install requires a Mozilla-signed XPI. That is planned for a later release path.

---

## Android

The Chrome package can also be loaded on Android through [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser).

1. Install Kiwi Browser from the Play Store.
2. Download `comix-downloader-chrome-vX.Y.Z.zip` from the latest release.
3. Extract it on your phone.
4. Open Kiwi and go to `chrome://extensions`.
5. Enable **Developer mode**.
6. Tap **Load unpacked (zip or folder)** and select the extracted folder.
7. Open any [comix.to](https://comix.to) title page.

iOS is not supported because Safari does not allow this extension-based download flow.

---

## Release Assets

Each release should include:

- `comix-downloader-chrome-vX.Y.Z.zip`
- `comix-downloader-firefox-vX.Y.Z.zip`

The browser packages are built automatically by GitHub Actions when a release is published.

---

## License

MIT (c) [N3uralCreativity](https://github.com/N3uralCreativity)
