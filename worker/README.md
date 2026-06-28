# Comix-Downloader badge service (Cloudflare Worker)

A tiny, free backend for the "Comix-Downloader user · N months" badge shown on comix.to profiles.
It stores, per user, the date the service **first** heard from them — keyed by an **opaque salted
hash** of the comix user id (the extension hashes it before sending), with the date **timestamped
server-side** so it can't be forged. No raw ids, no PII.

Runs comfortably inside Cloudflare's **free** tier (100k requests/day; KV 100k reads + 1k writes/day).

## Deploy (one time, ~5 minutes)

1. Create a free Cloudflare account: https://dash.cloudflare.com/sign-up
2. Install Wrangler and log in:
   ```sh
   npm install -g wrangler
   wrangler login
   ```
3. Create the KV namespace and copy the printed `id`:
   ```sh
   wrangler kv namespace create BADGES
   ```
   Paste that id into `wrangler.toml` (replace `REPLACE_WITH_KV_ID`).
4. Deploy:
   ```sh
   cd worker
   wrangler deploy
   ```
   Wrangler prints your Worker URL, e.g. `https://comix-downloader-badge.<your-subdomain>.workers.dev`.

5. **Send me that URL.** It gets baked into the extension's `CDL_BADGE_API` constant
   (`background.js`). Until then the feature is inert (no badges, no network calls).

## Endpoints

| Method | Path                       | Body / Query                | Response                              |
|--------|----------------------------|-----------------------------|---------------------------------------|
| POST   | `/v1/seen`                 | `{"id":"<hash>"}`           | `{"id","first":"YYYY-MM-DD"}`         |
| GET    | `/v1/seen?ids=h1,h2,…`     | up to 50 hex hashes         | `{"h1":"YYYY-MM-DD","h2":null,…}`     |

`id` is `sha256(comixHashId + SALT)` (hex), computed by the extension. POST sets the first-seen date
only if it doesn't already exist (never overwrites). All responses are JSON with permissive CORS.

## Local test

```sh
cd worker
wrangler dev      # serves the Worker locally for the extension's E2E harness
```
