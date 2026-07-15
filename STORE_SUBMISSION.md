# Browser Store Submission Guide

GitHub release creation builds and validates all browser packages automatically. Upload the package whose name matches the destination store.

## Release Packages

| Destination | Release asset |
| --- | --- |
| Chrome Web Store | `comix-downloader-chrome-vX.Y.Z.zip` |
| Mozilla Add-ons | `comix-downloader-firefox-vX.Y.Z.zip` |
| Opera Add-ons / Opera GX | `comix-downloader-opera-vX.Y.Z.zip` |
| Brave, Vivaldi, and manual Chromium installs | `comix-downloader-chromium-vX.Y.Z.zip` |

Chrome, Opera, and generic Chromium archives intentionally contain identical files. `scripts/validate-release.ps1` compares every file hash and fails the release if they diverge. Firefox contains the same runtime files with its required background-script and Gecko manifest fields.

## Shared Listing Information

- Name: `Comix Downloader`
- Category: `Productivity`
- License: `MIT`
- Support URL: `https://github.com/N3uralCreativity/comix-downloader/issues`
- Homepage: `https://github.com/N3uralCreativity/comix-downloader`
- Privacy policy: `https://n3uralcreativity.github.io/comix-downloader/privacy.html`
- Single purpose: Enhance reading and offline access on comix.to.

Suggested summary:

> Download comix.to chapters and series, enhance the reader, and block the site's intrusive click ads and popups.

Suggested description:

> Comix Downloader adds chapter and full-series download controls directly to comix.to. Downloads are organized as ZIP or CBZ files and can include ComicInfo metadata. The extension also adds optional reading, library, subscription, and community-quality tools. Its site-specific protection blocks comix.to's intermittent click-anywhere ads, popunders, and transparent overlays and can be disabled in Settings. During a download, the extension opens inactive chapter tabs to read the page list, closes them automatically, fetches the page images, and creates the archive locally in the browser.

## Permission Justifications

- `tabs`: Open and close inactive chapter tabs used for extraction, report progress, and open settings or chapter links.
- `downloads`: Save the generated ZIP and CBZ files.
- `scripting`: Extract chapter metadata and page URLs from the inactive chapter tabs.
- `storage`: Keep settings, download recovery state, subscriptions, local library metadata, and dismissed extension notices on the device.
- `contextMenus`: Provide the extension's download shortcuts.
- `alarms`: Check user-created chapter subscriptions on a schedule.
- `notifications`: Notify the user when a subscribed title has a new chapter.
- comix.to and image CDN hosts: Read chapter metadata and download the requested images.
- Cloudflare Worker host: Retrieve extension notices and exchange salted, truncated hashes for optional community tenure and quality counts. Raw comix.to user IDs are not transmitted.
- Optional all-host access: Requested interactively only when a user configures their own WebDAV, Komga, Kavita, or HTTP library endpoint.

The extension does not include advertising or remote executable code. Downloads are built locally. A custom library upload occurs only after the user enables it, enters an endpoint, and grants that endpoint permission.

## Opera Add-ons

1. Sign in to Opera Add-ons and create a new extension submission.
2. Upload `comix-downloader-opera-vX.Y.Z.zip`.
3. Select the MIT license, Productivity category, support URL, and privacy policy above.
4. Explain the one goal as comix.to reading and offline-access enhancement. Downloading, reader tools, and protection from the site's intrusive click overlays all apply only to that goal and site.
5. Disclose the inactive background tabs used during downloads and the anonymous Worker requests described above.
6. Upload clear screenshots captured in Opera with other extensions disabled. Opera recommends 612 x 408 and rejects screenshots larger than 800 x 600.
7. Mention that `lib/jszip.min.js` is JSZip 3.10.1 with the documented AMO safety patch that rejects string callbacks instead of compiling them with `new Function`.

Opera reviews the same package on Windows, macOS, and Linux. The source contains no OS-specific paths or native code.

## Other Browsers

- Brave and Vivaldi use the Chrome Web Store and do not operate separate public extension stores.
- Opera GX uses the Opera package and listing.
- Firefox Android uses the existing Firefox package.
- Safari requires a separately signed Safari Web Extension app, Apple developer identifiers, and an Apple build/distribution pipeline. It is not included until it can be built and functionally tested on Apple platforms without dropping download behavior.

## Local Verification

From the repository root:

```powershell
.\scripts\build-release.ps1
.\scripts\validate-release.ps1
npx --yes web-ext@10.5.0 lint --source-dir dist/package-work/firefox --warnings-as-errors
```

The validator must report four valid browser packages. Firefox lint must report zero errors, warnings, and notices.
