# Privacy Hardening Review

Reviewed against public source commit `a1b1e492a04fc069057f3cceeded4d733c9d1d71`
(v4.3.5), October 22, 2026. This is a targeted review, not a certification of
every extension module, the Plus backend, or all third-party website behavior.

## Verified And Fixed

- SPA navigation previously patched the website's History API, tagged the wrapper
  functions, and emitted public DOM events. Navigation now uses the existing
  browser tabs API and an isolated-world subscription helper, without adding a
  permission or polling loop. Extension-initiated navigation still notifies
  subscribers immediately. Titles, reader enhancements, Home, profiles, settings,
  and Agenda all use the same helper.
- The MAIN-world ad blocker previously exposed its API, installation flags, and
  references to unguarded native popup functions. These are now closure-local.
  Its boolean settings event remains necessary; persistent DOM state and the
  unused blocked-popup event were removed. Popup and overlay blocking remain.
- Chapter extraction previously published its page array on the website's
  window. Results now stay in a closure and are copied on a synchronous, page-local
  request. Decoder wrappers are restored after capture. Normal browsing does not
  receive extraction decoder hooks.
- Unnecessary profile-state and reader-navigation debug attributes were removed.
- Community account registration and chapter lookups previously happened without
  a sharing preference. They now require **Community badges and chapter reports**,
  off by default in Additional Features in both settings views. The background
  enforces consent as well as the content scripts; turning it off aborts pending
  requests. Firefox also requests and checks its optional browser data consent.
- Community consent is stored separately on each device: encrypted settings sync,
  restore and settings imports cannot enable or revoke it, including via delayed
  settings writes. Settings exports omit consent. Other settings still sync.
- Community and notice requests omit cookies and referrers. Stable account and
  chapter hashes are described as pseudonymous, not anonymous, in the policy.
- Required Chromium media resources use browser-generated session URLs instead
  of fixed extension-ID URLs. Firefox packages omit the Chromium-only manifest
  property; Firefox already uses per-install extension resource URLs. Resources
  remain restricted to supported Comix origins, with no scripts made public.

## Retained Behavior And Limits

- The Download All, single-chapter, ZIP/CBZ/PDF, queue, naming, Cloudflare pause,
  and image-retry algorithms are unchanged. No human-behavior imitation or
  rate-limit bypass was added.
- The legacy background-tab extraction fallback still needs a transient `#cdlx`
  bootstrap marker. It is removed at document start, but it is not a secrecy
  mechanism. The normal chapter API path needs no extraction tab or marker.
- Extraction still needs page-world access and an ephemeral request event; its
  data originates from the page and is not an authenticated extension secret.
- Adblocking hooks and added UI remain observable. Closed-over variables and
  dynamic resource URLs do not make the extension undetectable.
- CDN Origin/Referer compatibility rules remain unchanged to avoid breaking
  image downloads. These rules should be rechecked against actual site changes,
  not removed on the assumption that different headers are always unnecessary.
- Remote service notices still contact the community Worker separately, without
  account or chapter identifiers. Community opt-out does not mean no networking.
- Disabling community sharing does not delete previously submitted server records.
  Account and chapter hashes can be matched to known public IDs because the salt
  and algorithm are public. Users must not be promised anonymous participation.
- Plus encryption, authentication and backend retention need their own review.
  In particular, the service retains a protected account-key copy; this review
  does not establish a zero-knowledge or end-to-end confidentiality guarantee.

## Reproduce

```sh
node tests/privacy-boundaries.test.js
```

Build packages using the existing PowerShell 7 scripts, then run:

```sh
node tests/browser/privacy-boundaries.js
node tests/browser/archive-downloads.js
node tests/browser/title-actions.js
node tests/browser/cloudflare-pause.js
```

The browser privacy test uses an isolated Chromium profile, the actual packaged
extension, and fixture pages/backends. It verifies actual SPA notifications,
page-world isolation, working dynamic media URLs and denied fixed-ID probes,
community opt-in/opt-out, and chapter capture without a public page array.
