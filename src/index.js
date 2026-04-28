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

const app = new Hono();

// Health check — survives from the Step 3 hello-world.
app.get('/api/ping', (c) => c.json({ hello: 'world' }));

// WooCommerce routes (Step 4: /api/woo/sales as a 30-day live fetch with KV cache).
app.route('/api/woo', wooRoutes);

// Catch-all 404 for unknown /api/* paths and any non-asset path.
app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404));

// Error handler — log full detail to observability, return a generic message.
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ error: 'internal error', detail: err.message }, 500);
});

export default app;
