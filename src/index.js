/**
 * No Pong — Logistics Dashboard Worker
 *
 * Hono app. The dashboard frontend (nopong-dashboard.html) and its assets
 * are served from /public via the Workers static-assets binding; the asset
 * router runs before this Worker, so paths matching a file in /public are
 * served directly and only `/api/*` (or unknown paths) reach Hono.
 *
 * Domain: https://logistics.apps.nopong.com
 * Auth:   Cloudflare Access (Google Workspace SSO, @nopong.net / @nopong.com)
 */

import { Hono } from 'hono';
import { wooRoutes, invalidateWooSalesCache } from './woo.js';
import { adminRoutes, runBackfillChunk } from './admin.js';

const app = new Hono();

// Health check — survives from the Step 3 hello-world.
app.get('/api/ping', (c) => c.json({ hello: 'world' }));

// /api/status — the dashboard's loadAllData() calls this first and treats any
// non-200 as "server not running", which short-circuits every subsequent fetch
// into a "static mode with sample data" fallback. We mirror the legacy Express
// shape so loadAllData runs through and dispatches the per-source loaders for
// any source we've actually got configured. Sources that aren't ported yet
// just report `connected: false` and the dashboard skips them.
app.get('/api/status', (c) => {
  const env = c.env;
  const wooCA = !!(env.WOO_CA_URL && env.WOO_CA_KEY && env.WOO_CA_SECRET);
  const wooUS = !!(env.WOO_US_URL && env.WOO_US_KEY && env.WOO_US_SECRET);
  return c.json({
    xero:        { connected: false, live: false, cached: false, org: null },
    amazon:      { connected: false },
    wooCA:       { connected: wooCA },
    wooUS:       { connected: wooUS },
    logiwa:      { connected: false, source: 'csv-upload' },
    salesBinder: { connected: false, cached: false },
  });
});

// WooCommerce routes (Step 4: /api/woo/sales as a 30-day live fetch with KV cache).
app.route('/api/woo', wooRoutes);

// Admin routes (Step 5: historical backfill into D1, reconciliation against Woo).
// All routes here require an X-Admin-Key header matching env.ADMIN_KEY.
app.route('/api/admin', adminRoutes);

// Catch-all 404 for unknown /api/* paths and any non-asset path.
app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));

// Error handler — log full detail to observability, return a SANITIZED message.
//
// Hard rule: anything that ends up in `err.message` may end up in a response
// body, terminal scrollback, or a transcript. Native fetch() errors bake the
// full request URL into their message — which for our Woo helper means
// consumer_key/consumer_secret query params get exposed verbatim if we pass
// err.message through. We caught one such leak in the wild on 2026-04-29 (a
// `ttps://` URL typo on WOO_US_URL surfaced both Woo US credentials in the
// 500 response). The wooFetch helper now sanitizes at the source; this is the
// belt-and-braces backstop for any other code path that throws.
function redactSecrets(s) {
  return String(s || '')
    .replace(/(consumer_key|consumer_secret|access_token|refresh_token|api_key)=[^&\s"']+/gi, '$1=[REDACTED]')
    .replace(/\b(ck|cs)_[a-f0-9]{20,}\b/gi, '$1_[REDACTED]');
}

app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'internal error', detail: redactSecrets(err?.message) }, 500);
});

// ─── Cron incremental sync ─────────────────────────────────────────────────
//
// `triggers.crons` in wrangler.jsonc fires this every 15 minutes. For each
// configured Woo market we pull one chunk (pages=1, ≤100 orders) since the
// watermark, write any new orders, advance the watermark, and invalidate the
// /api/woo/sales KV cache key for that market so the next dashboard load
// re-aggregates from D1 with the fresh rows.
//
// Markets without configured secrets are silently skipped — once US secrets
// are set with `wrangler secret put WOO_US_*` the cron picks it up on the
// next tick. No code change needed at that boundary.
//
// One chunk per tick is intentional: pages=1 every 15 min is 400 orders/hour
// of headroom, comfortably above CA's ~70 orders/day. If the cron is offline
// for a stretch and a backlog forms, it self-heals over a few subsequent ticks.
async function runCronSync(env) {
  if (!env.DB) {
    console.log('cron sync skipped: DB binding not configured');
    return;
  }
  const markets = [];
  if (env.WOO_CA_URL && env.WOO_CA_KEY && env.WOO_CA_SECRET) markets.push('CA');
  if (env.WOO_US_URL && env.WOO_US_KEY && env.WOO_US_SECRET) markets.push('US');
  if (markets.length === 0) {
    console.log('cron sync skipped: no Woo markets configured');
    return;
  }

  for (const market of markets) {
    try {
      const result = await runBackfillChunk(env, market, 1, 'incremental');
      if (result.ordersAdded > 0) {
        await invalidateWooSalesCache(env, market);
        console.log(
          `cron sync ${market}: +${result.ordersAdded} orders, +${result.itemsAdded} items, ` +
          `watermark ${result.watermarkBefore} → ${result.watermarkAfter} (${result.durationMs}ms)`,
        );
      } else {
        console.log(`cron sync ${market}: caught up (${result.durationMs}ms)`);
      }
    } catch (e) {
      // Keep going for the next market — one bad store shouldn't kill the whole run.
      console.error(`cron sync ${market} failed:`, e?.message || e);
    }
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    // ctx.waitUntil keeps the work alive past the synchronous return so the
    // platform can manage handler lifetime cleanly.
    ctx.waitUntil(runCronSync(env));
  },
};
