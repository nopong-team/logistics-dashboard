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
// `packaging:v2` invalidates the v2.30 cache that classified P-BLANK-ENV-A1
// into `envelopes` instead of the bottom inventory-watchlist section. Bumping
// the key forces a fresh upstream pull on the first request after deploy
// rather than waiting for the 4h SALESBINDER_FRESH_MS window or a manual
// ?refresh=true. Bump again if the schema changes again.
const KV_INVENTORY_KEY = 'salesbinder:inventory';
const KV_PACKAGING_KEY = 'salesbinder:packaging:v2';

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
//
// `leadTimes` is a per-SKU lead-time override (in months) for the non-tin
// packaging items (envelopes, SRT trays, PCIs, blank cartons). Default lead
// time is 4 months until Lauren confirms supplier-specific timings — at which
// point we override here per SKU. Tins still use the hard-coded TIN_LEAD_TIME
// constant in the frontend (Guanqiao 4mo = 120d).
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
  // Per-SKU lead time overrides (months). Default is 4 if not listed.
  leadTimes: {
    // e.g. 'P-ENV-A1': 3,
    // e.g. 'NP_INSERTS': 2,
  },
};

// Default lead time (months) for non-tin paper packaging until Lauren
// confirms supplier-specific timings. Override per SKU via
// PACKAGING_OVERRIDES.leadTimes.
const PAPER_PACKAGING_DEFAULT_LEAD_MONTHS = 4;

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
    // Empty-response guard: a transient SalesBinder glitch that returns 200 with
    // an empty array must NOT overwrite a good snapshot with zero rows — that
    // would then be served as a real "0 stock" reading until the next 4h cron.
    // Keep the prior non-empty snapshot instead (flagged as a stale fallback).
    if (inventory.length === 0) {
      const prev = await env.CACHE.get(KV_INVENTORY_KEY, 'json');
      if (prev?.inventory?.length) {
        return { ...prev, staleFallback: true, note: 'upstream returned 0 items — kept prior snapshot' };
      }
    }
    await env.CACHE.put(KV_INVENTORY_KEY, JSON.stringify(result));
  }
  return result;
}

// Recognise non-tin paper packaging SKUs from the Paper Packaging Skus
// inventory list (Melanie shared 2026-05-08). Categorisation rules:
//   - P-CA-SRT-*               → per-scent SRT trays (e.g. P-CA-SRT-OG-NPO)
//   - P-ENV-*                  → active envelope pool (used for every Woo order)
//   - NP_INSERTS               → postcard inserts (PCIs)
//   - P-CA-BLANK-CTN-*SRT      → blank outer cartons (2- or 4-SRT)        ┐ inventory
//   - P-BLANK-ENV-*            → blank envelopes (backup, not in regular  │ watchlist
//                                rotation per Melanie 2026-05-08)         │ section
//   - NOPONG-PURO-BOXES        → Purolator boxes for well.ca (multiples   │
//                                of 4 cartons). Demand pattern unclear,   │
//                                so tracked here for visibility.          ┘
//
// The `blankCartons` bucket is the "inventory watchlist" section in the UI:
// items tracked for at-a-glance visibility but without a derived demand model.
// Blank envelopes and Purolator boxes belong here because they're either
// backup stock or have demand that doesn't trace cleanly through Woo/Xero.
function classifyNonTinPackaging(sku) {
  if (sku === 'NP_INSERTS') return 'inserts';
  if (/^P-CA-BLANK-CTN-\d+SRT$/i.test(sku)) return 'blankCartons';
  if (/^P-BLANK-ENV-/.test(sku))            return 'blankCartons';
  if (sku === 'NOPONG-PURO-BOXES')          return 'blankCartons';
  if (/^P-CA-SRT-/.test(sku))               return 'srt';
  if (/^P-ENV-/.test(sku))                  return 'envelopes';
  return null;
}

// Parse the scent/form linkage from an SRT packaging SKU. e.g.
//   P-CA-SRT-OG-NPO   → { scent: 'OG', form: 'NPO', linkedTinSku: 'CA-OG-NPO-35' }
//   P-CA-SRT-SS       → { scent: 'SS', form: '',    linkedTinSku: '' }  (Secret Scenta — no single tin)
//   P-CA-SRT-CL-VLB   → { scent: 'CL', form: 'VLB', linkedTinSku: 'CA-CL-VLB-35' }
function parseSrtLinkage(sku) {
  const m = sku.match(/^P-CA-SRT-([A-Z]{2})(?:-([A-Z]{2,3}))?$/);
  if (!m) return { scent: '', form: '', linkedTinSku: '' };
  const [, scent, form] = m;
  const linkedTinSku = form ? `CA-${scent}-${form}-35` : '';
  return { scent, form: form || '', linkedTinSku };
}

function paperLeadTimeFor(sku) {
  return PACKAGING_OVERRIDES.leadTimes?.[sku] ?? PAPER_PACKAGING_DEFAULT_LEAD_MONTHS;
}

async function fetchAndCachePackaging(env) {
  const { items, pagesFetched } = await fetchAllItems(env);

  const tins = [];
  const envelopes = [];
  const srt = [];
  const inserts = [];
  const blankCartons = [];

  for (const item of items) {
    const sku = (item.sku || '').trim();

    const qty = parseFloat(item.quantity || 0);
    const reserved = parseFloat(item.quantity_reserved || 0);
    const incoming = parseFloat(item.quantity_incoming || 0);
    const threshold = parseFloat(item.low_threshold || 0);
    const cost = parseFloat(item.cost || 0);
    const category = item.category?.name || item.category || '';
    const baseRecord = {
      sku,
      name: item.name || '',
      description: item.description || '',
      onHand: qty,
      reserved,
      available: qty - reserved,
      incoming,
      lowThreshold: threshold,
      unitCost: cost,
      category,
    };

    if (sku.startsWith('T-')) {
      const linkedSku = sku.substring(2);
      let size = '';
      const m = sku.match(/-(\d+)$/);
      if (m) size = `${m[1]}g`;
      tins.push({ ...baseRecord, linkedSku, size });
      continue;
    }

    const kind = classifyNonTinPackaging(sku);
    if (!kind) continue;

    const leadTimeMonths = paperLeadTimeFor(sku);

    if (kind === 'srt') {
      const { scent, form, linkedTinSku } = parseSrtLinkage(sku);
      srt.push({ ...baseRecord, scent, form, linkedTinSku, leadTimeMonths });
    } else if (kind === 'blankCartons') {
      // e.g. P-CA-BLANK-CTN-4SRT → 4 SRTs per carton
      const m = sku.match(/-(\d+)SRT$/i);
      const srtCapacity = m ? parseInt(m[1], 10) : 0;
      blankCartons.push({ ...baseRecord, srtCapacity, leadTimeMonths });
    } else if (kind === 'envelopes') {
      envelopes.push({ ...baseRecord, leadTimeMonths });
    } else if (kind === 'inserts') {
      inserts.push({ ...baseRecord, leadTimeMonths });
    }
  }

  const result = {
    tins,
    envelopes,
    srt,
    inserts,
    blankCartons,
    count: tins.length,
    extrasCount: envelopes.length + srt.length + inserts.length + blankCartons.length,
    source: 'salesbinder',
    supplier: 'Guanqiao Tinbox Co., Limited',
    leadTimeDays: 120,
    paperLeadTimeMonthsDefault: PAPER_PACKAGING_DEFAULT_LEAD_MONTHS,
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

// Cached payloads from before the v2.31 endpoint expansion only have `tins`
// — no envelopes/srt/inserts/blankCartons fields. Treat any such payload as
// stale so the first request after deploy triggers a fresh upstream pull.
function cachedPackagingHasExtras(cached) {
  return cached
    && Array.isArray(cached.envelopes)
    && Array.isArray(cached.srt)
    && Array.isArray(cached.inserts)
    && Array.isArray(cached.blankCartons);
}

// Default the four extras arrays to [] so the frontend can read them
// unconditionally even if the cache predates the v2.31 schema.
function withExtrasDefaults(payload) {
  return {
    envelopes: [],
    srt: [],
    inserts: [],
    blankCartons: [],
    ...payload,
  };
}

salesBinderRoutes.get('/packaging', async (c) => {
  const forceRefresh = c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_PACKAGING_KEY, 'json');
    if (cached?.tins?.length && cachedPackagingHasExtras(cached)) {
      return c.json({
        ...withExtrasDefaults(cached),
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
      ...withExtrasDefaults(result),
      cached: false,
      tins: applyPackagingOverrides(result.tins),
    });
  } catch (e) {
    if (cache) {
      const cached = await cache.get(KV_PACKAGING_KEY, 'json');
      if (cached?.tins?.length) {
        return c.json({
          ...withExtrasDefaults(cached),
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
