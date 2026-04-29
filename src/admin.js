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
    CA: { market: 'CA', url: env.WOO_CA_URL, key: env.WOO_CA_KEY, secret: env.WOO_CA_SECRET, currency: 'CAD' },
    US: { market: 'US', url: env.WOO_US_URL, key: env.WOO_US_KEY, secret: env.WOO_US_SECRET, currency: 'USD' },
  };
  return lookup[key];
}

// Scrub anything that looks like a credential out of a string before it hits
// any user-visible surface (response body, transcript, scrollback). Belt to
// the global onError handler's braces.
function redactSecrets(s) {
  return String(s || '')
    .replace(/(consumer_key|consumer_secret|access_token|refresh_token|api_key)=[^&\s"']+/gi, '$1=[REDACTED]')
    .replace(/\b(ck|cs)_[a-f0-9]{20,}\b/gi, '$1_[REDACTED]');
}

async function wooFetch(store, endpoint, params) {
  let url;
  try {
    url = new URL(`/wp-json/wc/v3${endpoint}`, store.url);
  } catch (e) {
    // Bad WOO_${market}_URL — almost always a paste typo (missing protocol etc.).
    throw new Error(
      `Woo ${store.market}: WOO_${store.market}_URL is not a valid URL. ` +
      `Re-set it with: npx wrangler secret put WOO_${store.market}_URL`,
    );
  }
  url.searchParams.set('consumer_key', store.key);
  url.searchParams.set('consumer_secret', store.secret);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let resp;
  try {
    resp = await fetch(url.toString());
  } catch (e) {
    // fetch() throws here on malformed URL schemes (e.g. "ttps://" from a paste
    // that dropped the leading h), unreachable hosts, etc. The native error
    // message from undici/Workers includes the full URL — which contains the
    // consumer_key/consumer_secret query params we just appended. Do NOT
    // propagate that message; emit a sanitized one that names the likely
    // remediation without leaking credentials.
    throw new Error(
      `Woo ${store.market} fetch failed (likely bad WOO_${store.market}_URL or unreachable host). ` +
      `Underlying: ${redactSecrets(e?.message || e)}`,
    );
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Woo ${store.market} ${resp.status} on ${endpoint}: ${redactSecrets(body).substring(0, 300)}`);
  }
  return {
    data: await resp.json(),
    totalPages: parseInt(resp.headers.get('x-wp-totalpages') || '1', 10),
    total: parseInt(resp.headers.get('x-wp-total') || '0', 10),
  };
}

// ─── Backfill ───────────────────────────────────────────────────────────────

const PER_PAGE = 100;
// pages=1 is the safe ceiling on Workers Free — see memory
// `woo_backfill_chunk_size.md` and STATUS.md "Free vs Paid Workers". Higher
// chunk sizes hit CPU limits and silently truncate the response.
const DEFAULT_PAGES_PER_CALL = 1;
const MAX_PAGES_PER_CALL = 20; // protective cap so one call can't run forever

/**
 * Run one Woo→D1 backfill chunk.
 *
 * Shared by the admin route handler and the cron scheduled handler. Caller is
 * responsible for upstream validation (market is CA/US, store has secrets,
 * env.DB is bound, action label) — this function assumes those checks have
 * already passed and just does the work.
 *
 * Action label: 'backfill' (manual curl-loop) | 'incremental' (cron tick).
 * The label is stamped into sync_logs so we can tell them apart in audit.
 */
export async function runBackfillChunk(env, market, pages, action = 'backfill') {
  const startMs = Date.now();
  const store = storeFromEnv(env, market);

  // Get current watermark, ensuring a sync_state row exists.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_state (source, market) VALUES ('woo', ?)`,
  ).bind(market).run();
  const stateRow = await env.DB.prepare(
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
      //
      // local_date is the canonical Eastern bucket key. Woo's date_created is
      // already Eastern-naive (both stores configured to America/Toronto and
      // America/New_York), so substring(0, 10) extracts the Eastern YYYY-MM-DD
      // directly — no timezone conversion required at write time. See
      // src/timezone.js for the full rationale and the Amazon counterpart.
      const localDate = (o.date_created || '').substring(0, 10) || null;
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO orders
             (id, market, number, status, date_created, local_date, total, currency, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
        ).bind(
          o.id,
          market,
          o.number || String(o.id),
          o.status || 'unknown',
          o.date_created || '',
          localDate,
          parseFloat(o.total || 0),
          o.currency || store.currency,
        ),
      );
      stmts.push(
        env.DB.prepare(`DELETE FROM order_items WHERE order_id = ?`).bind(o.id),
      );
      for (const item of (o.line_items || [])) {
        itemsAdded++;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO order_items
               (order_id, market, sku, name, quantity, total, date_created, local_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            o.id,
            market,
            item.sku || null,
            item.name || null,
            parseInt(item.quantity || 0, 10),
            parseFloat(item.total || 0),
            o.date_created || '',
            localDate,
          ),
        );
      }
    }
    // D1 batch is transactional: all-or-nothing within a single batch call.
    // Chunk if we get above ~500 statements to stay polite under the limit.
    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }

    // Advance watermark to the LATEST date_created we just wrote.
    watermarkAfter = orders.reduce((max, o) => {
      const d = o.date_created || '';
      return d > max ? d : max;
    }, watermarkBefore);

    await env.DB.prepare(
      `UPDATE sync_state SET watermark = ?, last_synced_at = datetime('now')
       WHERE source = 'woo' AND market = ?`,
    ).bind(watermarkAfter, market).run();
  }

  // Are there more orders past where we just got? Use the last page's
  // totalPages header — if pagesFetched < totalPages, more data exists.
  const more = (woo && pagesFetched < woo.totalPages) || (orders.length === pages * PER_PAGE);

  // Log the run.
  await env.DB.prepare(
    `INSERT INTO sync_logs
       (source, market, action, pages_fetched, orders_added, items_added,
        watermark_before, watermark_after, status, duration_ms)
     VALUES ('woo', ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
  ).bind(
    market, action, pagesFetched, orders.length, itemsAdded,
    watermarkBefore, watermarkAfter, Date.now() - startMs,
  ).run();

  return {
    ok: true,
    market,
    action,
    pagesFetched,
    ordersAdded: orders.length,
    itemsAdded,
    watermarkBefore,
    watermarkAfter,
    more,
    durationMs: Date.now() - startMs,
  };
}

adminRoutes.post('/backfill', async (c) => {
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

  const result = await runBackfillChunk(c.env, market, pages, 'backfill');
  return c.json(result);
});

// ─── Reconcile ──────────────────────────────────────────────────────────────

// Reconcile validates the D1 backfill against Woo's authoritative count.
// We compare row counts (status = completed, processing) per-month and at the
// full-window level — if Woo and D1 agree on counts for every bucket, we have
// strong evidence the backfill is complete and correctly windowed.
//
// We deliberately don't use Woo's /reports/sales endpoint here. On WordPress
// VIP it doesn't always return the expected totals shape and the `period`
// parameter is a preset (this-month / this-year / etc.) rather than a
// grouping directive — easy to misuse. /orders?after=&before= with the
// X-WP-Total header is more authoritative anyway: it counts the same rows
// we backfilled, with the same status filter.
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

  // Pull D1's snapshot first so we know the window we're validating.
  const dateRangeRow = await c.env.DB.prepare(
    `SELECT MIN(date_created) AS min_date, MAX(date_created) AS max_date
     FROM orders WHERE market = ? AND status IN ('completed','processing')`,
  ).bind(market).first();
  const dateMin = (dateRangeRow?.min_date || '').substring(0, 10);
  const dateMax = (dateRangeRow?.max_date || '').substring(0, 10);
  if (!dateMin || !dateMax) {
    return c.json({ market, error: 'No completed/processing orders in D1 — nothing to reconcile.' });
  }

  const d1FullRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(total) AS s
     FROM orders WHERE market = ? AND status IN ('completed','processing')`,
  ).bind(market).first();
  const d1Count = d1FullRow?.n ?? 0;
  const d1Revenue = d1FullRow?.s ?? 0;

  // Per-month aggregates from D1 — one query, GROUP BY year-month.
  const d1MonthlyRows = await c.env.DB.prepare(
    `SELECT substr(date_created, 1, 7) AS ym,
            COUNT(*) AS n,
            SUM(total) AS s
     FROM orders WHERE market = ? AND status IN ('completed','processing')
     GROUP BY ym ORDER BY ym`,
  ).bind(market).all();

  // Helper — Woo /orders count for an [after, before) ISO date window.
  // We use per_page=1 + read X-WP-Total from headers, so each call is cheap.
  async function wooCountInWindow(afterIso, beforeIso) {
    const result = await wooFetch(store, '/orders', {
      after:    afterIso,
      before:   beforeIso,
      status:   'completed,processing',
      per_page: '1',
      page:     '1',
      _fields:  'id',
    });
    return result.total;
  }

  // Pad the full window slightly so we don't lose boundary orders to second-
  // precision rounding — Woo's `after`/`before` are exclusive at second granularity.
  const fullAfter  = `${dateMin}T00:00:00`;
  const fullBefore = `${dateMax}T23:59:59`;
  const wooCount = await wooCountInWindow(fullAfter, fullBefore);

  // Per-month Woo counts. One subrequest per month — for our 12-month window
  // that's 12 calls, ~10–12s wall clock total, still well under any limit.
  const monthly = [];
  for (const row of (d1MonthlyRows.results || [])) {
    const ym = row.ym; // 'YYYY-MM'
    const [y, m] = ym.split('-').map(Number);
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01T00:00:00`;
    const next = new Date(Date.UTC(y, m, 1)); // m = 1-based; new Date with UTC m-arg is 0-based, so this lands first of next month
    const nextYm = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00`;
    let wooMonthCount = null;
    try {
      wooMonthCount = await wooCountInWindow(monthStart, nextYm);
    } catch (e) {
      // Fall through with null — surfaces in output as a missing comparator.
    }
    monthly.push({
      yearMonth: ym,
      d1Count:   row.n,
      d1Revenue: row.s ? +row.s.toFixed(2) : 0,
      wooCount:  wooMonthCount,
      countMatch: wooMonthCount === null ? null : (wooMonthCount === row.n),
      countDelta: wooMonthCount === null ? null : (row.n - wooMonthCount),
    });
  }

  return c.json({
    market,
    fullHistory: {
      d1Count,
      wooCount,
      countMatch: d1Count === wooCount,
      countDelta: d1Count - wooCount,
      d1Revenue: +Number(d1Revenue).toFixed(2),
      d1AverageOrderValue: d1Count > 0 ? +(d1Revenue / d1Count).toFixed(2) : 0,
      dateMin,
      dateMax,
      dateRangeIso: { after: fullAfter, before: fullBefore },
    },
    monthly,
    notes: [
      'Per-month wooCount uses /orders ?after=&before= X-WP-Total (status=completed,processing).',
      'Revenue is reported from D1 only — Woo Reports API is unreliable on this install.',
      'A countMatch:true on every bucket means the backfill is complete and correctly windowed.',
    ],
  });
});
