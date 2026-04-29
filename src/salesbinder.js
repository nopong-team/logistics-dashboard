/**
 * SalesBinder routes for the Logistics Dashboard.
 *
 * Two endpoints, both ports of the legacy backend/server.js logic:
 *
 *   GET /api/salesbinder/inventory
 *     Finished-goods inventory snapshot. Pulls all items, filters out
 *     packaging/manufacturing/labels, returns { sku, name, quantity, category }
 *     per item. The dashboard's stock-discrepancy check (SalesBinder vs Logiwa
 *     vs FBA) reads this.
 *
 *   GET /api/salesbinder/packaging
 *     Tin packaging snapshot. Pulls SKUs with `T-` prefix, returns full detail
 *     (onHand, reserved, available, incoming, lowThreshold, unitCost, etc.).
 *     Applies the baked-in PACKAGING_OVERRIDES on every response — these
 *     handle SKUs SalesBinder doesn't know are retired (excludeSkus) and
 *     per-SKU re-purposing flags (leBlank, custom names) that aren't first-
 *     class concepts in SalesBinder. Edit the constant below + redeploy when
 *     these change.
 *
 * Both routes:
 *   - Cache the upstream response in KV indefinitely (matches legacy semantics
 *     — the cache only refreshes when the user explicitly passes ?refresh=true,
 *     or when the cached value is missing/empty). Snapshot is "weekly"-ish in
 *     the legacy comment, but in practice updates happen via manual reconcile
 *     workflows so on-demand refresh is the right rhythm.
 *   - Fall back to the cache if SalesBinder is unreachable, with `cached: true`
 *     and `staleFallback: true` flags so the dashboard can flag this in the UI
 *     if it wants.
 *   - Sanitize errors via the global onError handler in src/index.js — no
 *     credential bytes leak.
 *
 * Secrets (Wrangler secrets, never in git):
 *   SALESBINDER_SUBDOMAIN  — e.g. "nopong" → https://nopong.salesbinder.com
 *   SALESBINDER_API_KEY    — Basic auth username; password is literally "x"
 *
 * Bindings (in wrangler.jsonc):
 *   CACHE — KV namespace used as the inventory cache.
 */

import { Hono } from 'hono';

export const salesBinderRoutes = new Hono();

// KV cache keys.
const KV_INVENTORY_KEY = 'salesbinder:inventory';
const KV_PACKAGING_KEY = 'salesbinder:packaging';

// Categories we DON'T want in the finished-goods inventory tile. Mirrors the
// legacy filter — packaging/manufacturing line items would otherwise pollute
// the SOH discrepancy check.
const SKIP_CATEGORIES = ['packaging', 'manufacturing'];

// Polite pacing between paginated calls (matches legacy 500ms).
const PAGE_DELAY_MS = 500;

// Safety cap so a misbehaving SalesBinder can't pin a Worker for >25s.
const MAX_PAGES = 50;

// Baked-in packaging overrides. Mirrors backend/packaging-overrides.json
// from the legacy server. Edit + redeploy to change. Auto-derived
// committedToPetra is computed in the frontend (see legacy code comment).
const PACKAGING_OVERRIDES = {
  excludeSkus: ['T-CA-EF-BCF-35'],
  perSku: {
    'T-CA-BLANK-35': { leBlank: true },
    'T-CA-FP-VLB-35': {
      leBlank: true,
      name: 'Empty Tins for FP-VLB (retired — re-used as LE blanks)',
      description:
        'FP-VLB discontinued — these tins are re-purposed as limited-edition 35g ' +
        'blank stock. Stickered for LE SKUs only, never pooled with regular branded 35g.',
    },
  },
};

// Fields managed exclusively by overrides (or computed in the frontend).
// Stripped from every cached tin before per-SKU overrides are applied — this
// way a stale `committedToPetra: true` baked into an old cache entry can't
// poison the response after the override is removed.
const MANAGED_TIN_FIELDS = ['committedToPetra', 'leBlank'];

function applyPackagingOverrides(tins) {
  const excluded = new Set(PACKAGING_OVERRIDES.excludeSkus || []);
  const perSku = PACKAGING_OVERRIDES.perSku || {};
  return tins
    .filter((t) => !excluded.has(t.sku))
    .map((t) => {
      const cleaned = { ...t };
      for (const f of MANAGED_TIN_FIELDS) delete cleaned[f];
      return perSku[t.sku] ? { ...cleaned, ...perSku[t.sku] } : cleaned;
    });
}

// SalesBinder API helper. Basic auth with the API key as the username and the
// literal string "x" as the password. Auth lives in the header — never in the
// URL — so even if fetch() throws we don't leak credentials in err.message.
async function sbFetch(env, endpoint, params = {}) {
  const subdomain = env.SALESBINDER_SUBDOMAIN;
  const apiKey = env.SALESBINDER_API_KEY;
  if (!subdomain || !apiKey) {
    throw new Error(
      'SalesBinder not configured. Set SALESBINDER_SUBDOMAIN and SALESBINDER_API_KEY ' +
      'with `npx wrangler secret put`.',
    );
  }

  const url = new URL(`/api/2.0${endpoint}`, `https://${subdomain}.salesbinder.com`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const auth = btoa(`${apiKey}:x`);
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SalesBinder ${resp.status} on ${endpoint}: ${body.substring(0, 300)}`);
  }
  return resp.json();
}

// SalesBinder paginated /items.json fetch. The response shape is annoyingly
// inconsistent — sometimes {items: [[...]]}, sometimes {items: [...]}, and
// sometimes a bare array. Legacy server.js handles all three; mirror that.
async function fetchAllItems(env) {
  const all = [];
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await sbFetch(env, '/items.json', {
      page: String(page),
      perPage: '100',
    });

    let items = [];
    if (Array.isArray(data?.items) && Array.isArray(data.items[0])) {
      items = data.items[0];
    } else if (Array.isArray(data?.items)) {
      items = data.items;
    } else if (Array.isArray(data)) {
      items = data;
    }
    if (items.length === 0) break;

    for (const raw of items) all.push(raw.Item || raw);

    const totalPages = parseInt(data?.pages || 1, 10);
    if (page >= totalPages) break;

    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return { items: all, pagesFetched: page };
}

// Inventory + packaging refresh helpers. Extracted so the cron can call them
// without going through the route handler. Returns the result object that gets
// cached (and surfaced via the route).
async function fetchAndCacheInventory(env) {
  const { items, pagesFetched } = await fetchAllItems(env);

  const inventory = [];
  for (const item of items) {
    const category = (item.category?.name || item.category || '').toLowerCase();
    const sku = (item.sku || '').trim();
    if (SKIP_CATEGORIES.some((cat) => category.includes(cat))) continue;
    if (sku.startsWith('Label-') || sku.startsWith('MF-')) continue;

    const total = parseFloat(item.quantity || 0);
    const reserved = parseFloat(item.quantity_reserved || 0);
    inventory.push({
      sku,
      name: item.name || '',
      quantity: total - reserved,
      category: item.category?.name || item.category || '',
    });
  }

  const result = {
    inventory,
    count: inventory.length,
    source: 'salesbinder',
    pagesFetched,
    lastSync: new Date().toISOString(),
  };
  if (env.CACHE) {
    await env.CACHE.put(KV_INVENTORY_KEY, JSON.stringify(result));
  }
  return result;
}

async function fetchAndCachePackaging(env) {
  const { items, pagesFetched } = await fetchAllItems(env);

  const tins = [];
  for (const item of items) {
    const sku = (item.sku || '').trim();
    if (!sku.startsWith('T-')) continue;

    const qty = parseFloat(item.quantity || 0);
    const reserved = parseFloat(item.quantity_reserved || 0);
    const incoming = parseFloat(item.quantity_incoming || 0);
    const threshold = parseFloat(item.low_threshold || 0);
    const cost = parseFloat(item.cost || 0);

    const linkedSku = sku.startsWith('T-') ? sku.substring(2) : sku;
    let size = '';
    const m = sku.match(/-(\d+)$/);
    if (m) size = `${m[1]}g`;

    tins.push({
      sku, linkedSku, size,
      name: item.name || '',
      description: item.description || '',
      onHand: qty,
      reserved,
      available: qty - reserved,
      incoming,
      lowThreshold: threshold,
      unitCost: cost,
      category: item.category?.name || item.category || '',
    });
  }

  const result = {
    tins,
    count: tins.length,
    source: 'salesbinder',
    supplier: 'Guanqiao Tinbox Co., Limited',
    leadTimeDays: 120,
    pagesFetched,
    lastSync: new Date().toISOString(),
  };
  if (env.CACHE) {
    await env.CACHE.put(KV_PACKAGING_KEY, JSON.stringify(result));
  }
  return result;
}

// ─── SalesBinder cron sync ──────────────────────────────────────────────────
//
// Runs from the scheduled handler (src/index.js) every 15 min. SalesBinder
// inventory doesn't change second-to-second, so we gate on a 4h staleness
// threshold — so worst-case staleness is ~4h, which is plenty fresh for "what's
// in the warehouse" while keeping the SalesBinder API call rate negligible.
// Inventory + packaging are pulled together (one SalesBinder paginated
// /items.json call covers both, but the legacy route shape keeps them
// separately cached, so we make two pulls — both still cheap, ~1-3s total).
const SALESBINDER_FRESH_MS = 4 * 60 * 60 * 1000; // 4h

export async function runSalesBinderCronSync(env) {
  if (!(env.SALESBINDER_SUBDOMAIN && env.SALESBINDER_API_KEY)) {
    return; // not configured — silent skip
  }
  if (!env.CACHE) return;

  const now = Date.now();
  const [invCached, pkgCached] = await Promise.all([
    env.CACHE.get(KV_INVENTORY_KEY, 'json'),
    env.CACHE.get(KV_PACKAGING_KEY, 'json'),
  ]);
  const invAgeMs = invCached?.lastSync ? now - new Date(invCached.lastSync).getTime() : Infinity;
  const pkgAgeMs = pkgCached?.lastSync ? now - new Date(pkgCached.lastSync).getTime() : Infinity;

  const tasks = [];
  if (invAgeMs >= SALESBINDER_FRESH_MS) {
    tasks.push(
      fetchAndCacheInventory(env)
        .then((r) => console.log(`SalesBinder cron: inventory refreshed (${r.count} rows)`))
        .catch((e) => console.error('SalesBinder cron inventory failed:', e?.message)),
    );
  }
  if (pkgAgeMs >= SALESBINDER_FRESH_MS) {
    tasks.push(
      fetchAndCachePackaging(env)
        .then((r) => console.log(`SalesBinder cron: packaging refreshed (${r.count} tin SKUs)`))
        .catch((e) => console.error('SalesBinder cron packaging failed:', e?.message)),
    );
  }
  if (tasks.length === 0) return;
  await Promise.allSettled(tasks);
}

// ─── /api/salesbinder/inventory ─────────────────────────────────────────────

salesBinderRoutes.get('/inventory', async (c) => {
  const forceRefresh = c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_INVENTORY_KEY, 'json');
    if (cached?.inventory?.length) {
      return c.json({ ...cached, cached: true });
    }
  }

  try {
    const result = await fetchAndCacheInventory(c.env);
    return c.json({ ...result, cached: false });
  } catch (e) {
    // Fall back to cache on upstream error so the dashboard keeps a usable view.
    if (cache) {
      const cached = await cache.get(KV_INVENTORY_KEY, 'json');
      if (cached?.inventory?.length) {
        return c.json({
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream SalesBinder error — serving cached snapshot.',
        });
      }
    }
    throw e; // let global onError sanitize + return 500
  }
});

// ─── /api/salesbinder/packaging ─────────────────────────────────────────────

salesBinderRoutes.get('/packaging', async (c) => {
  const forceRefresh = c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_PACKAGING_KEY, 'json');
    if (cached?.tins?.length) {
      return c.json({
        ...cached,
        cached: true,
        tins: applyPackagingOverrides(cached.tins),
      });
    }
  }

  try {
    // Cache the RAW SalesBinder response (so future reads see real upstream
    // data), but apply overrides on the response we actually send out.
    const result = await fetchAndCachePackaging(c.env);
    return c.json({
      ...result,
      cached: false,
      tins: applyPackagingOverrides(result.tins),
    });
  } catch (e) {
    if (cache) {
      const cached = await cache.get(KV_PACKAGING_KEY, 'json');
      if (cached?.tins?.length) {
        return c.json({
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream SalesBinder error — serving cached snapshot.',
          tins: applyPackagingOverrides(cached.tins),
        });
      }
    }
    throw e;
  }
});

// Lightweight connection test — fetches just the first page with perPage=1
// so it doesn't pull the whole catalogue. Used by smoke-tests during onboarding.
salesBinderRoutes.get('/test', async (c) => {
  try {
    const data = await sbFetch(c.env, '/items.json', { page: '1', perPage: '1' });
    return c.json({
      connected: true,
      totalItems: data?.count ?? null,
      pages: data?.pages ?? null,
    });
  } catch (e) {
    // Don't throw — the legacy /test endpoint returned a JSON body even on
    // failure so the frontend can show "couldn't connect" without a 500.
    return c.json({ connected: false, error: String(e?.message || e) });
  }
});
