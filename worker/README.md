# Comix-Downloader community service

This Cloudflare Worker supports three extension features while storing only opaque hashes produced on the user's device:

- first-seen dates for the profile tenure badge;
- deduplicated chapter quality flags;
- admin-controlled extension notices, including the Plus announcement.

D1 stores first-seen records and chapter flags. KV stores the small notice document. No raw comix.to user or chapter identifiers are sent to the service.

## Production resources

The checked-in `wrangler.toml` is the source of truth for the deployed Worker:

- Worker: `comix-downloader-badge`
- D1 binding: `FLAGS_DB` (`comix-downloader-community`)
- KV binding: `BADGES`
- read rate-limit binding: `READ_RATE_LIMITER` (120 reads per IP and endpoint per minute)
- write/admin rate-limit binding: `WRITE_RATE_LIMITER` (30 requests per IP and endpoint per minute)
- secret: `CDL_NOTICE_ADMIN_TOKEN`

Persisted invocation logs are enabled at 100 percent sampling. Distributed traces remain disabled.

## Deploy

Wrangler 4.x is required. From this directory:

```powershell
wrangler login
wrangler d1 migrations apply FLAGS_DB --remote
wrangler deploy
```

Set or rotate the notice dashboard token separately. Never place its value in this repository:

```powershell
wrangler secret put CDL_NOTICE_ADMIN_TOKEN
```

Cloudflare only exposes the secret name after upload. Store the value in a password manager.

For a new Cloudflare account, create the backing resources first and replace their IDs in `wrangler.toml`:

```powershell
wrangler kv namespace create BADGES
wrangler d1 create comix-downloader-community --location weur
```

The rate-limit namespace ID is an account-local integer. Use a unique value if this config is deployed into another account.

## Endpoints

| Method | Path | Body or query | Response |
| --- | --- | --- | --- |
| `POST` | `/v1/seen` | `{"id":"<hash>"}` | `{"id","first":"YYYY-MM-DD"}` |
| `GET` | `/v1/seen?ids=h1,h2` | up to 50 hashes | hash-to-date map |
| `POST` | `/v1/flag` | `{"chapter":"<hash>","user":"<hash>","type":"broken"}` | chapter counts |
| `GET` | `/v1/flags?ids=h1,h2` | up to 50 chapter hashes | hash-to-count map |
| `GET` | `/v1/notices` | none | active notices |
| `GET` | `/v1/notices?admin=1` | bearer token | all notices |
| `PUT` | `/v1/notices` | bearer token and notice JSON | saved notice state |

Mutation bodies must use `application/json`. Public bodies are limited to 2 KiB and notice updates to 64 KiB. API traffic is rate limited per Cloudflare location, client IP, and endpoint.

## Local validation

Run the committed endpoint tests from the repository root:

```powershell
node tests/worker.test.js
```

Validate a deploy without publishing it:

```powershell
cd worker
wrangler deploy --dry-run
wrangler d1 migrations apply FLAGS_DB --local
wrangler dev
```

The local-only notice dashboard is `notices-admin.html`. Open it from disk, enter the deployed Worker URL and admin token, then load or save notices. The token is stored only when the dashboard's remember option is enabled.

## Notice types

| Type | What readers see |
| --- | --- |
| `warning` | A blocking card over comix.to until it is dismissed. |
| `notification` | A small card in the top-right corner until it is dismissed. |
| `promotion` | The Comix Downloader Plus announcement. The extension draws it: full screen the first time, then a small phone in the bottom-right corner while the notice stays active. |

A promotion has no title or message of its own; the layout and text ship with the extension (`content/content_plus_announce.js`, from v4.2.38). Its `phase` is `soon` (links to the Plus page) or `launch` (starts the free trial), and `ctaUrl` can override the button destination. Changing the phase, or disabling and re-enabling the notice, starts a new revision, so everyone sees the full screen once more. The extension never shows it in the reader, while the Download All panel is open, to Plus members, or to readers who turned off **Show Plus announcements** (off by default on Firefox). Older extension versions ignore promotions.

To run it from the dashboard: **Add Plus Announcement**, **Save All**, then **Enable**. Switch **Phase** to **Launch (Plus is out)** and **Save All** on launch day; **Disable** ends the campaign.

## Continuous validation and deployment

`.github/workflows/validate.yml` runs every JavaScript test, applies the D1 migration to a local database, and performs a Wrangler dry run on pushes and pull requests. It needs no repository secrets.

To make production deployments automatic, connect the existing Worker to `N3uralCreativity/comix-downloader` under **Workers & Pages > comix-downloader-badge > Settings > Builds**. Use branch `master`, root directory `/worker`, build command `npx wrangler d1 migrations apply FLAGS_DB --remote`, and deploy command `npx wrangler deploy`. Cloudflare must authorize the GitHub repository once before its Builds API can create this connection.
