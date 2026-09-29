# Comix Downloader Plus Store Disclosures

Use these disclosures only after the Plus API, policies, and optional permission flow are live.

## Chrome Web Store - privacy disclosure

Comix Downloader works without an account. Existing download, reader, settings, subscription, ad-blocking, and library features remain free.

Comix Downloader Plus is an optional, user-initiated service. If a user signs in to Plus, the extension transmits the following only to the dedicated Plus API:

- Email address for account verification and transactional service email.
- Authentication and entitlement records needed to operate the account.
- Opaque device identifiers, device names, public keys, approval status, and last-seen timestamps.
- Encrypted synchronization payloads (AES-256-GCM in the browser). The server receives ciphertext plus revision, schema, size, and timestamps.
- A copy of the account's data key, encrypted by the Worker with a server-side secret, so that signing in with an email code unlocks a new device. The service could technically decrypt stored data with it; it does not, except where the law requires.
- Cloud Library chapters the user chooses to save: page images, names, a small preview image, and reading positions, all encrypted in the browser with AES-256-GCM before upload. The server receives ciphertext plus page counts, encrypted sizes, encrypted-page digests, folder relationships, upload and trash state, timestamps, and a keyed chapter identifier it cannot reverse.
- Minimal security and operational information, including hashed rate-limit identifiers, request IDs, error codes, and API timing.

Sync categories are separately selectable and default to off. Nothing is uploaded to the Cloud Library automatically, and stored items are private to the account with no sharing feature. Plus never uploads downloaded ZIP/CBZ files, activity logs, active downloads, library-server credentials, cookies, CAPTCHA information, notices, review state, or Release Agenda history. Data is not sold, used for advertising, creditworthiness, or unrelated profiling.

Suggested Chrome data categories for a Plus-enabled release: personally identifiable information (email), authentication information, website content (encrypted Cloud Library pages the user saves), and user activity (encrypted reading progress and watched series the user chooses to sync).

## Chrome - optional Plus host permission justification

`https://plus.n3uralcreativity.top/*` is requested only when the user signs in to Comix Downloader Plus. It is used for email-code authentication, subscription entitlement, encrypted synchronization, restore history, the encrypted Cloud Library, and device management. Once granted, the same permission also lets the extension register `content/plus-bridge.js` on pages of that origin only (the Plus account page and web library), so signing in or out on the Plus website and in the extension stay in step in the same browser. The bridge exchanges sign-in state and single-use, two-minute sign-in codes with the page and reads no other page content. Free users never contact this API, and the bridge is never registered for them. Production packages use the separately deployed production origin.

## Firefox - optional data declarations

- `personallyIdentifyingInfo`: verified account email.
- `authenticationInfo`: account registration, email-code verification, sessions, and the devices signed in to the account.
- `browsingActivity`: selected watched-series, reading-progress, and downloaded-chapter metadata inside encrypted payloads.
- `websiteContent`: chapter pages the user chooses to save to the Cloud Library, encrypted in the browser before upload. Firefox counts transmitted data even when it is encrypted.
- `technicalAndInteraction`: selected extension settings plus minimal API errors, schema, revision, size, and timing needed to operate synchronization.

These declarations are optional. Firefox asks for consent only during user-initiated Plus sign-in. Rejecting them leaves every free extension function available. Accounts that signed in before `websiteContent` was declared grant it with "Allow Cloud uploads" in Plus settings; until then, Cloud uploads stop before any page is fetched and nothing is sent.

## Reviewer notes

Plus is implemented in `core/plus-core.js`, `core/plus-ui.js`, and `core/cloud-library.js`. The backend is a separate Cloudflare Worker service at `https://plus.n3uralcreativity.top`; it is not part of the extension package. No remote executable code is loaded. Encryption uses Web Crypto AES-256-GCM; Cloud Library keys are derived with HKDF-SHA256; the Worker keeps each account's data key encrypted with AES-GCM under an HKDF-SHA256 key derived from the `KEY_ESCROW_SECRET` Worker secret and bound to the account. The Plus client is dormant unless local Plus account state exists.

Build exact browser packages from the repository root on Windows 11 with PowerShell 7:

```powershell
./scripts/build-release.ps1
./scripts/validate-release.ps1
```

The extension has no Node build step. The scripts copy audited source files and produce the Chrome, Chromium, Opera, and Firefox archives directly.
