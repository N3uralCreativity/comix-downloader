<div align="center">

# Comix Downloader

### Download your mangas from [comix.to](https://comix.to) 

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-4285F4?logo=googlechrome\&logoColor=white)](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Add--on-FF7139?logo=firefox-browser\&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/comix-chapter-downloader/)
[![Opera](https://img.shields.io/badge/Opera-Extension-FF1B2D?logo=opera\&logoColor=white)](https://addons.opera.com/en/extensions/details/comix-downloader/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/N3uralCreativity/comix-downloader?logo=github\&label=Star%20to%20stay%20updated\&color=f5c518)](https://github.com/N3uralCreativity/comix-downloader)




**by [N3uralCreativity](https://github.com/N3uralCreativity)**

**[Checkout the Site for a more User-Friendly interface](https://n3uralcreativity.top/comix-downloader/)**

**[Access Documentation here](https://n3uralcreativity.top/comix-downloader/Documentation.html)**



</div>

---

## What it does

Adds download buttons directly to every comix.to title page. Grab a single chapter or the entire series as organized ZIP or CBZ output.

It also blocks comix.to's intermittent click-anywhere ads, popunders, and transparent ad overlays. Ad blocking is enabled by default and can be turned off under **Settings -> Additional Features**. Normal links and the site's share popup remain available.

---

## Download an entire series in one click

Hit **Download All** on any title page. Every chapter is downloaded in order and packaged as image folders or one CBZ per chapter. Large series use resumable outer ZIP parts with separate chapter limits for each format.

![Download All button on title page](assets/screenshot-title.png) (peak Manhwa btw)

---

## Or pick individual chapters

Each chapter gets its own download button right in the list.
Multiple chapter downloads can run at the same time. The **Chapters at once** setting controls the limit for both individual downloads and **Download All**.

![Per-chapter download buttons](assets/screenshot-chapters.png)

---

## Live progress for series download

![Download progress popup](assets/screenshot-progress.png)

### > **WARNING**: During download sessions, the extension automatically opens and closes background browser tabs to extract each chapter. This is completely normal behaviour. Your current tab is never touched, but you may notice tabs briefly appearing in your taskbar. **Do not close the browser while a download is in progress.**

---

## Mobile support (Android & iOS)

### Option A - Mihon (recommended for offline reading)

> [!IMPORTANT]
> **Mihon is not the browser extension, and it works completely differently - please read this before installing.**
>
> The desktop / Firefox version adds download buttons *onto the comix.to web page*. **Mihon does not.** [Mihon](https://mihon.app/) is a separate **reading app** on your phone, with its own library, reader and download manager. Our **Comix source** simply teaches Mihon how to find comix.to titles, chapters and pages.
>
> So after you install the source, **nothing will change if you open comix.to in a web browser** - that's expected, and it's the most common point of confusion. Everything happens **inside the Mihon app instead**: you browse comix, open a title, and download from Mihon's own menu. The web browser is never involved.

Once it's set up, you get the same **Download All** and **per-chapter** capability as the PC extension - just through Mihon's own UI:

- **Download all chapters** - open any title → tap the **⋮** menu → **Download** → **All** (or Next / Unread / Custom range)
- **Per-chapter download** - tap the download arrow on a chapter row, or long-press to multi-select
- Monitor / pause / reorder downloads from **More → Download queue**
- Files land under `Mihon/downloads/Comix/<Manga>/<Chapter>/` for offline reading

#### Step-by-step install (auto-updating - recommended)

Follow every step in order:

1. **Install the Mihon app.** Get it from [mihon.app/download](https://mihon.app/download) and open it once so it finishes setting up. (This is a standalone app - not a browser, and not our extension.)
2. **Add our source to Mihon.** In Mihon, tap **More** (bottom-right) → **Settings** → **Browse** → **Extension repos**. Tap **+**, paste the address below exactly, and confirm:
   ```
   https://raw.githubusercontent.com/n3uralcreativity/comix-downloader/repo/index.min.json
   ```
3. **Turn on 18+ sources - required, don't skip.** Still on the **Settings → Browse** screen, enable **Show NSFW sources** (18+). Comix is flagged 18+, so with this **off** it installs fine but stays **completely hidden from your Sources list** - this is the usual reason people install it and then can't find it.
4. **Install the Comix extension.** Open the **Browse** tab (bottom bar) → **Extensions**. Under a heading like *Comix Mihon Extensions*, find **Comix** and tap **Install**. If Android blocks it, allow *"install unknown apps"* for Mihon and try again.
5. **Open the Comix catalogue.** Go to the **Browse** tab and tap **Comix** under **Sources** (that's the tab where you actually browse - not the Extensions sub-tab). You should now see comix titles loading **inside Mihon** - that's how you know it's working. Use the search icon to find a specific series.
6. **Add a title to your library** (optional but recommended) so Mihon tracks new chapters - open a title and tap **Add to library**.
7. **Download.** Open a title → **⋮** menu → **Download** → **All** / **Next** / **Unread** / **custom range**. For one chapter, long-press its row or tap its download arrow. Track progress under **More → Download queue**.
8. **Read offline.** Downloaded chapters open instantly in Mihon's reader with no connection needed.

Mihon fetches new versions automatically whenever a new release is published here - no reinstalling.

> **Installed Comix but it never shows under Sources?** That's almost always the 18+ filter (step 3). Comix is NSFW-flagged, so Mihon installs it and lists it under *Extensions* but hides it from **Browse → Sources** until **Settings → Browse → Show NSFW sources** is on. Turn it on and Comix appears in Sources right away.

#### Manual APK install (one-off)

1. Grab `comix-mihon-vX.Y.Z.apk` from [Releases](https://github.com/N3uralCreativity/comix-downloader/releases).
2. Install on your phone (allow unknown app installs if prompted).
3. Open Mihon → **Browse** → **Comix**.

> Note: the manual APK doesn't auto-update. The repo URL in the step-by-step above is the better choice for most people.

### Option B - Kiwi Browser (browser-extension parity)

If you specifically want the in-page buttons that the desktop extension provides, the WebExtension works as-is on Android via **[Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser)**:

**Easiest:** open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp) in Kiwi and tap **Add to Chrome** - Kiwi installs Chrome Web Store extensions directly.

Or load it unpacked:

1. Install [Kiwi Browser](https://play.google.com/store/apps/details?id=com.kiwibrowser.browser) from the Play Store.
2. On your phone, download this repo ZIP and extract it.
3. Open Kiwi → go to `chrome://extensions`.
4. Toggle **Developer mode** on.
5. Tap **Load unpacked (zip or folder)** → select the extracted folder.
6. Head to any [comix.to](https://comix.to) title page - buttons appear automatically.

### Option C - Firefox Android add-on
[![Get the Add-on](https://img.shields.io/badge/Firefox-Get%20the%20Add--on-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge)](https://addons.mozilla.org/en-US/firefox/addon/comix-chapter-downloader/)

### iOS & iPadOS - via Orion browser

Comix Downloader does not currently ship a Safari build. Safari Web Extensions require a separate Apple app, Xcode build, signing, and Apple-platform test pipeline. [Orion](https://orionbrowser.com/) (a free WebKit browser by Kagi) can install Chrome and Firefox extensions on iPhone and iPad, although its extension support is still more experimental than desktop.

1. Install [Orion Browser](https://orionbrowser.com/) (by Kagi) from the App Store.
2. In Orion: **•••** menu → **Settings** → the **Extensions** group → turn on **Chrome extensions** (and/or Firefox extensions).
3. Open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp) (or the [Firefox add-on](https://addons.mozilla.org/en-US/firefox/addon/comix-chapter-downloader/)) in Orion and tap **Add to Chrome** / **Add to Firefox**.
4. **•••** menu → **Extensions** → toggle **Comix Downloader** on.
5. Open any [comix.to](https://comix.to) title page - buttons appear automatically.

For fully offline reading on mobile, Mihon (Option A) is still the most reliable.

---
## PC support

Chrome, Opera, Opera GX, Brave, Vivaldi, Chromium, and Firefox are supported. Every GitHub release contains separately named store packages, and CI verifies that all Chromium packages contain exactly the same runtime files.

### Firefox

[![Get the Add-on](https://img.shields.io/badge/Firefox-Get%20the%20Add--on-FF7139?logo=firefox-browser&logoColor=white&style=for-the-badge)](https://addons.mozilla.org/en-US/firefox/addon/comix-chapter-downloader/)

### Chrome

[![Get the Extension](https://img.shields.io/badge/Chrome-Get%20the%20Extension-4285F4?logo=googlechrome&logoColor=white&style=for-the-badge)](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp)

The extension is on the **Chrome Web Store** - one click to install.

1. Open the [Chrome Web Store listing](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp).
2. Click **Add to Chrome** and confirm the permissions prompt.
3. Head to any [comix.to](https://comix.to) title page - buttons appear automatically.

### Opera and Opera GX

The release workflow produces `comix-downloader-opera-vX.Y.Z.zip` for Opera Add-ons. Opera and Opera GX can also use the [Chrome Web Store listing](https://chromewebstore.google.com/detail/nojjjpmicodkodnnllbdolpglhlclpdp).

### Brave, Vivaldi, and other Chromium browsers

Use the Chrome Web Store listing, or the `comix-downloader-chromium-vX.Y.Z.zip` release asset for manual installation. These browsers share the same tested Chromium runtime as the Chrome and Opera packages.

<details>
<summary>Or install manually (unpacked / developer mode)</summary>

1. Download the matching browser ZIP from [GitHub Releases](https://github.com/N3uralCreativity/comix-downloader/releases) and unzip it
2. Open Chrome → go to `chrome://extensions`
3. Toggle **Developer mode** on (top-right)
4. Click **Load unpacked** → select the unzipped folder
5. Head to any [comix.to](https://comix.to) title page - buttons appear automatically

</details>

---

## License

MIT © [N3uralCreativity](https://github.com/N3uralCreativity)
