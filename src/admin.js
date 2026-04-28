/**
 * Admin routes — gated by an `X-Admin-Key` header that must equal `env.ADMIN_KEY`.
 *
 * Two routes today:
 *
 *   POST /api/admin/backfill?market=CA&pages=10
 *     Fetches up to `pages` × 100 Woo orders since the current sync_state
 *     watermark, writes them + their line_items into D1 (atomically per chunk),
 *     advances the watermark, logs the run, returns progress.
 *
 *   GET /api/admin/reconcile?market=CA
 *     Cross-checks D1 against Woo's authoritative numbers:
 *       1. Row count: D1 orders WHERE status IN ('completed','processing')
 *          vs Woo /orders X-WP-Total (same status filter).
 *       2. Revenue: SUM(orders.total) in D1 vs Woo Reports API total_sales.
 *     Reports both at full-history scope and per-month, so any divergence
 *     is easy to localise.
 *
 * Backfill semantics. Backfill and incremental sync use the same code path —
 * we fetch orders with `after=<watermark>&orderby=date&order=asc` and advance
 * the watermark to the latest date_created we wrote. First run starts from
 * `1970-01-01T00:00:00` (the schema default) so it pulls everything. Repeated
 * calls with `pages=N` chunk through the history; the route returns
 * `{ more: true }` while there's still data, `{ more: false }` when caught up.
 *
 * D1 writes are batched (one transactional batch per backfill chunk). Orders
 * use INSERT OR REPLACE so retries don't double-count. Order_items for any
 * touched order are deleted first then re-inserted, so refunded/edited orders
 * stay in sync with their line-item state.
 */

import { Hono } from 'hono';

export const adminRoutes = new Hono();

// ─── Auth middleware ────────────────────────────────────────────────────────

adminRoutes.use('*', async (c, next) => {
  const expected = c.env.ADMIN_KEY;
  if (!expected) {
    return c.json({ error: 'ADMIN_KEY not configured. Run: wrangler secret put ADMIN_KEY' }, 500);
  }
  const provided = c.req.header('X-Admin-Key');
  if (provided !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

// ─── Woo client (paginated /orders fetch) ───────────────────────────────────

const WOO_STATUSES_ALL = 'any'; // backfill stores everything; queries filter at read time

function storeFromEnv(env, market) {
  const key = market.toUpperCase();
  const lookup = {
    CA: { url: env.WOO_CA_URL, key: env.WOO_CA_KEY, secret: env.WOO_CA_SECRET, currency: 'CAD' },
    US: { url: env.WOO_US_URL, key: env.WOO_US_KEY, secret: env.WOO_US_SECRET, currency: 'USD' },
  };
  return lookup[key];
}

async function wooFetch(store, endpoint, params) {
  const url = new URL(`/wp-json/wc/v3${endpoint}`, store.url);
  url.searchParams.set('consumer_key', store.key);
  url.searchParams.set('consumer_secret', store.secret);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Woo ${resp.status} on ${endpoint}: ${body.substring(0, 300)}`);
  }
  return {
    data: await resp.json(),
    totalPages: parseInt(resp.headers.get('x-wp-totalpages') || '1', 10),
    total: parseInt(resp.headers.get('x-wp-total') || '0', 10),
  };
}

// ─── Backfill ───────────────────────────────────────────────────────────────

const PER_PAGE = 100;
const DEFAULT_PAGES_PER_CALL = 10;
const MAX_PAGES_PER_CALL = 20; // protective cap so one call can't run forever

adminRoutes.post('/backfill', async (c) => {
  const startMs = Date.now();
  const market = (c.req.query('market') || '').toUpperCase();
  const pages = Math.min(parseInt(c.req.query('pages') || String(DEFAULT_PAGES_PER_CALL), 10) || DEFAULT_PAGES_PER_CALL, MAX_PAGES_PER_CALL);

  if (!market || !['CA', 'US'].includes(market)) {
    return c.json({ error: 'market must be CA or US' }, 400);
  }
  const store = storeFromEnv(c.env, market);
  if (!store?.url || !store?.key || !store?.secret) {
    return c.json({ error: `WooCommerce ${market} not configured` }, 401);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  // Get current watermark, ensuring a sync_state row exists.
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO sync_state (source, market) VALUES ('woo', ?)`,
  ).bind(market).run();
  const stateRow = await c.env.DB.prepare(
    `SELECT watermark FROM sync_state WHERE source = 'woo' AND market = ?`,
  ).bind(market).first();
  const watermarkBefore = stateRow?.watermark || '1970-01-01T00:00:00';

  // Fetch orders since the watermark. Ascending so the LAST page has the
  // freshest orders — important for correctly advancing the watermark.
  const allOrders = [];
  let pagesFetched = 0;
  let woo;
  for (let page = 1; page <= pages; page++) {
    woo = await wooFetch(store, '/orders', {
      after: watermarkBefore,
      status: WOO_STATUSES_ALL,
      per_page: String(PER_PAGE),
      page: String(page),
      orderby: 'date',
      order: 'asc',
    });
    pagesFetched++;
    allOrders.push(...woo.data);
    if (page >= woo.totalPages) break; // caught up to the end of available data
  }

  // Deduplicate (defensive — Woo can return overlapping pages on the boundary).
  const seen = new Set();
  const orders = allOrders.filter(o => {
    const id = String(o.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  let watermarkAfter = watermarkBefore;
  let itemsAdded = 0;

  if (orders.length > 0) {
    // Build the batch: order upserts, then delete-then-insert for items.
    const stmts = [];
    for (const o of orders) {
      // raw_json deliberately set to NULL for backfill — JSON.stringify(o)
      // for ~500 orders/chunk eats 1.5–3s of pure CPU and we don't read
      // raw_json anywhere yet. Add back later if ever needed.
      stmts.push(
        c.env.DB.prepare(
          `INSERT OR REPLACE INTO orders
             (id, market, number, status, date_created, total, currency, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
        ).bind(
          o.id,
          market,
          o.number || String(o.id),
          o.status || 'unknown',
          o.date_created || '',
          parseFloat(o.total || 0),
          o.currency || store.currency,
        ),
      );
      stmts.push(
        c.env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(o.id),
      );
      for (const item of (o.line_items || [])) {
        itemsAdded++;
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO order_items
               (order_id, market, sku, name, quantity, total, date_created)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            o.id,
            market,
            item.sku || null,
            item.name || null,
            parseInt(item.quantity || 0, 10),
            parseFloat(item.total || 0),
            o.date_created || '',
          ),
        );
      }
    }
    // D1 batch is transactional: all-or-nothing within a single batch call.
    // Chunk if we get above ~500 statements to stay polite under the limit.
    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await c.env.DB.batch(stmts.slice(i, i + CHUNK));
    }

    // Advance watermark to the LATEST date_created we just wrote.
    watermarkAfter = orders.reduce((max, o) => {
      const d = o.date_created || '';
      return d > max ? d : max;
    }, watermarkBefore);

    await c.env.DB.prepare(
      `UPDATE sync_state SET watermark = ?, last_synced_at = datetime('now')
       WHERE source = 'woo' AND market = ?`,
    ).bind(watermarkAfter, market).run();
  }

  // Are there more orders past where we just got? Use the last page's
  // totalPages header — if pagesFetched < totalPages, more data exists.
  const more = (woo && pagesFetched < woo.totalPages) || (orders.length === pages * PER_PAGE);

  // Log the run.
  await c.env.DB.prepare(
    `INSERT INTO sync_logs
       (source, market, action, pages_fetched, orders_added, items_added,
        watermark_before, watermark_after, status, duration_ms)
     VALUES ('woo', ?, 'backfill', ?, ?, ?, ?, ?, 'ok', ?)`,
  ).bind(
    market, pagesFetched, orders.length, itemsAdded,
    watermarkBefore, watermarkAfter, Date.now() - startMs,
  ).run();

  return c.json({
    ok: true,
    market,
    pagesFetched,
    ordersAdded: orders.length,
    itemsAdded,
    watermarkBefore,
    watermarkAfter,
    more,
    durationMs: Date.now() - startMs,
  });
});

// ─── Reconcile ──────────────────────────────────────────────────────────────

adminRoutes.get('/reconcile', async (c) => {
  const market = (c.req.query('market') || '').toUpperCase();
  if (!market || !['CA', 'US'].includes(market)) {
    return c.json({ error: 'market must be CA or US' }, 400);
  }
  const store = storeFromEnv(c.env, market);
  if (!store?.url || !store?.key || !store?.secret) {
    return c.json({ error: `WooCommerce ${market} not configured` }, 401);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  // ── 1. Row count: D1 vs Woo X-WP-Total (status = completed+processing) ──
  const d1CountRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE market = ? AND status IN ('completed','processing')`,
  ).bind(market).first();
  const d1Count = d1CountRow?.n ?? 0;

  const wooCount = await wooFetch(store, '/orders', {
    status: 'completed,processing',
    per_page: '1',
    page: '1',
    _fields: 'id', // minimise payload
  });
  const wooCountTotal = wooCount.total;

  // ── 2. Revenue: D1 SUM(total) vs Woo Reports API total_sales ──
  // Get the date range from D1 itself — if D1 is empty, skip.
  const dateRangeRow = await c.env.DB.prepare(
    `SELECT MIN(date_created) AS min_date, MAX(date_created) AS max_date
     FROM orders WHERE market = ? AND status IN ('completed','processing')`,
  ).bind(market).first();
  const dateMin = (dateRangeRow?.min_date || '').substring(0, 10);
  const dateMax = (dateRangeRow?.max_date || '').substring(0, 10);

  let d1Revenue = 0;
  let wooRevenue = 0;
  let monthly = [];
  if (dateMin && dateMax) {
    const d1RevRow = await c.env.DB.prepare(
      `SELECT SUM(total) AS s FROM orders
       WHERE market = ? AND status IN ('completed','processing')`,
    ).bind(market).first();
    d1Revenue = d1RevRow?.s ?? 0;

    const wooRev = await wooFetch(store, '/reports/sales', {
      date_min: dateMin,
      date_max: dateMax,
    });
    // Reports API returns an array with one element when no `period` is set.
    const reportRow = Array.isArray(wooRev.data) ? wooRev.data[0] : wooRev.data;
    wooRevenue = parseFloat(reportRow?.total_sales || 0);

    // Per-month breakdown — D1 side.
    const d1MonthlyRows = await c.env.DB.prepare(
      `SELECT substr(date_created, 1, 7) AS ym,
              COUNT(*) AS n,
              SUM(total) AS s
       FROM orders
       WHERE market = ? AND status IN ('completed','processing')
       GROUP BY ym
       ORDER BY ym`,
    ).bind(market).all();
    monthly = (d1MonthlyRows.results || []).map(r => ({
      yearMonth: r.ym,
      d1Count: r.n,
      d1Revenue: r.s,
    }));

    // Woo reports per-month — one report call with period=month gives us
    // an array of monthly buckets covering the full date range.
    try {
      const wooMonthly = await wooFetch(store, '/reports/sales', {
        date_min: dateMin,
        date_max: dateMax,
        period: 'month',
      });
      // Woo returns the period totals nested inside the first array element's `totals` object,
      // keyed by the period start date.
      const totals = (Array.isArray(wooMonthly.data) ? wooMonthly.data[0]?.totals : wooMonthly.data?.totals) || {};
      for (const row of monthly) {
        const wooMatch = Object.entries(totals).find(([k]) => k.startsWith(row.yearMonth));
        if (wooMatch) {
          row.wooRevenue = parseFloat(wooMatch[1]?.sales || 0);
          row.divergence = +(row.d1Revenue - row.wooRevenue).toFixed(2);
        } else {
          row.wooRevenue = null;
          row.divergence = null;
        }
      }
    } catch (e) {
      // Per-month report is best-effort — full-range numbers above are the primary check.
    }
  }

  return c.json({
    market,
    fullHistory: {
      d1Count,
      wooCount: wooCountTotal,
      countMatch: d1Count === wooCountTotal,
      countDelta: d1Count - wooCountTotal,
      d1Revenue: +d1Revenue.toFixed(2),
      wooRevenue: +wooRevenue.toFixed(2),
      revenueDelta: +(d1Revenue - wooRevenue).toFixed(2),
      revenueMatchWithinDollar: Math.abs(d1Revenue - wooRevenue) < 1.0,
      dateMin,
      dateMax,
    },
    monthly,
  });
});
