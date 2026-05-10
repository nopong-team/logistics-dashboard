/**
 * CIN7 Omni connector + AU dashboard data routes.
 *
 * Phase 2 of the AU rollout — replaces the static `/au-data.js` snapshot for
 * the Inventory tab with a live read from CIN7 Omni. Sales / POs / refunds
 * still ship from the static `window.AU_DATA` for now (those endpoints come
 * in the next PRs).
 *
 *   GET /api/au/cin7/status
 *     Smallest possible proof-of-life. Hits /Branches with rows=1 and reports
 *     {connected, branchCount, error}. No KV cache. Useful for smoke-testing
 *     the Wrangler secrets after `npx wrangler secret put`.
 *
 *   GET /api/au/inventory
 *     Live inventory rows in the same shape as window.AU_DATA.inventory:
 *       { sku, name, category, kind, mult, soh, avail, incoming,
 *         fba_cin7, fba_amz: null, discontinued }
 *     Built from CIN7 /Products + /Stock with the AU SKU normalisation rules
 *     codified in `AU Dashboard/au-sku-rules.md`. KV-cached at `au:inventory`
 *     (15-min TTL); pass ?refresh=1 to bypass.
 *
 * Auth model. CIN7 Omni uses HTTP Basic — API username + connection key — set
 * up in CIN7 → Integrations → API. Both go in as Wrangler secrets:
 *
 *   npx wrangler secret put CIN7_USERNAME
 *   npx wrangler secret put CIN7_CONNECTION_KEY
 *
 * Pagination. Omni's `/Products`, `/Stock`, `/SalesOrders`, `/PurchaseOrders`
 * use `page` (1-indexed) and `rows` (max 250). Bare-JSON-array responses;
 * stop when a page returns fewer rows than requested. We cap at 200 pages
 * (50,000 records) as a safety belt against a misbehaving upstream.
 *
 * No `Buffer` on Workers — base64 the credential pair with `btoa()` instead.
 * Parked Express version of this client lives at `backend/server.js` in the
 * Drive project folder; this is the Workers port + extension to inventory.
 */

import { Hono } from 'hono';

export const auRoutes = new Hono();

// ─── KV cache ───────────────────────────────────────────────────────────────

const KV_INVENTORY_KEY = 'au:inventory:v1';
// 15 min TTL — short enough that drift is bounded but long enough to absorb
// dashboard refreshes on the same minute. Bump the key suffix (v1 → v2) on
// any schema change so we don't return mismatched-shape cached payloads.
const INVENTORY_TTL_SECONDS = 15 * 60;

// ─── CIN7 Omni client ──────────────────────────────────────────────────────

const CIN7_BASE = 'https://api.cin7.com/api/v1';
const PAGE_SIZE = 250;
const MAX_PAGES = 200; // 50k records — soft cap

function cin7AuthHeader(env) {
  const user = (env.CIN7_USERNAME || '').trim();
  const key  = (env.CIN7_CONNECTION_KEY || '').trim();
  if (!user || !key) return null;
  return 'Basic ' + btoa(`${user}:${key}`);
}

function cin7Configured(env) {
  return !!cin7AuthHeader(env);
}

// Fetch a single CIN7 page. `endpoint` is the leaf path (e.g. 'Stock').
// Throws on non-200 with the upstream status + a truncated body for debugging.
// The credential pair is in the Authorization header — never in the URL —
// so a thrown error message can't leak it.
async function cin7Fetch(env, endpoint, params = {}) {
  const auth = cin7AuthHeader(env);
  if (!auth) {
    throw new Error(
      'CIN7 not configured. Set CIN7_USERNAME and CIN7_CONNECTION_KEY ' +
      'with `npx wrangler secret put`.',
    );
  }
  const qs = new URLSearchParams({ page: 1, rows: PAGE_SIZE, ...params }).toString();
  const url = `${CIN7_BASE}/${endpoint}?${qs}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`CIN7 ${endpoint}: ${resp.status} ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// Paginate a CIN7 endpoint until a page comes back short. Returns the flat
// array of all records. `params` is merged into every request.
async function cin7FetchAll(env, endpoint, params = {}) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await cin7Fetch(env, endpoint, { ...params, page, rows: PAGE_SIZE });
    if (!Array.isArray(items)) break;
    all.push(...items);
    if (items.length < PAGE_SIZE) break; // last page
  }
  return all;
}

// ─── AU SKU normalization (mirrors AU Dashboard/au-sku-rules.md) ───────────
//
// Returns [base_sku, multiplier_in_tins]. Pass-through for unknown patterns.
// Keep in sync with AU Dashboard/scripts/build_data.py:normalize_sku() — both
// implementations need the same rules or live and static numbers won't match.
function normalizeAuSku(sku) {
  const s = (sku || '').trim();
  if (!s) return [null, 1];
  // Wholesale carton (Woo): WC-AU-...-(NL|WC|nothing) = ×54
  let m = s.match(/^WC-(AU-.+?)(?:-(?:NL|WC))?$/);
  if (m) return [m[1], 54];
  // Retailer carton: AU-CTN-...-48 = ×48 → base is AU-...-35
  m = s.match(/^AU-CTN-(.+)-48$/);
  if (m) return [`AU-${m[1]}-35`, 48];
  // Mixed mega-tray: AU-CTN-SRT-MIX-... = ×72 (no rollup)
  if (s.startsWith('AU-CTN-SRT-MIX-')) return [s, 72];
  // Shelf-ready tray: AU-SRT-...x12 = ×12
  m = s.match(/^AU-SRT-(.+)x12$/);
  if (m) return [`AU-${m[1].replace(/-+$/, '')}`, 12];
  // Subscription -M = ×1
  m = s.match(/^(AU-.+)M$/);
  if (m) return [m[1], 1];
  return [s, 1];
}

// Discontinued lines per Melanie 2026-05-10. Spicy Chai (SC) is end-of-life
// but stays as inventory rows so we can run down stock. Tagged + sunk to the
// bottom in the UI.
const DISCONTINUED_PATTERNS = [
  /^AU-(?:CTN-|B-)?SC-/,
  /^D-AU-SC-/,
];
function isDiscontinued(sku) {
  return DISCONTINUED_PATTERNS.some((re) => re.test(sku));
}

// ─── Stock + Products ingestion ────────────────────────────────────────────

// Stock comes back per (productOption × branch). The CSV pipeline (build_data.py)
// reads SKU-level totals from CIN7's stock-by-branch CSV, but the API gives us
// per-branch rows that we need to aggregate. AmazonFBA branch is captured
// separately so we can compare it against the Amazon SP-API truth (Phase 3)
// and surface drift in the Inventory tab.
async function fetchStockBySku(env) {
  const fields = [
    'productId', 'productOptionId', 'modifiedDate', 'styleCode', 'code', 'barcode',
    'branchId', 'branchName', 'productName',
    'option1', 'option2', 'option3',
    'available', 'stockOnHand', 'openSalesOrders', 'openPurchaseOrders',
    'virtual', 'holding',
  ].join(',');
  const stockRows = await cin7FetchAll(env, 'Stock', { fields });

  const bySku = new Map();
  for (const row of stockRows) {
    const code = (row.code || row.styleCode || '').trim();
    if (!code) continue;
    const acc = bySku.get(code) || {
      code,
      name: '',
      soh: 0,
      avail: 0,
      incoming: 0,
      fba: 0,
    };
    // Per-branch values accumulate
    acc.soh      += Number(row.stockOnHand)      || 0;
    acc.avail    += Number(row.available)        || 0;
    acc.incoming += Number(row.openPurchaseOrders) || 0;
    if ((row.branchName || '').toLowerCase() === 'amazonfba') {
      acc.fba += Number(row.stockOnHand) || 0;
    }
    if (!acc.name && row.productName) {
      const opt = [row.option1, row.option2, row.option3].filter(Boolean).join(' / ');
      acc.name = (opt ? `${row.productName} — ${opt}` : row.productName).slice(0, 60);
    }
    bySku.set(code, acc);
  }
  return bySku; // Map<sku, { code, name, soh, avail, incoming, fba }>
}

// Products gives us category / status. We need this to filter the inventory
// rows down to Finished Products + Bicarb Based + uncategorised (which is how
// build_data.py does it). Returns Map<sku, { category, status }>.
async function fetchProductMeta(env) {
  const fields = [
    'id', 'styleCode', 'name', 'status',
    'category', 'productType', 'productOptions',
  ].join(',');
  const products = await cin7FetchAll(env, 'Products', { fields });

  const meta = new Map();
  for (const p of products) {
    const opts = Array.isArray(p.productOptions) && p.productOptions.length ? p.productOptions : null;
    if (opts) {
      for (const o of opts) {
        const code = (o.code || p.styleCode || '').trim();
        if (!code) continue;
        meta.set(code, {
          category: p.category || '',
          status: o.status || p.status || '',
        });
      }
    } else {
      const code = (p.styleCode || '').trim();
      if (code) meta.set(code, { category: p.category || '', status: p.status || '' });
    }
  }
  return meta;
}

// Build the inventory list in the shape window.AU_DATA.inventory has today.
// Mirrors AU Dashboard/scripts/build_data.py:build_inventory():
//   • Folds AU-SRT-...x12 rows into their base SKU as ×12 tins (SOH + avail).
//   • Drops AU-CTN-SRT-MIX-* (mixed mega-trays — handled in Packaging).
//   • Drops CANVAS / AU-BAG codes (apparel / merch).
//   • Filters to category in {Finished Products, Bicarb Based, ''} (uncategorised).
//   • Tags AU-CTN-* as kind:'carton', AU-B-* as kind:'base-b', else kind:'base'.
//   • Marks Spicy Chai SKUs as discontinued.
function buildInventory(stockBySku, productMeta) {
  // First pass: SRT rollup — find AU-SRT-...x12 rows and accumulate their
  // contribution (×12 tins) onto the matching base SKU. Drop SRT rows that
  // don't have a base in stock (orphan trays — rare but possible).
  const srtExtraSoh   = new Map();
  const srtExtraAvail = new Map();
  for (const [code, s] of stockBySku.entries()) {
    if (!code.startsWith('AU-SRT-') || code.startsWith('AU-CTN-SRT-')) continue;
    const [base, mult] = normalizeAuSku(code);
    if (!base || !stockBySku.has(base)) continue;
    srtExtraSoh.set(base,   (srtExtraSoh.get(base)   || 0) + (s.soh   * mult));
    srtExtraAvail.set(base, (srtExtraAvail.get(base) || 0) + (s.avail * mult));
  }

  const out = [];
  for (const [code, s] of stockBySku.entries()) {
    if (!code.startsWith('AU-')) continue;
    if (code.includes('CANVAS') || code.startsWith('AU-BAG')) continue;
    if (code.startsWith('AU-SRT-') || code.startsWith('AU-CTN-SRT-')) continue;

    const meta = productMeta.get(code) || {};
    const cat = meta.category || '';
    if (cat && cat !== 'Finished Products' && cat !== 'Bicarb Based') continue;

    let kind, mult;
    if (code.startsWith('AU-CTN-')) { kind = 'carton'; mult = 48; }
    else if (code.startsWith('AU-B-')) { kind = 'base-b'; mult = 1; }
    else { kind = 'base'; mult = 1; }

    out.push({
      sku:           code,
      name:          s.name,
      category:      cat,
      kind,
      mult,
      soh:           s.soh   + (srtExtraSoh.get(code)   || 0),
      avail:         s.avail + (srtExtraAvail.get(code) || 0),
      incoming:      s.incoming,
      fba_cin7:      s.fba,    // CIN7's mirror of Amazon FBA — drift detection
      fba_amz:       null,     // SP-API truth — Phase 3
      discontinued:  isDiscontinued(code),
    });
  }
  // Stable order: discontinued sink to bottom, otherwise SOH desc.
  out.sort((a, b) => {
    if (a.discontinued !== b.discontinued) return a.discontinued ? 1 : -1;
    return (b.soh || 0) - (a.soh || 0);
  });
  return out;
}

// Single entry point. Pulls Stock + Products in parallel, builds inventory.
// Returns the payload we cache + serve.
async function buildAuInventoryPayload(env) {
  const [stockBySku, productMeta] = await Promise.all([
    fetchStockBySku(env),
    fetchProductMeta(env),
  ]);
  const inventory = buildInventory(stockBySku, productMeta);
  return {
    inventory,
    lastSync: new Date().toISOString(),
    source:   'cin7-live',
    counts: {
      stockSkus:    stockBySku.size,
      productSkus:  productMeta.size,
      inventoryRows: inventory.length,
    },
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Smallest proof-of-life. Hits /Branches with rows=1 — cheapest call we can
// make against Omni — and returns whether creds work + how many branches the
// account has. Used for smoke-testing after `wrangler secret put`.
auRoutes.get('/cin7/status', async (c) => {
  if (!cin7Configured(c.env)) {
    return c.json({
      connected: false,
      reason: 'CIN7_USERNAME and/or CIN7_CONNECTION_KEY not set as Wrangler secrets',
    });
  }
  try {
    const branches = await cin7Fetch(c.env, 'Branches', { rows: 1 });
    return c.json({
      connected: true,
      branchCount: Array.isArray(branches) ? branches.length : 0,
    });
  } catch (e) {
    return c.json({ connected: false, reason: String(e?.message || e) });
  }
});

// Live inventory. KV-cached for 15 min; pass ?refresh=1 to bypass and force
// a fresh upstream pull. Falls back to cache (with `staleFallback: true`) on
// upstream error so the dashboard always has something usable to render.
auRoutes.get('/inventory', async (c) => {
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  const cache = c.env.CACHE;

  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_INVENTORY_KEY, 'json');
    if (cached?.inventory?.length) {
      return c.json({ ...cached, cached: true });
    }
  }

  try {
    const payload = await buildAuInventoryPayload(c.env);
    if (cache) {
      await cache.put(KV_INVENTORY_KEY, JSON.stringify(payload), {
        expirationTtl: INVENTORY_TTL_SECONDS,
      });
    }
    return c.json({ ...payload, cached: false });
  } catch (e) {
    if (cache) {
      const cached = await cache.get(KV_INVENTORY_KEY, 'json');
      if (cached?.inventory?.length) {
        return c.json({
          ...cached,
          cached: true,
          staleFallback: true,
          error: 'Upstream CIN7 error — serving cached snapshot.',
        });
      }
    }
    throw e; // global onError sanitizes + returns 500
  }
});
