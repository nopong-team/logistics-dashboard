/**
 * Logiwa routes for the Logistics Dashboard.
 *
 * Logiwa is the warehouse management system for No Pong Canada's 3PL stock.
 * Unlike every other connector in this Worker, there is NO upstream API we
 * pull from — the ops team exports an inventory snapshot from the Logiwa UI
 * (an .xlsx or .csv) and uploads it through the dashboard. The dashboard's
 * existing `handleLogiwaUpload` (in public/index.html) parses the file
 * client-side with SheetJS, maps the raw columns to a normalised
 * { sku, name, total, available, damaged } shape, then POSTs the parsed
 * JSON to /api/logiwa/inventory.
 *
 * That client-side-parse + POST-JSON shape is what the legacy
 * backend/server.js implemented and what we mirror here verbatim — no
 * server-side parsing, no R2, no D1. The whole snapshot lives in a single
 * KV value under `logiwa:inventory:current`, overwritten on every upload.
 *
 * Endpoints
 *
 *   POST /api/logiwa/inventory
 *     Body: { inventory: [...], uploadedAt?: ISO, fileName?: string }
 *     Validates shape (inventory is a non-empty array, every row has a sku)
 *     and stores the snapshot in KV. Returns { saved, count, fileName,
 *     uploadedAt }. The legacy frontend already POSTs to this exact path
 *     with this exact body — no frontend change needed.
 *
 *   GET /api/logiwa/inventory
 *     Returns the stored snapshot, or { inventory: null, message: '...' }
 *     if nothing has been uploaded yet (legacy shape — the dashboard's
 *     loadLogiwaInventory() reads this and short-circuits cleanly when
 *     inventory is null).
 *
 *   GET /api/logiwa/test
 *     Connectivity-style check. Returns { connected, count?, fileName?,
 *     uploadedAt? }. Mirrors /api/salesbinder/test, /api/amazon/test, etc.
 *
 * Auth
 *
 * No ADMIN_KEY gate. The route is gated by Cloudflare Access at the edge
 * (logistics.apps.nopong.com is behind the No Pong Internal Apps Landing
 * Access app), so anyone with an authenticated @nopong.com Google account
 * can upload from the dashboard. The workers.dev URL bypasses Access but
 * isn't published; if curl-upload becomes a real workflow later, add
 * /api/admin/logiwa/upload as a separate ADMIN_KEY-gated mirror.
 *
 * Bindings (in wrangler.jsonc)
 *
 *   CACHE — KV namespace, used here as the snapshot store.
 *
 * No new secrets, no new bindings, no new migrations.
 */

import { Hono } from 'hono';

export const logiwaRoutes = new Hono();

// Single KV key — Logiwa stock is point-in-time, not append-only, so each
// upload fully replaces the previous snapshot.
const KV_KEY = 'logiwa:inventory:current';
const LOGIWA_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // flag an upload as stale after 7 days

// Defensive caps. The current Logiwa export is a few hundred rows × ~5 fields,
// well under both — but rejecting absurd payloads up front keeps a misbehaving
// upload from churning a Worker invocation.
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB serialized JSON
const MAX_ROWS  = 50_000;          // sanity ceiling — current snapshots ~200 rows

// ─── POST /api/logiwa/inventory ─────────────────────────────────────────────

logiwaRoutes.post('/inventory', async (c) => {
  const cache = c.env.CACHE;
  if (!cache) return c.json({ error: 'KV CACHE binding missing' }, 500);

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const inventory = Array.isArray(body?.inventory) ? body.inventory : null;
  if (!inventory) {
    return c.json({ error: 'inventory must be an array' }, 400);
  }
  if (inventory.length === 0) {
    return c.json({ error: 'inventory is empty' }, 400);
  }
  if (inventory.length > MAX_ROWS) {
    return c.json({ error: `inventory too large (${inventory.length} rows > ${MAX_ROWS})` }, 413);
  }

  // Light shape check — every row needs a non-empty sku string. Numeric fields
  // (total, available, damaged) are optional; the legacy parser sets them to 0
  // when the corresponding column isn't present in the export.
  for (const row of inventory) {
    if (!row || typeof row.sku !== 'string' || !row.sku.trim()) {
      return c.json({ error: 'every inventory row must have a non-empty sku string' }, 400);
    }
  }

  const snapshot = {
    inventory,
    uploadedAt: typeof body?.uploadedAt === 'string' && body.uploadedAt
      ? body.uploadedAt
      : new Date().toISOString(),
    fileName: typeof body?.fileName === 'string' && body.fileName
      ? body.fileName
      : 'unknown',
    count: inventory.length,
    storedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(snapshot);
  if (json.length > MAX_BYTES) {
    return c.json({ error: `snapshot too large (${json.length} bytes > ${MAX_BYTES})` }, 413);
  }

  await cache.put(KV_KEY, json);

  return c.json({
    saved: true,
    count: inventory.length,
    fileName: snapshot.fileName,
    uploadedAt: snapshot.uploadedAt,
  });
});

// ─── GET /api/logiwa/inventory ──────────────────────────────────────────────

logiwaRoutes.get('/inventory', async (c) => {
  const cache = c.env.CACHE;
  if (!cache) return c.json({ error: 'KV CACHE binding missing' }, 500);

  const snapshot = await cache.get(KV_KEY, 'json');
  if (!snapshot?.inventory?.length) {
    // Legacy null-shape — dashboard's loadLogiwaInventory() reads
    // data.inventory and short-circuits if falsy.
    return c.json({ inventory: null, message: 'No inventory uploaded yet' });
  }
  // Logiwa is upload-only (no cron), so an old upload keeps serving as "live"
  // forever. Surface its age + a stale flag past 7 days so the UI can flag it
  // rather than feed a weeks-old 3PL count into the SOH comparison as current.
  const ageMs = snapshot.uploadedAt ? (Date.now() - new Date(snapshot.uploadedAt).getTime()) : null;
  return c.json({ ...snapshot, ageMs, stale: ageMs != null && ageMs > LOGIWA_STALE_AFTER_MS });
});

// ─── GET /api/logiwa/test ───────────────────────────────────────────────────

logiwaRoutes.get('/test', async (c) => {
  const cache = c.env.CACHE;
  if (!cache) return c.json({ connected: false, error: 'KV CACHE binding missing' });
  try {
    const snapshot = await cache.get(KV_KEY, 'json');
    if (snapshot?.inventory?.length) {
      return c.json({
        connected: true,
        count: snapshot.inventory.length,
        fileName: snapshot.fileName || null,
        uploadedAt: snapshot.uploadedAt || null,
        storedAt: snapshot.storedAt || null,
      });
    }
    return c.json({ connected: false, message: 'No Logiwa snapshot uploaded yet' });
  } catch (e) {
    return c.json({ connected: false, error: String(e?.message || e) });
  }
});

// ─── /api/status helper ─────────────────────────────────────────────────────

/**
 * Cheap snapshot-presence read for /api/status. Returns the legacy-compatible
 * shape ({ connected, source: 'csv-upload', ... }) plus enough metadata for
 * the dashboard's source-freshness UI to render "Last upload: <file> on
 * <date>" without a second roundtrip. Wrapped in try/catch so a KV hiccup
 * can't take /api/status down — the trap memory note for /api/status's
 * everything-or-nothing semantics still applies.
 */
export async function readLogiwaStatus(env) {
  const baseShape = { connected: false, source: 'csv-upload' };
  if (!env.CACHE) return baseShape;
  try {
    const snapshot = await env.CACHE.get(KV_KEY, 'json');
    if (!snapshot?.inventory?.length) return baseShape;
    const ageMs = snapshot.uploadedAt ? (Date.now() - new Date(snapshot.uploadedAt).getTime()) : null;
    return {
      ...baseShape,
      connected: true,
      count: snapshot.inventory.length,
      fileName: snapshot.fileName || null,
      uploadedAt: snapshot.uploadedAt || null,
      ageMs,
      stale: ageMs != null && ageMs > LOGIWA_STALE_AFTER_MS,
    };
  } catch {
    return baseShape;
  }
}
