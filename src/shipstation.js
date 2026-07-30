/**
 * ShipStation client for the AU 11th-birthday launch tab.
 *
 * Built against ShipStation API v1 (ssapi.shipstation.com, HTTP Basic auth
 * with API Key + API Secret). v2 was scoped initially but Melanie confirmed
 * on 2026-05-19 that their account uses v1 — different base URL, different
 * auth, different field naming (camelCase, not snake_case).
 *
 * Bindings (in wrangler.jsonc):
 *   CACHE                    — KV namespace used as a read-through cache.
 *   SHIPSTATION_API_KEY      — set via `wrangler secret put`.
 *   SHIPSTATION_API_SECRET   — set via `wrangler secret put`.
 *
 * Cache TTL: 5 minutes on the combined birthday-launch payload (set in the
 * route handler, not here). This module exposes raw fetch helpers and a
 * single `buildShipStationSnapshot()` aggregator. No D1 writes.
 *
 * Rate limits: ShipStation v1 is documented at 40 requests / 40 seconds per
 * API key with X-Rate-Limit headers on every response. We're nowhere near
 * that — one tab refresh fires 2 calls (orders + shipments) so even at the
 * tight 2-min cadence we're at 1 call/min.
 */

import { redactSecrets } from './redact.js';

// ─── Config ─────────────────────────────────────────────────────────────────

const SS_V1_BASE = 'https://ssapi.shipstation.com';

// ShipStation store id for "AU Woo LIVE" (WooCommerce, https://www.nopong.com.au),
// confirmed from GET /stores on 2026-07-30. Used for the on-hold KPI box so it
// counts ONLY the live Woo store — never "AU Woo Staging" (337135) or any other
// store. If the store is ever recreated in ShipStation, re-check the id via the
// /api/au/logistics/ss-stores diagnostic and update this constant.
const WOO_LIVE_STORE_ID = 341347;

// Service code / requested-service patterns that indicate an Express /
// faster-than-standard shipping option. Matched case-insensitively against
// ShipStation v1's `serviceCode` and `requestedShippingService` fields. Add
// new patterns here as we encounter them rather than scattering string checks.
const EXPRESS_SERVICE_PATTERNS = [
  'express',
  'overnight',
  'priority',
  'next_day',
  'next-day',
  'nextday',
  'expedited',
];

// Shipping-to country that counts as domestic. Anything else is international.
function isInternational(country) {
  if (!country) return false;
  return String(country).trim().toUpperCase() !== 'AU';
}

// Wholesale SKU patterns. An open order is "wholesale" if any of its line
// items match one of these:
//   WC-*    — wholesale custom (e.g. WC-OG-NPO-35)
//   *-SRT-* — sleeve / tray packs (e.g. AU-SRT-x12)
//   *-CTN-* — cartons (e.g. AU-CTN-48, where most AU wholesale volume lives)
//
// Per Melanie 2026-05-19: ShipStation's WC integration doesn't reliably
// expose Woo's "wholesale" product category, so SKU-pattern detection is
// the most robust route. Patterns are case-insensitive.
const WHOLESALE_SKU_PATTERNS = [
  /^WC-/i,
  /-SRT-/i,
  /-CTN-/i,
];

function matchedWholesaleSku(sku) {
  if (!sku) return false;
  for (const pat of WHOLESALE_SKU_PATTERNS) {
    if (pat.test(sku)) return true;
  }
  return false;
}

/**
 * Return the de-duplicated list of wholesale-matching SKUs on an order. An
 * empty list means the order isn't wholesale. Used to surface the actual
 * SKU(s) on the alert card so the fulfilment team knows what's in the box.
 */
function wholesaleSkusFor(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const matched = new Set();
  for (const item of items) {
    if (matchedWholesaleSku(item?.sku)) matched.add(item.sku);
  }
  return Array.from(matched);
}

function isExpressService(order) {
  // ShipStation v1 carries the requested service on these fields.
  const fields = [
    order?.requestedShippingService,
    order?.serviceCode,
    order?.carrierCode,
  ];
  for (const f of fields) {
    if (!f) continue;
    const lower = String(f).toLowerCase();
    for (const pat of EXPRESS_SERVICE_PATTERNS) {
      if (lower.includes(pat)) return true;
    }
  }
  return false;
}

// ─── HTTP helper (Basic auth) ──────────────────────────────────────────────

async function ssFetch(env, path, params = {}) {
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    throw new Error(
      'ShipStation not configured: SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET both required. ' +
      'Run commands/set-shipstation-key.command to set both.',
    );
  }
  const url = new URL(SS_V1_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  // Basic auth — base64(key:secret). Workers has `btoa()`; no Buffer.
  const auth = btoa(`${env.SHIPSTATION_API_KEY}:${env.SHIPSTATION_API_SECRET}`);
  let resp;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    throw new Error(
      `ShipStation fetch failed (unreachable host?). Underlying: ${redactSecrets(e?.message || e)}`,
    );
  }
  if (!resp.ok) {
    const body = await resp.text();
    // 401 here almost always means the key/secret pair is wrong — surface a
    // clear actionable message rather than leaking the v1 error body.
    if (resp.status === 401) {
      throw new Error(
        'ShipStation 401 Unauthorized. Re-run commands/set-shipstation-key.command and confirm both ' +
        'API Key and API Secret are pasted exactly from Account → API Settings.',
      );
    }
    throw new Error(
      `ShipStation ${resp.status} on ${path}: ${redactSecrets(body).substring(0, 300)}`,
    );
  }
  return resp.json();
}

// ─── Endpoint wrappers (v1) ────────────────────────────────────────────────

/**
 * List orders awaiting shipment. ShipStation v1 paginates via `page` +
 * `pageSize` (max 500). We iterate until total pages consumed, capped at
 * `maxPages` as a safety belt.
 *
 * v1 response shape: { orders: [...], total, page, pages }
 */
async function listAwaitingShipment(env, { maxPages = 10, pageSize = 500 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await ssFetch(env, '/orders', {
      orderStatus: 'awaiting_shipment',
      page,
      pageSize,
      sortBy: 'OrderDate',
      sortDir: 'DESC',
    });
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    all.push(...orders);
    const totalPages = data?.pages || 1;
    if (page >= totalPages) break;
  }
  return all;
}

/**
 * List shipments for a single local date (YYYY-MM-DD). ShipStation v1 uses
 * `shipDateStart` / `shipDateEnd` — these are plain YYYY-MM-DD strings, not
 * timestamps; the API interprets them in the account's local timezone (which
 * for No Pong AU is Australia/Sydney, set in ShipStation settings). We pass
 * the Sydney-local date and v1 does the right thing.
 *
 * `voided=false` filters out cancelled shipments so the count reflects real
 * fulfilment activity, not voided labels.
 *
 * v1 response shape: { shipments: [{ shipmentItems: [...], ... }], total, page, pages }
 */
async function listShipmentsForLocalDate(env, localDate, { maxPages = 10, pageSize = 500 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await ssFetch(env, '/shipments', {
      shipDateStart: localDate,
      shipDateEnd: localDate,
      voided: 'false',
      includeShipmentItems: 'true',
      page,
      pageSize,
    });
    const shipments = Array.isArray(data?.shipments) ? data.shipments : [];
    all.push(...shipments);
    const totalPages = data?.pages || 1;
    if (page >= totalPages) break;
  }
  return all;
}

/**
 * List all ShipStation stores (v1 `GET /stores`). Returns a trimmed shape —
 * enough to identify which store is "Woo Live" vs "Woo Staging" without
 * leaking secrets. `showInactive=true` so a paused store still shows.
 * v1 returns a bare array (not the paginated { ... } wrapper).
 */
export async function listShipStationStores(env) {
  const data = await ssFetch(env, '/stores', { showInactive: 'true' });
  const stores = Array.isArray(data) ? data : (Array.isArray(data?.stores) ? data.stores : []);
  return stores.map((s) => ({
    store_id: s?.storeId ?? null,
    store_name: s?.storeName ?? null,
    marketplace: s?.marketplaceName ?? null,
    account_name: s?.accountName ?? null,
    integration_url: s?.integrationUrl ?? null,
    active: s?.active ?? null,
  }));
}

/**
 * Count orders in ShipStation with orderStatus=on_hold for ONE store.
 *
 * NOTE (2026-07-30): the v1 `/orders?storeId=<id>` server-side filter does NOT
 * reliably narrow the result — a query for the Woo LIVE store came back with
 * the on-hold total across ALL stores (7 = 4 LIVE + 3 Staging). So instead of
 * trusting `total`, we fetch the on-hold orders (a small set) and count the
 * ones whose own store id matches, client-side. Each v1 order carries its
 * store under `advancedOptions.storeId` (with a top-level `storeId` fallback).
 */
export async function countOnHoldOrdersForStore(env, storeId) {
  if (!storeId) return 0;
  const wanted = Number(storeId);
  let count = 0;
  for (let page = 1; page <= 10; page++) {
    const data = await ssFetch(env, '/orders', {
      orderStatus: 'on_hold',
      page,
      pageSize: 500,
    });
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    for (const o of orders) {
      const sid = Number(o?.advancedOptions?.storeId ?? o?.storeId ?? NaN);
      if (sid === wanted) count++;
    }
    const totalPages = data?.pages || 1;
    if (page >= totalPages) break;
  }
  return count;
}

/**
 * Diagnostic: on-hold order count grouped by store id (client-side), so we can
 * confirm the per-store split matches ShipStation's UI. Returns { "<id>": n }.
 */
export async function onHoldStoreBreakdown(env) {
  const byStore = {};
  for (let page = 1; page <= 10; page++) {
    const data = await ssFetch(env, '/orders', { orderStatus: 'on_hold', page, pageSize: 500 });
    const orders = Array.isArray(data?.orders) ? data.orders : [];
    for (const o of orders) {
      const sid = String(o?.advancedOptions?.storeId ?? o?.storeId ?? 'unknown');
      byStore[sid] = (byStore[sid] || 0) + 1;
    }
    if (page >= (data?.pages || 1)) break;
  }
  return byStore;
}

// ─── Public aggregator ─────────────────────────────────────────────────────

/**
 * Build the ShipStation slice of the birthday-launch payload.
 *
 * Returns { connected, error?, openOrders, shippedTodayOrders, shippedTodayItems, expressIntlOpen, expressIntlOpenOrders }.
 * On any error (missing keys, 401, network) we return `{ connected: false,
 * error: '...', ...zeros }` so the dashboard zone can still render — the
 * frontend then dims the box and shows the error message.
 *
 * `localDate` and `tzOffsetMinutes` are passed in from the caller (the
 * birthday-launch route handler computes them once for both Woo and SS). v1
 * doesn't actually need `tzOffsetMinutes` since it operates on local-date
 * strings, but we accept it for interface symmetry with the v2 build.
 */
export async function buildShipStationSnapshot(env, { localDate /*, tzOffsetMinutes */ }) {
  const zero = {
    connected: false,
    error: null,
    openOrders: 0,
    shippedTodayOrders: 0,
    shippedTodayItems: 0,
    expressIntlOpen: 0,
    expressIntlOpenOrders: [],
    wholesaleOpen: 0,
    wholesaleOpenOrders: [],
    wooLiveOnHold: null,
  };
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    return { ...zero, error: 'SHIPSTATION_API_KEY and/or SHIPSTATION_API_SECRET not configured' };
  }
  try {
    const [openOrders, shipments, wooLiveOnHold] = await Promise.all([
      listAwaitingShipment(env),
      listShipmentsForLocalDate(env, localDate),
      // On-hold count for the AU Woo LIVE store only. Best-effort: on any error
      // it resolves to null so the other KPIs still render (box shows "—").
      countOnHoldOrdersForStore(env, WOO_LIVE_STORE_ID).catch(() => null),
    ]);

    let shippedTodayItems = 0;
    for (const s of shipments) {
      const items = Array.isArray(s?.shipmentItems) ? s.shipmentItems : [];
      for (const it of items) {
        shippedTodayItems += Number(it?.quantity || 0);
      }
    }

    // Express / international + wholesale open orders — surfaced as two
    // alert cards on the tab. One pass over the open queue populates both;
    // an order can be both express and wholesale (and appear in both lists).
    // We capture lightweight summaries (not the full order) so the frontend
    // can render an inline list without dragging PII.
    const expressIntlSummaries = [];
    const wholesaleSummaries = [];
    for (const o of openOrders) {
      const country = o?.shipTo?.country;
      const intl = isInternational(country);
      const exp  = isExpressService(o);
      if (intl || exp) {
        expressIntlSummaries.push({
          order_number: o?.orderNumber || o?.orderId || null,
          ship_to_country: country || null,
          service: o?.requestedShippingService || o?.serviceCode || null,
          flags: [intl ? 'INTL' : null, exp ? 'EXPRESS' : null].filter(Boolean),
        });
      }
      const wsSkus = wholesaleSkusFor(o);
      if (wsSkus.length > 0) {
        // Company comes from billTo.company first (the invoiced entity, which
        // is what wholesale flags like Waiva Clark care about), falling back
        // to shipTo.company (some orders only set the destination side) and
        // finally customerUsername (rare, but covers the legacy import path).
        const company =
          o?.billTo?.company ||
          o?.shipTo?.company ||
          o?.customerUsername ||
          null;
        wholesaleSummaries.push({
          order_number: o?.orderNumber || o?.orderId || null,
          ship_to_country: country || null,
          service: o?.requestedShippingService || o?.serviceCode || null,
          wholesale_skus: wsSkus,
          company,
        });
      }
    }

    return {
      connected: true,
      error: null,
      openOrders: openOrders.length,
      shippedTodayOrders: shipments.length,
      shippedTodayItems,
      expressIntlOpen: expressIntlSummaries.length,
      expressIntlOpenOrders: expressIntlSummaries,
      wholesaleOpen: wholesaleSummaries.length,
      wholesaleOpenOrders: wholesaleSummaries,
      wooLiveOnHold,
    };
  } catch (e) {
    return { ...zero, error: redactSecrets(e?.message || String(e)) };
  }
}
