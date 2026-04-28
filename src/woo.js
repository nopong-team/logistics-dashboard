/**
 * WooCommerce routes for the Logistics Dashboard.
 *
 * Step 4 (current): /api/woo/sales is a live fetch of the last 30 days of
 * orders from Woo, aggregated into the existing dashboard payload shape
 * (monthlyRevenue[6], monthlyOrders[6], skuTotals). Older months in the
 * rolling 6-month window render as zero — expected for proof-of-concept;
 * those gaps are filled by the D1 historical backfill in Step 5.
 *
 * The aggregated response is cached in KV for SALES_TTL_SECONDS so a busy
 * dashboard doesn't hammer the Woo /orders endpoint on every page load.
 *
 * Secrets (Wrangler secrets, never in git):
 *   WOO_CA_URL, WOO_CA_KEY, WOO_CA_SECRET
 *   WOO_US_URL, WOO_US_KEY, WOO_US_SECRET
 *
 * Bindings (in wrangler.jsonc):
 *   CACHE — KV namespace used as a read-through response cache.
 */

import { Hono } from 'hono';

export const wooRoutes = new Hono();

// Cache TTL for the aggregated /sales response blob (seconds).
const SALES_TTL_SECONDS = 15 * 60;

// Live-fetch window. 30 days is a deliberate proof-of-concept cap; the rest
// of the rolling 6-month window is populated by D1 backfill in Step 5.
const LIVE_WINDOW_DAYS = 30;

// Cap per-page fetches so a misconfigured store can't pin a Worker for 30s.
// 30 days at 100/page is comfortably under this for No Pong's volume.
const MAX_PAGES = 20;
const PER_PAGE = 100;

// Existing dashboard convention — the start of the per-week aggregation window.
// Mirrored from backend/server.js so the shape lines up byte-for-byte.
const WEEKLY_START_DATE = '2026-03-01';

function storesFromEnv(env) {
  return {
    CA: { url: env.WOO_CA_URL, key: env.WOO_CA_KEY, secret: env.WOO_CA_SECRET, currency: 'CAD' },
    US: { url: env.WOO_US_URL, key: env.WOO_US_KEY, secret: env.WOO_US_SECRET, currency: 'USD' },
  };
}

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
  return { monthMap: map, labels, startYm: Object.keys(map)[0] };
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

// One paginated GET against /wp-json/wc/v3/orders.
async function fetchWooOrdersPage(store, params) {
  const url = new URL('/wp-json/wc/v3/orders', store.url);
  url.searchParams.set('consumer_key', store.key);
  url.searchParams.set('consumer_secret', store.secret);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Woo ${resp.status}: ${body.substring(0, 300)}`);
  }
  const totalPages = parseInt(resp.headers.get('x-wp-totalpages') || '1', 10);
  const total = parseInt(resp.headers.get('x-wp-total') || '0', 10);
  const data = await resp.json();
  return { data, totalPages, total };
}

async function fetchWooOrdersSince(store, afterIso) {
  const orders = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { data, totalPages: tp } = await fetchWooOrdersPage(store, {
      after: afterIso,
      status: 'completed,processing',
      per_page: String(PER_PAGE),
      page: String(page),
      orderby: 'date',
      order: 'asc',
      // Trim the payload — we only need date, total, and line items for aggregation.
      _fields: 'id,number,date_created,total,line_items',
    });
    orders.push(...data);
    totalPages = tp;
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  return { orders, pagesFetched: page - 1, totalPages };
}

// Aggregate raw Woo orders into the dashboard payload shape.
function aggregateOrders(orders, currency) {
  const { monthMap } = buildMonthWindow();
  const monthlyRevenue = [0, 0, 0, 0, 0, 0];
  const monthlyOrders = [0, 0, 0, 0, 0, 0];
  const skuTotals = {};

  for (const order of orders) {
    const date = order.date_created || '';
    const ym = date.substring(0, 7);
    const idx = monthMap[ym];
    if (idx !== undefined) {
      monthlyRevenue[idx] += parseFloat(order.total || 0);
      monthlyOrders[idx]++;
    }

    const wk = getWeekKey(date);
    for (const item of (order.line_items || [])) {
      const sku = item.sku || 'unknown';
      if (!skuTotals[sku]) {
        skuTotals[sku] = {
          qty: 0,
          revenue: 0,
          name: item.name || '',
          monthly: [0, 0, 0, 0, 0, 0],
          monthlyQty: [0, 0, 0, 0, 0, 0],
          weeklyQty: {},
        };
      }
      skuTotals[sku].qty += item.quantity || 0;
      skuTotals[sku].revenue += parseFloat(item.total || 0);
      if (idx !== undefined) {
        skuTotals[sku].monthly[idx] += parseFloat(item.total || 0);
        skuTotals[sku].monthlyQty[idx] += item.quantity || 0;
      }
      if (wk) {
        skuTotals[sku].weeklyQty[wk] = (skuTotals[sku].weeklyQty[wk] || 0) + (item.quantity || 0);
      }
    }
  }

  return {
    marketplace: 'WooCommerce',
    currency,
    monthlyRevenue,
    monthlyOrders,
    skuTotals,
    source: 'woocommerce',
    lastSync: new Date().toISOString(),
  };
}

// GET /api/woo/sales?market=CA&refresh=1
//   - market:  CA | US (default CA)
//   - refresh: 1 to bypass the KV cache and re-fetch from Woo
wooRoutes.get('/sales', async (c) => {
  const market = (c.req.query('market') || 'CA').toUpperCase();
  const stores = storesFromEnv(c.env);
  const store = stores[market];
  if (!store || !store.url || !store.key || !store.secret) {
    return c.json(
      {
        error: `WooCommerce ${market} not configured.`,
        hint: `Set the secrets with: wrangler secret put WOO_${market}_URL (and WOO_${market}_KEY, WOO_${market}_SECRET).`,
      },
      401,
    );
  }

  const cacheKey = `woo-sales-${market.toLowerCase()}`;
  const force = c.req.query('refresh') === '1';

  // Read-through cache. CACHE binding is optional — if the KV namespace isn't
  // wired up yet (first deploy before `wrangler kv:namespace create`), we just
  // skip the cache and live-fetch every call.
  if (!force && c.env.CACHE) {
    const cached = await c.env.CACHE.get(cacheKey, 'json');
    if (cached) {
      return c.json({ ...cached, cached: true });
    }
  }

  const since = new Date(Date.now() - LIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { orders, pagesFetched, totalPages } = await fetchWooOrdersSince(store, since);
  const payload = aggregateOrders(orders, store.currency);
  payload.windowDays = LIVE_WINDOW_DAYS;
  payload.ordersFetched = orders.length;
  payload.pagesFetched = pagesFetched;
  payload.totalPagesAvailable = totalPages;
  payload.notice = pagesFetched < totalPages
    ? `Live-fetch capped at ${pagesFetched} pages of ${totalPages}; older data will land via D1 backfill (Step 5).`
    : `Last ${LIVE_WINDOW_DAYS} days of orders only — older months will be populated by D1 backfill (Step 5).`;

  if (c.env.CACHE) {
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: SALES_TTL_SECONDS });
  }

  return c.json({ ...payload, cached: false });
});
