# Comix Downloader

> Chrome extension (Manifest V3) — Download manga chapters from [comix.to](https://comix.to) as ZIP files, directly from the title page.

**by [N3uralCreativity](https://github.com/N3uralCreativity)**

---

## Features

- **Per-chapter download** — one-click button next to every chapter on the title page
- **Download All** — downloads every chapter into a single ZIP with one folder per chapter (`Ch0001/`, `Ch0002/`, …)
- **CDN-agnostic** — works with any `wowpic*.store` CDN variant, auto-detected
- **Smart page detection** — three-strategy extraction (Next.js `__NEXT_DATA__`, DOM frequency counting, URL pattern enumeration) handles partial preloads and lazy-loading
- **Progress popup** — live progress bar, per-chapter log, cancel button
- **Persistent activity log** — accessible from the extension popup

## Installation (unpacked)

1. Clone or download this repository
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. Navigate to any `comix.to/title/…` page

## File Structure

```
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker — tab orchestration, ZIP creation, logging
├── content_title.js       # Content script — injects download buttons & popup UI
├── popup.html             # Extension popup (credits + activity log)
├── popup.js               # Popup logic
├── lib/
│   └── jszip.min.js       # JSZip 3.10.1
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How it works

1. User clicks a chapter's download button on the title page
2. The service worker opens the chapter in a background tab
3. `extractChapterImagesFromPage()` is injected (world: MAIN) to detect all image URLs
4. Images are fetched in parallel batches of 3 directly from the CDN (service worker has `host_permissions`)
5. JSZip assembles a ZIP → `chrome.downloads` saves it as a `data:` URL

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Open/close background chapter tabs |
| `scripting` | Inject extraction script into chapter pages |
| `downloads` | Trigger ZIP file download |
| `storage` | Persist activity logs across sessions |
| `host_permissions: comix.to, *.wowpic*.store` | Fetch chapter pages and CDN images |

## License

MIT © N3uralCreativity
