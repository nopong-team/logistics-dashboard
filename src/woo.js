/**
 * WooCommerce routes for the Logistics Dashboard.
 *
 * /api/woo/sales reads from D1, KV-cached for SALES_TTL_SECONDS. Two queries
 * (per-month and per-SKU per-day) run in parallel; the per-day rows are
 * folded in JS to compute weeklyQty using the timezone helper's getWeekKey()
 * (Mon–Sun with month-boundary splits, against WEEKLY_START_DATE).
 *
 * All bucketing happens on the precomputed `local_date` column (Eastern,
 * canonical, populated at insert time). See src/timezone.js for the rationale
 * and per-source ingestion semantics.
 *
 * Bindings (in wrangler.jsonc):
 *   CACHE — KV namespace used as a read-through response cache.
 *   DB    — D1 database `logistics-db`, source-of-truth for historical orders.
 */

import { Hono } from 'hono';
import { buildMonthWindow, getWeekKey } from './timezone.js';
import { toIsoUtc } from './diagnostics.js';

export const wooRoutes = new Hono();

// Cache TTL for the aggregated /sales response blob (seconds).
const SALES_TTL_SECONDS = 15 * 60;

// Currency for each market. The dashboard displays this on the per-market tile.
const MARKET_CURRENCY = { CA: 'CAD', US: 'USD', AU: 'AUD' };

// Aggregate D1 result rows into the dashboard payload shape.
//   monthRows: [{ ym, n_orders, revenue }, ...]   from the per-month query
//   itemRows:  [{ sku, name, day, qty, revenue }, ...]   from the per-SKU per-day query
// Both inputs already in Eastern (rows use the local_date column), so we just
// drop them into the buckets.
function aggregateFromD1(monthRows, itemRows, currency) {
  const { monthMap } = buildMonthWindow();
  const monthlyRevenue = [0, 0, 0, 0, 0, 0];
  const monthlyOrders  = [0, 0, 0, 0, 0, 0];
  const skuTotals = {};

  // Month buckets — one pass over a small (≤6) result set.
  for (const row of monthRows) {
    const idx = monthMap[row.ym];
    if (idx === undefined) continue; // rows outside the rolling window (boundary safety)
    monthlyRevenue[idx] = row.revenue || 0;
    monthlyOrders[idx]  = row.n_orders || 0;
  }

  // Per-SKU per-day rows — fold qty/revenue/monthly/monthlyQty/weeklyQty.
  // Rows arrive ordered by (sku, day ASC), so first-non-null name wins —
  // matches the legacy aggregateOrders "first-seen" semantics for SKU names.
  for (const row of itemRows) {
    const sku = row.sku || 'unknown';
    const qty = row.qty || 0;
    const revenue = row.revenue || 0;
    if (!skuTotals[sku]) {
      skuTotals[sku] = {
        qty: 0,
        revenue: 0,
        name: row.name || '',
        monthly:    [0, 0, 0, 0, 0, 0],
        monthlyQty: [0, 0, 0, 0, 0, 0],
        weeklyQty: {},
      };
    } else if (!skuTotals[sku].name && row.name) {
      skuTotals[sku].name = row.name;
    }

    skuTotals[sku].qty     += qty;
    skuTotals[sku].revenue += revenue;

    const ym = (row.day || '').substring(0, 7);
    const idx = monthMap[ym];
    if (idx !== undefined) {
      skuTotals[sku].monthly[idx]    += revenue;
      skuTotals[sku].monthlyQty[idx] += qty;
    }

    const wk = getWeekKey(row.day);
    if (wk) {
      skuTotals[sku].weeklyQty[wk] = (skuTotals[sku].weeklyQty[wk] || 0) + qty;
    }
  }

  return { monthlyRevenue, monthlyOrders, skuTotals };
}

// GET /api/woo/sales?market=CA&refresh=1
//   - market:  CA | US (default CA)
//   - refresh: 1 to bypass the KV cache and re-aggregate from D1
wooRoutes.get('/sales', async (c) => {
  const market = (c.req.query('market') || 'CA').toUpperCase();
  if (!['CA', 'US', 'AU'].includes(market)) {
    return c.json({ error: `unsupported market: ${market}` }, 400);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  const cacheKey = `woo-sales-${market.toLowerCase()}`;
  const force = c.req.query('refresh') === '1';

  // Read-through cache. CACHE binding is optional — if the KV namespace isn't
  // wired up yet we just skip the cache and re-aggregate every call.
  if (!force && c.env.CACHE) {
    const cached = await c.env.CACHE.get(cacheKey, 'json');
    if (cached) {
      return c.json({ ...cached, cached: true });
    }
  }

  const { startDate } = buildMonthWindow();

  // Two queries in parallel, both bucketing on the precomputed local_date
  // column (Eastern, populated at ingest from the Eastern-naive Woo
  // date_created — see src/admin.js runBackfillChunk and src/timezone.js).
  //   A) per-month order counts + revenue → drives monthlyRevenue / monthlyOrders
  //   B) per-SKU per-day qty + revenue + name → folded in JS to compute the
  //      sku-level monthly[], monthlyQty[], and weeklyQty{} maps. Per-day
  //      granularity in SQL keeps the JS-side getWeekKey() (Mon–Sun, split at
  //      month boundary) faithful without re-implementing that rule in SQL.
  // Both queries use status IN ('completed','processing') to match what
  // /api/admin/reconcile validated against during the backfill.
  const [monthRes, itemRes, syncStateRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT substr(local_date, 1, 7) AS ym,
              COUNT(*)                 AS n_orders,
              SUM(total)               AS revenue
       FROM orders
       WHERE market = ?
         AND status IN ('completed','processing')
         AND local_date >= ?
       GROUP BY ym`,
    ).bind(market, startDate).all(),
    c.env.DB.prepare(
      `SELECT oi.sku            AS sku,
              MAX(oi.name)      AS name,
              oi.local_date     AS day,
              SUM(oi.quantity)  AS qty,
              SUM(oi.total)     AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.market = ?
         AND o.status IN ('completed','processing')
         AND oi.local_date >= ?
       GROUP BY oi.sku, oi.local_date
       ORDER BY oi.sku, oi.local_date ASC`,
    ).bind(market, startDate).all(),
    c.env.DB.prepare(
      `SELECT watermark, last_synced_at
       FROM sync_state WHERE source = 'woo' AND market = ?`,
    ).bind(market).first(),
  ]);

  const currency = MARKET_CURRENCY[market] || 'USD';
  const monthRows = (monthRes.results || []);
  const itemRows  = (itemRes.results  || []);
  const { monthlyRevenue, monthlyOrders, skuTotals } = aggregateFromD1(monthRows, itemRows, currency);

  const ordersInWindow = monthlyOrders.reduce((a, b) => a + b, 0);

  const payload = {
    marketplace: 'WooCommerce',
    currency,
    monthlyRevenue,
    monthlyOrders,
    skuTotals,
    source: 'woocommerce',
    dataSource: 'd1',
    windowStart: startDate,
    ordersInWindow,
    watermark: syncStateRes?.watermark || null,
    lastSync:  toIsoUtc(syncStateRes?.last_synced_at) || new Date().toISOString(),
  };

  if (c.env.CACHE) {
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: SALES_TTL_SECONDS });
  }

  return c.json({ ...payload, cached: false });
});

// GET /api/woo/recent-orders?market=CA|US
//   Last-24h orders for the recent-orders rail. Reads from D1 directly (no KV
//   layer — the data is small, the query is cheap, and the rail is a "live"
//   surface that shouldn't lag a 15-min cache).
//
//   Response shape matches the legacy backend/server.js endpoint exactly so the
//   frontend's loadRecentOrders() picks it up without modification:
//     { orders: [{ id, date, amount, currency, market, channel: 'WooCommerce' }],
//       count, market, source: 'woocommerce' }
//
//   - 50-row cap, ordered by date_created DESC (matches legacy `per_page=50` +
//     `orderby=date,order=desc` from Woo).
//   - status IN ('completed','processing') — same filter as `/api/woo/sales`,
//     keeps the rail consistent with the revenue numbers.
//   - "Last 24h" measured against `date_created` UTC. The frontend formats
//     dates with `toLocaleDateString('en-AU', ...)` so mild TZ slippage at the
//     boundary is invisible to the user; precise Eastern-bucketing isn't needed
//     for a recent-orders rail.
wooRoutes.get('/recent-orders', async (c) => {
  const market = (c.req.query('market') || 'US').toUpperCase();
  if (!['CA', 'US', 'AU'].includes(market)) {
    return c.json({ error: `unsupported market: ${market}` }, 400);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await c.env.DB.prepare(
    `SELECT id, date_created, total
     FROM orders
     WHERE market = ?
       AND status IN ('completed','processing')
       AND date_created >= ?
     ORDER BY date_created DESC
     LIMIT 50`,
  ).bind(market, since).all();

  const currency = MARKET_CURRENCY[market] || 'USD';
  const orders = (res.results || []).map((r) => ({
    id:       r.id,
    date:     r.date_created,
    amount:   parseFloat(r.total || 0),
    currency,
    market,
    channel:  'WooCommerce',
  }));

  return c.json({ orders, count: orders.length, market, source: 'woocommerce' });
});

// Internal helper exported for the cron handler in src/index.js — invalidates
// the KV cache key for a market so the next /api/woo/sales call re-aggregates
// from D1 (picking up the rows the cron just wrote).
export async function invalidateWooSalesCache(env, market) {
  if (!env?.CACHE) return;
  const m = String(market || '').toLowerCase();
  if (!m) return;
  await env.CACHE.delete(`woo-sales-${m}`);
}
