/**
 * WooCommerce routes for the Logistics Dashboard.
 *
 * Step 5b (current): /api/woo/sales reads from D1. Two queries (per-month and
 * per-SKU per-day) run in parallel; the per-day rows are folded in JS to
 * compute weeklyQty using the existing month-boundary-aware getWeekKey()
 * helper. Payload shape is identical to Step 4's live-fetch version.
 *
 * The aggregated response is cached in KV for SALES_TTL_SECONDS so a busy
 * dashboard doesn't re-aggregate from D1 on every page load. The cron sync
 * (src/index.js scheduled handler) invalidates this key after writing new
 * orders.
 *
 * Secrets used by other routes (kept here for grep-discoverability):
 *   WOO_CA_URL, WOO_CA_KEY, WOO_CA_SECRET
 *   WOO_US_URL, WOO_US_KEY, WOO_US_SECRET
 *
 * Bindings (in wrangler.jsonc):
 *   CACHE — KV namespace used as a read-through response cache.
 *   DB    — D1 database `logistics-db`, source-of-truth for historical orders.
 */

import { Hono } from 'hono';

export const wooRoutes = new Hono();

// Cache TTL for the aggregated /sales response blob (seconds).
const SALES_TTL_SECONDS = 15 * 60;

// Existing dashboard convention — the start of the per-week aggregation window.
// Mirrored from backend/server.js so the shape lines up byte-for-byte.
const WEEKLY_START_DATE = '2026-03-01';

// Currency for each market. The dashboard displays this on the per-market tile.
const MARKET_CURRENCY = { CA: 'CAD', US: 'USD', AU: 'AUD' };

// Build the rolling 6-month window the dashboard expects: index 0 is the
// oldest of the 6 months, index 5 is the current month.
function buildMonthWindow() {
  const now = new Date();
  const map = {};
  const labels = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    map[ym] = 5 - i;
    labels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric' }));
  }
  // First-of-month for the oldest of the six — this is the SQL filter floor.
  const startMonth = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const startIso = `${startMonth.getFullYear()}-${String(startMonth.getMonth() + 1).padStart(2, '0')}-01T00:00:00`;
  return { monthMap: map, labels, startYm: Object.keys(map)[0], startIso };
}

function _parseLocalDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function _fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirror of backend/server.js getWeekKey: weeks run Monday–Sunday but split
// at month boundaries (so the last few days of a month and the first few of
// the next are reported as separate weekly buckets).
function getWeekKey(dateStr) {
  const d = _parseLocalDate(dateStr);
  if (!d) return null;
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  if (monday.getMonth() !== d.getMonth() || monday.getFullYear() !== d.getFullYear()) {
    const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    const key = _fmtDate(firstOfMonth);
    return key >= WEEKLY_START_DATE ? key : null;
  }
  const key = _fmtDate(monday);
  return key >= WEEKLY_START_DATE ? key : null;
}

// Aggregate D1 result rows into the dashboard payload shape.
//   monthRows: [{ ym, n_orders, revenue }, ...]   from the per-month query
//   itemRows:  [{ sku, name, day, qty, revenue }, ...]   from the per-SKU per-day query
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

  const { startIso } = buildMonthWindow();

  // Two queries in parallel:
  //   A) per-month order counts + revenue → drives monthlyRevenue / monthlyOrders
  //   B) per-SKU per-day qty + revenue + name → folded in JS to compute the
  //      sku-level monthly[], monthlyQty[], and weeklyQty{} maps. Per-day
  //      granularity in SQL keeps the JS-side getWeekKey() (Mon–Sun, split at
  //      month boundary) faithful without re-implementing that rule in SQL.
  // Both queries use status IN ('completed','processing') to match what
  // /api/admin/reconcile validated against during the backfill.
  const [monthRes, itemRes, syncStateRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT substr(date_created, 1, 7) AS ym,
              COUNT(*)                  AS n_orders,
              SUM(total)                AS revenue
       FROM orders
       WHERE market = ?
         AND status IN ('completed','processing')
         AND date_created >= ?
       GROUP BY ym`,
    ).bind(market, startIso).all(),
    c.env.DB.prepare(
      `SELECT oi.sku                          AS sku,
              MAX(oi.name)                    AS name,
              substr(oi.date_created, 1, 10)  AS day,
              SUM(oi.quantity)                AS qty,
              SUM(oi.total)                   AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.market = ?
         AND o.status IN ('completed','processing')
         AND oi.date_created >= ?
       GROUP BY oi.sku, day
       ORDER BY oi.sku, day ASC`,
    ).bind(market, startIso).all(),
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
    windowStart: startIso,
    ordersInWindow,
    watermark: syncStateRes?.watermark || null,
    lastSync:  syncStateRes?.last_synced_at || new Date().toISOString(),
  };

  if (c.env.CACHE) {
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: SALES_TTL_SECONDS });
  }

  return c.json({ ...payload, cached: false });
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
