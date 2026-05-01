# logistics-dashboard

The No Pong Logistics Dashboard, rebuilt as a Cloudflare-native web app.

## Where this is deployed

- **Production:** `https://logistics.apps.nopong.com`
- **Hosting:** Cloudflare Workers — auto-deploys on every push to `main`
- **Auth:** Cloudflare Access — `@nopong.net` / `@nopong.com` Google Workspace SSO required

## Status

Step 3 of the Cloudflare rebuild — proof-of-life Worker. Currently this is a placeholder that returns `{"hello": "world"}` from `/api/ping`. Real endpoints (Woo CA/US, Amazon CA/US, Xero, SalesBinder, Logiwa, CIN7) will be ported across from the legacy Node/Express server in subsequent steps.

The legacy server lives in the Drive workspace folder (`AI WORKSPACE/2. Shared Projects/Logistics Dashboard/backend/server.js`) and is the SHAPE reference for the migration — not a code-reuse target. The JSON-file cache pattern there is being replaced with KV / D1 / R2 primitives.

## Editing locally

GitHub Desktop workflow:

1. Pull latest in GitHub Desktop.
2. Edit files (start with `src/index.js`).
3. Commit + push to `main`.
4. Cloudflare deploys within ~60 seconds.

If you want to run it locally before pushing:

```bash
cd ~/Documents/GitHub/logistics-dashboard
npm install
npm run dev          # wrangler dev — opens http://localhost:8787
```

Then hit `http://localhost:8787/api/ping` and you should see `{"hello":"world"}`.

## Secrets

None in this repo today. As real endpoints come online, secrets are managed in two places only:

- **Wrangler secrets** (`wrangler secret put NAME`) — production. Bound into the Worker as `env.NAME`.
- **`.dev.vars`** — local development. Not committed (blocked by `.gitignore`).

Never paste a real secret into `wrangler.jsonc`, source code, or chat. Hard rule.

## Architecture (planned)

| Layer | Tech |
|---|---|
| Frontend | Static `nopong-dashboard.html` served via Cloudflare Pages assets binding, same Worker |
| API | This Worker — `/api/*` routes (Hono added when real routes land) |
| Source-of-truth DB | Cloudflare D1 (orders, SKUs, sync logs, OAuth tokens) |
| Pre-rendered response cache | Cloudflare KV |
| Scheduled syncs | Cloudflare Cron Triggers |
| Auth | Cloudflare Access (Google Workspace SSO) |

## Contributors

- Chris — backend, Cloudflare infra, build/release
- Melanie — product, data model, AU region
