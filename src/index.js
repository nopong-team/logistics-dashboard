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
import { wooRoutes } from './woo.js';
import { adminRoutes } from './admin.js';

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

// Error handler — log full detail to observability, return a generic message.
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'internal error', detail: err.message }, 500);
});

export default app;
