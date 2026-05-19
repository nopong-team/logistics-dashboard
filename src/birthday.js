/**
 * AU 11th Birthday launch tab — endpoint + helpers.
 *
 * Surfaces a real-time view of Thursday 2026-05-21's launch:
 *   - All Woo orders today + a per-hour bar.
 *   - Orders containing the launch products (soap AU-BD-NPS-100, tin AU-BD-NBF-35).
 *   - Soap units sold *lifetime* (stock-tracker mode — soap soft-launches the
 *     night before tins, so today-only would miss the early sales).
 *   - Tin units sold today.
 *   - ShipStation snapshot (open / shipped today / express+intl alert).
 *   - Next-hourly-drop timestamp for the countdown widget.
 *
 * Data source: LIVE WooCommerce REST + LIVE ShipStation v2. NOT D1 — the
 * cron's watermark lag (up to 15min) is too high for launch-day visibility.
 * KV cache at `au:birthday-launch:v1` with a 60-second TTL — short enough
 * that two refreshes from different tabs see the same fresh data, long
 * enough to absorb a thundering-herd if a few people open the page at once.
 *
 * Owned by Melanie. v2.2.21.
 */

import { Hono } from 'hono';
import { buildShipStationSnapshot } from './shipstation.js';
import { redactSecrets } from './redact.js';

export const birthdayRoutes = new Hono();

// ─── Config ────────────────────────────────────────────────────────────────

// SKUs that count as "launch products". Update here if marketing renames.
const SOAP_SKU = 'AU-BD-NPS-100';
const TIN_SKU  = 'AU-BD-NBF-35';
const LAUNCH_SKUS = new Set([SOAP_SKU, TIN_SKU]);

// Woo product category slug (and human name) for the belt-and-braces filter.
// Caught when a line item's SKU is missing or has been edited but the product
// is still tagged into the 11th-birthday category in Woo.
const LAUNCH_CATEGORY_NAMES = ['11th birthday', 'birthday', '11th-birthday'];

// KV cache for the combined payload — short TTL because this is real-time.
const KV_KEY = 'au:birthday-launch:v1';
const KV_TTL_SECONDS = 60;

// ─── Sydney timezone helpers ───────────────────────────────────────────────

/**
 * Get the Sydney UTC offset in minutes for a given instant. Australia/Sydney
 * is +10:00 (AEST) outside DST and +11:00 (AEDT) during DST. DST runs from
 * the first Sunday of October to the first Sunday of April (Southern
 * Hemisphere). We use Intl.DateTimeFormat with shortOffset where supported,
 * and fall back to the deterministic Sun-Oct → Sun-Apr rule if Intl is
 * unavailable.
 */
function sydneyOffsetMinutes(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Sydney',
      timeZoneName: 'shortOffset',
    });
    const parts = fmt.formatToParts(date);
    const tz = parts.find(p => p.type === 'timeZoneName')?.value;
    const m = tz?.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (m) {
      const sign = m[1] === '+' ? 1 : -1;
      return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
    }
  } catch (_) { /* fall through */ }
  // Fallback: compute DST window manually.
  const year = date.getUTCFullYear();
  const oct = new Date(Date.UTC(year, 9, 1));
  const octFirstSunday = 1 + ((7 - oct.getUTCDay()) % 7);
  const apr = new Date(Date.UTC(year, 3, 1));
  const aprFirstSunday = 1 + ((7 - apr.getUTCDay()) % 7);
  // 2am Sydney clock-time → 16:00 UTC the previous day (AEST) for start,
  // 3am AEDT → 16:00 UTC the previous day for end (close enough — DST switch
  // hour ambiguity isn't load-bearing for this use case).
  const dstStart = Date.UTC(year, 9, octFirstSunday - 1, 16, 0, 0);
  const dstEnd   = Date.UTC(year, 3, aprFirstSunday - 1, 16, 0, 0);
  const t = date.getTime();
  return (t < dstEnd || t >= dstStart) ? 660 : 600;
}

/**
 * Return Sydney-local date components for the given UTC instant.
 *   { year, month, day, hour, minute, second, localDate (YYYY-MM-DD), tzOffsetMinutes }
 */
function sydneyParts(date = new Date()) {
  const offset = sydneyOffsetMinutes(date);
  const shifted = new Date(date.getTime() + offset * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();
  const ss = shifted.getUTCSeconds();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: y,
    month: m,
    day: d,
    hour: hh,
    minute: mm,
    second: ss,
    localDate: `${y}-${pad(m)}-${pad(d)}`,
    localTime: `${pad(hh)}:${pad(mm)}:${pad(ss)}`,
    tzOffsetMinutes: offset,
  };
}

/** UTC ISO timestamp for Sydney-local YYYY-MM-DD HH:mm:ss. */
function sydneyToUtcIso(localDate, localTime, offsetMinutes) {
  const baseUtc = new Date(`${localDate}T${localTime}Z`);
  return new Date(baseUtc.getTime() - offsetMinutes * 60 * 1000).toISOString();
}

/**
 * Compute the next "drop" timestamp — top of each hour from 7:00 to 17:00
 * AEST/AEDT. If the current Sydney time is before 7am, the next drop is
 * today 07:00. If after 17:00, the next drop is tomorrow 07:00. Otherwise
 * it's the top of the next hour.
 *
 * Returns ISO UTC string for the next drop, plus the human-readable Sydney
 * time for display.
 */
function computeNextDrop(now = new Date()) {
  const s = sydneyParts(now);
  let nextHour, nextDate;
  if (s.hour < 7) {
    nextHour = 7;
    nextDate = s.localDate;
  } else if (s.hour >= 17) {
    // After 17:00 — next drop is tomorrow 07:00.
    nextHour = 7;
    const tomorrow = new Date(Date.UTC(s.year, s.month - 1, s.day + 1));
    const t = sydneyParts(tomorrow);
    nextDate = t.localDate;
  } else {
    nextHour = s.hour + 1;
    nextDate = s.localDate;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const nextLocal = `${pad(nextHour)}:00:00`;
  return {
    next_drop_at_iso: sydneyToUtcIso(nextDate, nextLocal, s.tzOffsetMinutes),
    next_drop_local: `${nextDate} ${nextLocal} AEST`,
    next_drop_hour: nextHour,
    current_sydney_local: `${s.localDate} ${s.localTime} AEST`,
    in_window: s.hour >= 7 && s.hour < 17,
  };
}

// ─── Woo client (live REST) ────────────────────────────────────────────────

async function wooFetch(env, endpoint, params = {}) {
  const url = new URL(`/wp-json/wc/v3${endpoint}`, env.WOO_AU_URL);
  url.searchParams.set('consumer_key', env.WOO_AU_KEY);
  url.searchParams.set('consumer_secret', env.WOO_AU_SECRET);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let resp;
  try {
    resp = await fetch(url.toString());
  } catch (e) {
    throw new Error(`Woo AU fetch failed: ${redactSecrets(e?.message || e)}`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Woo AU ${resp.status} on ${endpoint}: ${redactSecrets(body).substring(0, 300)}`);
  }
  return {
    data: await resp.json(),
    totalPages: parseInt(resp.headers.get('x-wp-totalpages') || '1', 10),
    total: parseInt(resp.headers.get('x-wp-total') || '0', 10),
  };
}

/**
 * Fetch every Woo order with date_created >= `afterNaiveLocal` (paginated).
 *
 * WooCommerce's REST API takes `after` as an ISO 8601 string BUT interprets
 * it as naive store-local time — even if a `Z` is appended, the offset is
 * ignored. (Cross-referenced against src/admin.js's `runBackfillChunk`,
 * which also uses naive-local watermarks like `1970-01-01T00:00:00`.)
 *
 * So `afterNaiveLocal` must be a naive ISO string in the store's timezone
 * (Australia/Sydney for AU). Passing a UTC-flavoured `...Z` here makes Woo
 * read it as the same wall-clock moment in Sydney, which is wrong by the
 * AEST/AEDT offset — produces a window that starts 10–11 hours earlier than
 * intended and leaks the previous day's late-afternoon orders into "today".
 *
 * Stops at MAX_PAGES as a safety belt.
 */
async function fetchOrdersSince(env, afterNaiveLocal, { perPage = 100, maxPages = 10 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, totalPages } = await wooFetch(env, '/orders', {
      after: afterNaiveLocal,
      status: 'any',
      per_page: perPage,
      page,
      orderby: 'date',
      order: 'asc',
    });
    all.push(...data);
    if (page >= totalPages) break;
  }
  return all;
}

/**
 * Read Woo's product info for a single SKU — used for three birthday-tab
 * needs:
 *   - lifetime sold (`total_sales`) for the soap stock-tracker card
 *   - featured image URL for the TV view thumbnails (v2.2.25)
 *   - stock_quantity for the "X in stock" readout + sell-out confetti
 *     trigger (v2.2.26)
 *
 * Woo's product object carries `total_sales` which increments as orders
 * move into processing / completed status — close enough to "lifetime sold"
 * for a stock-tracker read-out (Melanie's call on 2026-05-19). The
 * `images` array holds the gallery; we take `images[0].src` as the
 * featured image. `stock_quantity` is only meaningful when `manage_stock`
 * is true; we pass both through so the frontend can render "not tracked"
 * vs "0 left" appropriately.
 *
 * Returns { totalSales, imageUrl, stockQuantity, stockStatus, manageStock }.
 * All default to safe values if the SKU isn't found.
 */
async function fetchWooProductInfo(env, sku) {
  const { data } = await wooFetch(env, '/products', { sku, per_page: 5 });
  if (!Array.isArray(data) || data.length === 0) {
    return { totalSales: 0, imageUrl: null, stockQuantity: null, stockStatus: null, manageStock: false };
  }
  // Sum total_sales across matches (covers variations / multi-product SKU collisions).
  const totalSales = data.reduce((acc, p) => acc + Number(p?.total_sales || 0), 0);
  // First product with a non-empty image wins. Most cases there's only one
  // match anyway; this is just defensive.
  const imageUrl = data.find(p => p?.images?.[0]?.src)?.images?.[0]?.src || null;
  // Stock fields — use the first product's values. If multiple match (rare),
  // sum stock_quantity so a parent + variant collision doesn't hide stock.
  const primary = data[0] || {};
  const manageStock = !!primary.manage_stock;
  const stockStatus = primary.stock_status || null;
  // Sum stock_quantity across managed products (null values skipped). If
  // none of the matches manage stock, stockQuantity is null (= not tracked).
  let stockQuantity = null;
  for (const p of data) {
    if (p?.manage_stock && p?.stock_quantity != null) {
      stockQuantity = (stockQuantity || 0) + Number(p.stock_quantity);
    }
  }
  return { totalSales, imageUrl, stockQuantity, stockStatus, manageStock };
}

// ─── Order analysis ────────────────────────────────────────────────────────

function lineItemMatchesLaunch(item) {
  // Match by SKU first — fast, explicit.
  if (item?.sku && LAUNCH_SKUS.has(item.sku)) {
    return { match: true, sku: item.sku };
  }
  // Fall back to category match. Woo includes the product's category list as
  // `categories` (slug + name) on the line item only sometimes — the REST
  // /orders payload usually has the product *name* but not its taxonomy. So
  // this branch fires when SKU is missing and the item name itself contains
  // "Birthday" — a soft heuristic, deliberately permissive.
  const name = (item?.name || '').toLowerCase();
  for (const cat of LAUNCH_CATEGORY_NAMES) {
    if (name.includes(cat.toLowerCase())) {
      return { match: true, sku: item?.sku || `category:${cat}` };
    }
  }
  return { match: false };
}

/**
 * Reduce today's Woo orders into the metrics the dashboard renders. All
 * timestamps are bucketed by SYDNEY local hour (0–23), not UTC, so the
 * "orders per hour" chart aligns with what Melanie sees on the wall clock.
 */
function summariseTodayOrders(orders) {
  const hourlyBuckets = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
  let totalOrders = 0;
  let ordersWithLaunch = 0;
  let tinUnitsToday = 0;
  // Soap units today (for the launch-day breakdown — distinct from lifetime).
  let soapUnitsToday = 0;

  for (const o of orders) {
    totalOrders++;
    // Bucket by Sydney-local hour. Woo's `date_created` is naive-local at the
    // store's configured timezone (Australia/Sydney for the AU store), so we
    // can read the HH directly off `date_created` without conversion.
    const hh = parseInt((o?.date_created || '').substring(11, 13), 10);
    if (!Number.isNaN(hh) && hh >= 0 && hh < 24) {
      hourlyBuckets[hh].count++;
    }
    let orderHasLaunch = false;
    for (const item of (o.line_items || [])) {
      const m = lineItemMatchesLaunch(item);
      if (!m.match) continue;
      orderHasLaunch = true;
      const qty = Number(item?.quantity || 0);
      if (item?.sku === TIN_SKU)  tinUnitsToday  += qty;
      if (item?.sku === SOAP_SKU) soapUnitsToday += qty;
    }
    if (orderHasLaunch) ordersWithLaunch++;
  }
  return { totalOrders, ordersWithLaunch, tinUnitsToday, soapUnitsToday, hourlyBuckets };
}

// ─── Endpoint ──────────────────────────────────────────────────────────────

birthdayRoutes.get('/birthday-launch', async (c) => {
  const env = c.env;
  const forceRefresh = c.req.query('refresh') === '1' || c.req.query('refresh') === 'true';
  const cache = env.CACHE;

  // KV cache check.
  if (!forceRefresh && cache) {
    const cached = await cache.get(KV_KEY, 'json');
    if (cached?.generated_at_iso) {
      return c.json({ ...cached, cached: true });
    }
  }

  // Verify Woo AU credentials are present — without them, we can't fetch
  // anything. Surface a clear actionable error instead of a generic 500.
  if (!env.WOO_AU_URL || !env.WOO_AU_KEY || !env.WOO_AU_SECRET) {
    return c.json({
      error: 'Woo AU not configured. Set WOO_AU_URL, WOO_AU_KEY, WOO_AU_SECRET via wrangler secret put.',
    }, 503);
  }

  const now = new Date();
  const syd = sydneyParts(now);
  // Sydney midnight today, in naive-local format (no Z, no offset) — see
  // fetchOrdersSince header for why WC needs this and not a UTC ISO.
  const todayStartLocalNaive = `${syd.localDate}T00:00:00`;
  // UTC equivalent — surfaced in the response's `window` block for debugging.
  const todayStartUtcIso = sydneyToUtcIso(syd.localDate, '00:00:00', syd.tzOffsetMinutes);
  const drop = computeNextDrop(now);

  // Run Woo orders + Woo product info (soap + tin) + ShipStation concurrently.
  // Four independent reads against independent upstreams. v2.2.25 added the
  // separate tin product fetch to grab the tin's featured-image URL for the
  // TV-view thumbnail (paired with the existing soap fetch).
  const [ordersResult, soapInfoResult, tinInfoResult, shipstationSnap] = await Promise.allSettled([
    fetchOrdersSince(env, todayStartLocalNaive),
    fetchWooProductInfo(env, SOAP_SKU),
    fetchWooProductInfo(env, TIN_SKU),
    buildShipStationSnapshot(env, {
      localDate: syd.localDate,
      tzOffsetMinutes: syd.tzOffsetMinutes,
    }),
  ]);

  // Woo orders — if this fails, the whole tab fails (it's the load-bearing
  // part of the view). Surface the error instead of pretending it succeeded.
  if (ordersResult.status === 'rejected') {
    return c.json({
      error: 'Woo AU orders fetch failed.',
      detail: redactSecrets(ordersResult.reason?.message || String(ordersResult.reason)),
    }, 502);
  }
  const orders = ordersResult.value;
  const summary = summariseTodayOrders(orders);

  // Soap + tin product info — soft-degrade: if either errors, fall back to
  // zeros / null image and surface the error message rather than blowing up
  // the whole tab.
  const FALLBACK_INFO = { totalSales: 0, imageUrl: null, stockQuantity: null, stockStatus: null, manageStock: false };
  const soapInfo = soapInfoResult.status === 'fulfilled' ? soapInfoResult.value : FALLBACK_INFO;
  const soapLifetimeError = soapInfoResult.status === 'rejected'
    ? redactSecrets(soapInfoResult.reason?.message || String(soapInfoResult.reason))
    : null;
  const tinInfo = tinInfoResult.status === 'fulfilled' ? tinInfoResult.value : FALLBACK_INFO;
  const tinInfoError = tinInfoResult.status === 'rejected'
    ? redactSecrets(tinInfoResult.reason?.message || String(tinInfoResult.reason))
    : null;

  // ShipStation — already returns its own connected/error envelope.
  const shipstation = shipstationSnap.status === 'fulfilled'
    ? shipstationSnap.value
    : { connected: false, error: 'ShipStation aggregator threw.' };

  const payload = {
    generated_at_iso: now.toISOString(),
    sydney_now: {
      local_date: syd.localDate,
      local_time: syd.localTime,
      tz_offset_minutes: syd.tzOffsetMinutes,
    },
    window: {
      from_iso: todayStartUtcIso,
      to_iso:   now.toISOString(),
    },
    drop, // { next_drop_at_iso, next_drop_local, next_drop_hour, current_sydney_local, in_window }
    woo: {
      total_orders_today: summary.totalOrders,
      orders_with_launch_products: summary.ordersWithLaunch,
      soap_units_lifetime: soapInfo.totalSales,
      soap_units_today:    summary.soapUnitsToday,
      tin_units_today:     summary.tinUnitsToday,
      orders_per_hour:     summary.hourlyBuckets,
      soap_sku: SOAP_SKU,
      tin_sku:  TIN_SKU,
      soap_image_url: soapInfo.imageUrl,
      tin_image_url:  tinInfo.imageUrl,
      // v2.2.26 — stock_quantity readout + sell-out confetti trigger.
      // `null` means stock isn't being tracked for this SKU in Woo; the
      // frontend treats that as a non-actionable state (no confetti).
      soap_stock_quantity: soapInfo.stockQuantity,
      soap_stock_status:   soapInfo.stockStatus,
      soap_manage_stock:   soapInfo.manageStock,
      tin_stock_quantity:  tinInfo.stockQuantity,
      tin_stock_status:    tinInfo.stockStatus,
      tin_manage_stock:    tinInfo.manageStock,
      soap_lifetime_error: soapLifetimeError,
      tin_info_error: tinInfoError,
    },
    shipstation,
  };

  // Persist to KV (best-effort — don't block response on a slow KV write).
  if (cache) {
    c.executionCtx?.waitUntil?.(
      cache.put(KV_KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_SECONDS }),
    );
  }

  return c.json({ ...payload, cached: false });
});
