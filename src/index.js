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
import { salesBinderRoutes, runSalesBinderCronSync } from './salesbinder.js';
import { amazonRoutes, runAmazonOrdersChunk, runAmazonReportsTick, runAmazonInventoryCronSync, invalidateAmazonSalesCache } from './amazon.js';
import { diagnosticsRoutes } from './diagnostics.js';
import { xeroRoutes, xeroAuthRoutes, readXeroStatus } from './xero.js';
import { logiwaRoutes, readLogiwaStatus } from './logiwa.js';
import { auRoutes } from './cin7.js';
import { logisticsRoutes } from './logistics.js';
import { runCin7SalesOrdersChunk, runCin7CreditNotesChunk, runCin7SafetyNetBackfill } from './cin7-sync.js';
import buyingToolHistory from './buying-tool-history.js';
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
app.get('/api/status', async (c) => {
  const env = c.env;
  const wooCA = !!(env.WOO_CA_URL && env.WOO_CA_KEY && env.WOO_CA_SECRET);
  const wooUS = !!(env.WOO_US_URL && env.WOO_US_KEY && env.WOO_US_SECRET);
  const salesBinder = !!(env.SALESBINDER_SUBDOMAIN && env.SALESBINDER_API_KEY);
  const amazon = !!(env.AMAZON_REFRESH_TOKEN && env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET);
  // Xero status reads from D1 (xero_tokens row presence) + KV (cached PO/invoice
  // snapshots), so the dashboard can show "connected (cached)" when the token
  // is gone but a snapshot is still serving. Wrapped in a defensive try so a
  // D1 hiccup doesn't take the rest of /api/status with it — frontend gates
  // every loader on this endpoint and a 500 here means total static-mode.
  let xero = { connected: false, live: false, cached: false, org: null };
  try { xero = await readXeroStatus(env); }
  catch (e) { console.warn('readXeroStatus failed:', redactSecrets(e?.message || e)); }
  // Logiwa flips to connected:true once a snapshot exists in KV. Wrapped in a
  // defensive try (same pattern as Xero) so a KV hiccup can't take /api/status
  // down — frontend gates every loader on this endpoint.
  let logiwa = { connected: false, source: 'csv-upload' };
  try { logiwa = await readLogiwaStatus(env); }
  catch (e) { console.warn('readLogiwaStatus failed:', redactSecrets(e?.message || e)); }
  return c.json({
    xero,
    amazon:      { connected: amazon },
    wooCA:       { connected: wooCA },
    wooUS:       { connected: wooUS },
    logiwa,
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

// Cross-source diagnostics — /api/sync-status (per-source freshness for the
// dashboard's status bar) and /api/audit (read-only data audit powering the
// Data Health panel). Both read directly from D1 + KV and don't take params.
app.route('/api', diagnosticsRoutes);

// Xero connector (Step 5c.3) — OAuth2 auth-code flow + lazy refresh + three
// API endpoints (purchase-orders, invoices, org). Auth flow lives at
// /auth/xero/* (NOT /api/xero/*) because Xero's OAuth callback needs a stable
// path matching what's registered in the Xero app's allowed redirect URIs.
app.route('/api/xero', xeroRoutes);
app.route('/auth/xero', xeroAuthRoutes);

// Logiwa connector (Step 5c.4) — no upstream API; the dashboard uploads a
// pre-parsed JSON snapshot to POST /api/logiwa/inventory and we store it in
// KV. GET returns the snapshot. See src/logiwa.js for the full rationale and
// the reason there is deliberately no R2, no D1, and no ADMIN_KEY here.
app.route('/api/logiwa', logiwaRoutes);

// AU dashboard data (Phase 2 — CIN7 Omni live). Today: /cin7/status proof-of-life
// + /inventory built from CIN7 Products + Stock with the AU SKU rules applied.
// Sales / refunds / POs still ship from the static window.AU_DATA in /au-data.js
// and will move here in subsequent PRs. See src/cin7.js header for the full
// design — KV cache, fallback semantics, secret names.
app.route('/api/au', auRoutes);

// Logistics tab (v2.2.27). Live ShipStation + live CIN7 SalesOrders + Stock
// to drive the warehouse TV with open-distributor visibility and per-line
// stock-fulfillment checks. Bypasses D1 because warehouse ops need real-time
// signal, not a 15-min-lagged cache. See src/logistics.js for the full
// design.
//
// The 11th Birthday launch tab (v2.2.21 — 21 May 2026 product drop) used to
// mount here too via `birthdayRoutes`. Removed in v2.2.46 since the launch
// was over and the polling was unnecessary; the implementation lives at
// archive/11th-birthday-tab/ for re-integration on future launches.
app.route('/api/au', logisticsRoutes);

// Buying-tool history — 18+ months of per-SKU monthly sales plus manually
// curated allocation buffers from the buying-tool spreadsheet. Powers the
// long-history sparklines and forecasting on the buying-tool tile.
//
// Baked into the bundle (src/buying-tool-history.js) rather than living in
// KV: it's small (~16KB), edits are infrequent (when the spreadsheet is
// refreshed), and shipping with the code keeps it version-controlled and
// removes the manual KV-upload step. To update: re-copy backend/buying-tool-
// history.json from the legacy server, regenerate src/buying-tool-history.js,
// and redeploy.
app.get('/api/buying-tool-history', (c) => c.json(buyingToolHistory));

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
  // v2.2.13 (Phase 3a): AU joins the cron once WOO_AU_* secrets are set.
  // Without those secrets the AU branch silently skips, mirroring CA/US.
  // Backfill seeding for AU is one-shot via scripts/import-woo-au-csv.py
  // (Metorik export — see Melanie's Context/DECISIONS.md 2026-05-15).
  if (env.WOO_AU_URL && env.WOO_AU_KEY && env.WOO_AU_SECRET) markets.push('AU');
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

// CIN7 cron (v2.36 Phase A): one SalesOrders chunk + one CreditNotes chunk per
// tick. Each chunk is one CIN7 page (≤250 rows) since the per-source watermark
// in sync_state. 8 CIN7 calls/hour at the steady state — well under all three
// of CIN7's limits (3/sec, 60/min, 5000/day). Phase A is invisible to the
// dashboard — the AU read endpoints (/api/au/sales etc.) still call CIN7
// directly. The data accumulating in D1 powers the Phase C read-side rewrite.
async function runCin7CronSync(env) {
  if (!(env.CIN7_USERNAME && env.CIN7_CONNECTION_KEY)) {
    console.log('CIN7 cron sync skipped: secrets not configured');
    return;
  }
  // Sales orders chunk
  try {
    const so = await runCin7SalesOrdersChunk(env);
    if (so.rowsUpserted > 0) {
      console.log(
        `CIN7 cron sales: +${so.rowsUpserted} orders, +${so.itemsUpserted} items, ` +
        `watermark ${so.watermarkBefore} → ${so.watermarkAfter} (${so.durationMs}ms)` +
        (so.more ? ' [more available]' : ''),
      );
    } else {
      console.log(`CIN7 cron sales: caught up (${so.durationMs}ms)`);
    }
  } catch (e) {
    console.error('CIN7 cron sales failed:', redactSecrets(e?.message || String(e)));
  }
  // Credit notes chunk — serialised after sales so we never trip CIN7's
  // per-second rate limit by running both concurrently.
  try {
    const cn = await runCin7CreditNotesChunk(env);
    if (cn.rowsUpserted > 0) {
      console.log(
        `CIN7 cron credits: +${cn.rowsUpserted} credit notes, +${cn.itemsUpserted} items, ` +
        `watermark ${cn.watermarkBefore} → ${cn.watermarkAfter} (${cn.durationMs}ms)` +
        (cn.more ? ' [more available]' : ''),
      );
    } else {
      console.log(`CIN7 cron credits: caught up (${cn.durationMs}ms)`);
    }
  } catch (e) {
    console.error('CIN7 cron credits failed:', redactSecrets(e?.message || String(e)));
  }
}

// Weekly CIN7 safety-net (v2.2.50). Fires on its own cron trigger (Sunday
// 02:00 UTC) — a SEPARATE scheduled invocation from the every-15-min sync, so
// it has the full subrequest budget to itself. Re-fetches the last 60 days of
// SalesOrders by CreatedDate (sidestepping the ModifiedDate clusters that stall
// the incremental cron) and INSERT OR REPLACEs them, catching any historical
// hole the incremental path missed. Idempotent; safe to run anytime.
//
// Dispatch (see scheduled()) matches the known-good 15-min trigger explicitly
// and routes every OTHER trigger here, so it's robust to however Cloudflare
// normalizes the weekly cron string.
const FIFTEEN_MIN_CRON = '*/15 * * * *';

async function runCin7SafetyNetCron(env) {
  if (!env.DB) {
    console.log('CIN7 safety-net skipped: DB binding not configured');
    return;
  }
  if (!(env.CIN7_USERNAME && env.CIN7_CONNECTION_KEY)) {
    console.log('CIN7 safety-net skipped: secrets not configured');
    return;
  }
  try {
    const r = await runCin7SafetyNetBackfill(env, { sinceDays: 60 });
    console.log(
      `CIN7 safety-net: swept ${r.pagesFetched} page(s) since ${r.sinceISO}, ` +
      `+${r.rowsUpserted} orders re-synced, +${r.itemsUpserted} items` +
      (r.more ? ' [window not fully covered this run — hit page cap]' : '') +
      ` (${r.durationMs}ms)`,
    );
  } catch (e) {
    console.error('CIN7 safety-net failed:', redactSecrets(e?.message || String(e)));
  }
}

async function runCronSync(env) {
  if (!env.DB) {
    console.log('cron sync skipped: DB binding not configured');
    return;
  }
  // All five jobs are independent — run in parallel so none blocks the
  // others. The staleness-gated ones (FBA inventory, SalesBinder) are
  // free no-ops on most ticks; only when the cached snapshot has aged past
  // the freshness threshold do they actually hit upstream.
  //   • Woo Orders              — every 15 min (cron cadence)
  //   • Amazon Orders+Reports   — every 15 min (cron cadence)
  //   • Amazon FBA Inventory    — refresh if >1h old
  //   • SalesBinder             — refresh if >4h old
  //   • CIN7 SalesOrders+CreditNotes — every 15 min (cron cadence, v2.36 Phase A)
  await Promise.allSettled([
    runWooCronSync(env),
    runAmazonCronSync(env),
    runAmazonInventoryCronSync(env),
    runSalesBinderCronSync(env),
    runCin7CronSync(env),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    // ctx.waitUntil keeps the work alive past the synchronous return so the
    // platform can manage handler lifetime cleanly. The weekly safety-net runs
    // on its own cron trigger (own invocation, own subrequest budget); every
    // other tick runs the normal 15-min sync.
    if (event.cron === FIFTEEN_MIN_CRON) {
      ctx.waitUntil(runCronSync(env));
    } else {
      // Any non-15-min trigger is the weekly safety-net.
      ctx.waitUntil(runCin7SafetyNetCron(env));
    }
  },
};
