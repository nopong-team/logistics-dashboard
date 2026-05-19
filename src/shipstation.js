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
  };
  if (!env.SHIPSTATION_API_KEY || !env.SHIPSTATION_API_SECRET) {
    return { ...zero, error: 'SHIPSTATION_API_KEY and/or SHIPSTATION_API_SECRET not configured' };
  }
  try {
    const [openOrders, shipments] = await Promise.all([
      listAwaitingShipment(env),
      listShipmentsForLocalDate(env, localDate),
    ]);

    let shippedTodayItems = 0;
    for (const s of shipments) {
      const items = Array.isArray(s?.shipmentItems) ? s.shipmentItems : [];
      for (const it of items) {
        shippedTodayItems += Number(it?.quantity || 0);
      }
    }

    // Express / international open orders — surfaced as a flagship alert on
    // the tab. We capture lightweight summaries (not the full order) so the
    // frontend can render an inline list without dragging PII.
    const expressIntlSummaries = [];
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
    }

    return {
      connected: true,
      error: null,
      openOrders: openOrders.length,
      shippedTodayOrders: shipments.length,
      shippedTodayItems,
      expressIntlOpen: expressIntlSummaries.length,
      expressIntlOpenOrders: expressIntlSummaries,
    };
  } catch (e) {
    return { ...zero, error: redactSecrets(e?.message || String(e)) };
  }
}
