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
 * Fetch every Woo order with date_created >= `afterIsoUtc` (paginated).
 * `afterIsoUtc` is a UTC ISO string — we convert to the WC `after` filter
 * format (which accepts ISO 8601). Stops at MAX_PAGES as a safety belt.
 */
async function fetchOrdersSince(env, afterIsoUtc, { perPage = 100, maxPages = 10 } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data, totalPages } = await wooFetch(env, '/orders', {
      after: afterIsoUtc,
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
 * Read Woo's lifetime sold count for a single SKU. Woo's product object
 * carries `total_sales` which increments as orders move into processing /
 * completed status. Close enough to "lifetime sold" for a stock-tracker
 * read-out — Melanie's call on 2026-05-19.
 */
async function fetchLifetimeSoldForSku(env, sku) {
  const { data } = await wooFetch(env, '/products', { sku, per_page: 5 });
  if (!Array.isArray(data) || data.length === 0) return 0;
  // Sum across matches (covers variations / multi-product SKU collisions).
  return data.reduce((acc, p) => acc + Number(p?.total_sales || 0), 0);
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
  const todayStartUtcIso = sydneyToUtcIso(syd.localDate, '00:00:00', syd.tzOffsetMinutes);
  const drop = computeNextDrop(now);

  // Run Woo orders + Woo product (soap lifetime) + ShipStation concurrently.
  // All three are independent reads against independent upstreams.
  const [ordersResult, soapLifetimeResult, shipstationSnap] = await Promise.allSettled([
    fetchOrdersSince(env, todayStartUtcIso),
    fetchLifetimeSoldForSku(env, SOAP_SKU),
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

  // Soap lifetime — soft-degrade: if this errors, show 0 with a note rather
  // than blowing up the whole tab.
  const soapLifetimeSold = soapLifetimeResult.status === 'fulfilled'
    ? soapLifetimeResult.value
    : 0;
  const soapLifetimeError = soapLifetimeResult.status === 'rejected'
    ? redactSecrets(soapLifetimeResult.reason?.message || String(soapLifetimeResult.reason))
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
      soap_units_lifetime: soapLifetimeSold,
      soap_units_today:    summary.soapUnitsToday,
      tin_units_today:     summary.tinUnitsToday,
      orders_per_hour:     summary.hourlyBuckets,
      soap_sku: SOAP_SKU,
      tin_sku:  TIN_SKU,
      soap_lifetime_error: soapLifetimeError,
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
