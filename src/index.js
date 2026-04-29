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
import { salesBinderRoutes } from './salesbinder.js';
import { amazonRoutes, runAmazonOrdersChunk, runAmazonReportsTick, invalidateAmazonSalesCache } from './amazon.js';
import { redactSecrets } from './redact.js';

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
  const salesBinder = !!(env.SALESBINDER_SUBDOMAIN && env.SALESBINDER_API_KEY);
  const amazon = !!(env.AMAZON_REFRESH_TOKEN && env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET);
  return c.json({
    xero:        { connected: false, live: false, cached: false, org: null },
    amazon:      { connected: amazon },
    wooCA:       { connected: wooCA },
    wooUS:       { connected: wooUS },
    logiwa:      { connected: false, source: 'csv-upload' },
    salesBinder: { connected: salesBinder, cached: false },
  });
});

// WooCommerce routes (Step 5b: /api/woo/sales reads from D1, cron-refreshed).
app.route('/api/woo', wooRoutes);

// Admin routes (Step 5: historical backfill into D1, reconciliation against Woo).
// All routes here require an X-Admin-Key header matching env.ADMIN_KEY.
app.route('/api/admin', adminRoutes);

// SalesBinder routes (Step 5c.2: inventory + packaging snapshots, KV-cached).
app.route('/api/salesbinder', salesBinderRoutes);

// Amazon SP-API routes (Step 5c.1b: D1-backed sales endpoint, async Reports
// state machine, LWA token cached in KV). Cron drives Orders + Reports work
// in parallel with Woo's incremental sync.
app.route('/api/amazon', amazonRoutes);

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
//
// redactSecrets lives in src/redact.js so adding a new credential prefix
// (Atzr| for Amazon LWA, oauth_token= for Xero, etc.) is one edit. See that
// file for the catalogue of patterns currently covered.
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
async function runWooCronSync(env) {
  const markets = [];
  if (env.WOO_CA_URL && env.WOO_CA_KEY && env.WOO_CA_SECRET) markets.push('CA');
  if (env.WOO_US_URL && env.WOO_US_KEY && env.WOO_US_SECRET) markets.push('US');
  if (markets.length === 0) {
    console.log('Woo cron sync skipped: no markets configured');
    return;
  }

  for (const market of markets) {
    try {
      const result = await runBackfillChunk(env, market, 1, 'incremental');
      if (result.ordersAdded > 0) {
        await invalidateWooSalesCache(env, market);
        console.log(
          `Woo cron ${market}: +${result.ordersAdded} orders, +${result.itemsAdded} items, ` +
          `watermark ${result.watermarkBefore} → ${result.watermarkAfter} (${result.durationMs}ms)`,
        );
      } else {
        console.log(`Woo cron ${market}: caught up (${result.durationMs}ms)`);
      }
    } catch (e) {
      console.error(`Woo cron ${market} failed:`, redactSecrets(e?.message || String(e)));
    }
  }
}

// Amazon cron: one Orders chunk per market per tick + one Reports state-machine
// tick per market (Phase A + up to N=3 Phase B + up to N=3 Phase C with a 25s
// wall-clock guard each). Markets run in parallel — Workers Free scheduled
// handlers have a 30s wall-clock cap and the sequential path could push past
// it when both markets have heavy report ingests in the same tick.
async function runAmazonCronSync(env) {
  if (!(env.AMAZON_REFRESH_TOKEN && env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET)) {
    console.log('Amazon cron sync skipped: secrets not configured');
    return;
  }
  async function syncOne(market) {
    try {
      const ord = await runAmazonOrdersChunk(env, market, { action: 'amazon-incremental' });
      if (ord.ordersAdded > 0) {
        await invalidateAmazonSalesCache(env, market);
        console.log(
          `Amazon cron ${market}: +${ord.ordersAdded} orders, ` +
          `watermark ${ord.watermarkBefore} → ${ord.watermarkAfter} (${ord.durationMs}ms)`,
        );
      } else {
        console.log(`Amazon cron ${market}: no new orders (${ord.durationMs}ms)`);
      }
    } catch (e) {
      console.error(`Amazon cron Orders ${market} failed:`, redactSecrets(e?.message || String(e)));
    }
    try {
      const rep = await runAmazonReportsTick(env, market);
      if (rep.seeded || rep.polled || rep.ingested) {
        console.log(
          `Amazon cron ${market} reports: seeded=${rep.seeded} polled=${rep.polled} ingested=${rep.ingested} (${rep.durationMs}ms)`,
        );
      }
    } catch (e) {
      console.error(`Amazon cron Reports ${market} failed:`, redactSecrets(e?.message || String(e)));
    }
  }
  await Promise.allSettled([syncOne('CA'), syncOne('US')]);
}

async function runCronSync(env) {
  if (!env.DB) {
    console.log('cron sync skipped: DB binding not configured');
    return;
  }
  // Woo and Amazon are independent — run in parallel so neither blocks the other.
  await Promise.allSettled([runWooCronSync(env), runAmazonCronSync(env)]);
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    // ctx.waitUntil keeps the work alive past the synchronous return so the
    // platform can manage handler lifetime cleanly.
    ctx.waitUntil(runCronSync(env));
  },
};
