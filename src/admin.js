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
import { redactSecrets } from './redact.js';
import { runAmazonOrdersChunk, runAmazonReportsTick, spApiRequest, invalidateAmazonSalesCache } from './amazon.js';

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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
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
  }

  // Heartbeat: always update last_synced_at on a successful run, even if no
  // new orders came back. The chip on the dashboard reads this field to answer
  // "when did we last hear from this source", which is a different question
  // from "when did we last persist a NEW order" (the `watermark` column
  // answers that). Previously this UPDATE was inside the `if (orders.length > 0)`
  // block, so a cron tick with zero new orders left the timestamp stale and
  // the chip showed e.g. "13h ago" while the cron was actually firing every
  // 15 min. ISO-8601 with explicit Z is critical — a naive 'YYYY-MM-DD HH:MM:SS'
  // string is parsed as LOCAL time by JS `new Date()`, which produced a
  // ~9-hour false stale on Chris's UTC+9 machine.
  await env.DB.prepare(
    `UPDATE sync_state
     SET watermark = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE source = 'woo' AND market = ?`,
  ).bind(watermarkAfter, market).run();

  // Are there more orders past where we just got? Use the last page's
  // totalPages header — if pagesFetched < totalPages, more data exists.
  const more = (woo && pagesFetched < woo.totalPages) || (orders.length === pages * PER_PAGE);

  // Log the run. run_at is written explicitly as ISO-8601 with Z so the import
  // log endpoint (and any other read) can parse it directly without timezone
  // tricks — schema default for run_at is `datetime('now')` which produces a
  // naive 'YYYY-MM-DD HH:MM:SS' string that JS new Date() parses as LOCAL time.
  await env.DB.prepare(
    `INSERT INTO sync_logs
       (run_at, source, market, action, pages_fetched, orders_added, items_added,
        watermark_before, watermark_after, status, duration_ms)
     VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'woo', ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
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
  const source = (c.req.query('source') || 'woo').toLowerCase();
  if (!market || !['CA', 'US'].includes(market)) {
    return c.json({ error: 'market must be CA or US' }, 400);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  if (source === 'amazon') {
    if (!c.env.AMAZON_REFRESH_TOKEN || !c.env.AMAZON_LWA_CLIENT_ID || !c.env.AMAZON_LWA_CLIENT_SECRET) {
      return c.json({ error: 'Amazon not configured (need AMAZON_REFRESH_TOKEN + AMAZON_LWA_CLIENT_ID + AMAZON_LWA_CLIENT_SECRET)' }, 401);
    }
    // Amazon backfill chunk = one page (≤100 orders) + NextToken for the next call.
    // Caller drives the loop by passing nextToken back in (or omitting for first call).
    const nextToken = c.req.query('nextToken') || null;
    // Optional: also advance Reports state machine on the same call so a manual
    // backfill loop seeds + polls + ingests in lockstep with Orders progress.
    const includeReports = c.req.query('reports') === '1';
    const orders  = await runAmazonOrdersChunk(c.env, market, { action: 'amazon-backfill', nextToken });
    const reports = includeReports ? await runAmazonReportsTick(c.env, market) : null;
    return c.json({ orders, reports });
  }

  // Default — WooCommerce backfill (existing behaviour).
  const pages = Math.min(parseInt(c.req.query('pages') || String(DEFAULT_PAGES_PER_CALL), 10) || DEFAULT_PAGES_PER_CALL, MAX_PAGES_PER_CALL);
  const store = storeFromEnv(c.env, market);
  if (!store?.url || !store?.key || !store?.secret) {
    return c.json({ error: `WooCommerce ${market} not configured` }, 401);
  }
  const result = await runBackfillChunk(c.env, market, pages, 'backfill');
  return c.json(result);
});

// ─── Debug: dump Amazon report TSV headers + sample rows ───────────────────
//
// GET /api/admin/amazon/debug-report?id=N  — fetches the document for the
// given report_jobs row, downloads it (gunzip if needed), and returns the
// raw + normalized header names plus the first 3 data rows. Used to diagnose
// parser/column-name mismatches when an ingest produces unexpected nulls.
//
// Document URLs from /reports/2021-06-30/documents/{id} are presigned for ~5
// minutes — we fetch a fresh one on every call, so the underlying document
// remains fetchable for the full 14-day Amazon retention window.
adminRoutes.get('/amazon/debug-report', async (c) => {
  const jobId = parseInt(c.req.query('id') || '0', 10);
  if (!jobId) return c.json({ error: 'missing ?id=<report_job_id>' }, 400);
  const job = await c.env.DB.prepare(
    `SELECT id, market, report_type, range_label, status, document_id FROM report_jobs WHERE id = ?`,
  ).bind(jobId).first();
  if (!job) return c.json({ error: `job ${jobId} not found` }, 404);
  if (!job.document_id) return c.json({ error: 'job has no document_id', job }, 400);

  try {
    const doc = await spApiRequest(c.env, job.market, `/reports/2021-06-30/documents/${job.document_id}`);
    const r = await fetch(doc.url);
    if (!r.ok) return c.json({ error: `document download HTTP ${r.status}` }, 500);
    let stream = r.body;
    if (doc.compressionAlgorithm === 'GZIP') {
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
    const text = await new Response(stream).text();
    const lines = text.split('\n').filter((l) => l.trim()).slice(0, 4);
    if (lines.length === 0) return c.json({ error: 'empty document' });
    const rawHeaders = lines[0].split('\t');
    const normalizedHeaders = rawHeaders.map((h) => h.trim().toLowerCase().replace(/[- ]/g, '_'));
    const sampleRows = lines.slice(1).map((l) => {
      const cols = l.split('\t');
      return Object.fromEntries(normalizedHeaders.map((h, i) => [h, cols[i] || '']));
    });
    return c.json({
      jobId,
      reportType: job.report_type,
      rangeLabel: job.range_label,
      status:     job.status,
      market:     job.market,
      compressionAlgorithm: doc.compressionAlgorithm || 'none',
      headerCount: rawHeaders.length,
      rawHeaders,
      normalizedHeaders,
      firstByteHex: text.length > 0 ? text.charCodeAt(0).toString(16) : 'empty',  // catches BOM (0xfeff) issues
      sampleRows,
    });
  } catch (e) {
    return c.json({ error: redactSecrets(e?.message || String(e)) }, 500);
  }
});

// ─── Dedupe Amazon items (one-time cleanup for the v2.28 doubling bug) ────
//
// POST /api/admin/amazon/dedupe-items?market=CA   (or market=US, or omit for both)
//
// Before v2.29, ingestReadyJobs only deleted prior rows for the SAME job_id
// before re-inserting, so each ~24h re-fetch of an active range left the
// previous job's rows in amazon_items. handleAmazonSalesRequest aggregates
// across job_ids, so per-SKU monthly quantities scaled by the number of cron
// cycles that had touched that range. This endpoint walks every range_label
// for the requested market(s), keeps only the rows from the most-recent
// ingested job for that range, deletes the rest, and invalidates the sales
// cache so the next dashboard load reflects clean data immediately.
//
// Idempotent — safe to re-run. Returns a per-(market, range_label) summary.
adminRoutes.post('/amazon/dedupe-items', async (c) => {
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }
  const requested = (c.req.query('market') || '').toUpperCase();
  const markets = requested
    ? (['CA', 'US'].includes(requested) ? [requested] : [])
    : ['CA', 'US'];
  if (markets.length === 0) {
    return c.json({ error: 'market must be CA, US, or omitted (both)' }, 400);
  }

  const summary = [];
  let totalKept = 0;
  let totalDeleted = 0;

  for (const market of markets) {
    // For each range_label, find the most-recent ingested job_id. If a range
    // has only one ingested job, the IN-clause filter is a no-op (correct).
    const latestPerRange = await c.env.DB.prepare(
      `SELECT range_label, MAX(id) AS latest_job_id
       FROM report_jobs
       WHERE source = 'amazon' AND market = ? AND status = 'ingested'
       GROUP BY range_label`,
    ).bind(market).all();

    for (const row of (latestPerRange.results || [])) {
      const { range_label, latest_job_id } = row;

      // All ingested job_ids for this range — needed because amazon_items
      // doesn't carry range_label directly; we identify "rows belonging to
      // this range" by their report_job_id being any of these.
      const jobsForRange = await c.env.DB.prepare(
        `SELECT id FROM report_jobs
         WHERE source = 'amazon' AND market = ? AND status = 'ingested'
           AND range_label = ?`,
      ).bind(market, range_label).all();
      const jobIds = (jobsForRange.results || []).map((r) => r.id);
      if (jobIds.length <= 1) {
        // Only one job ever ingested this range — nothing to dedupe.
        const kept = await c.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM amazon_items WHERE market = ? AND report_job_id = ?`,
        ).bind(market, latest_job_id).first();
        summary.push({ market, range_label, latestJobId: latest_job_id, jobsSeen: 1, kept: kept?.n || 0, deleted: 0 });
        totalKept += kept?.n || 0;
        continue;
      }

      // Build the IN clause dynamically — D1 doesn't bind arrays.
      const placeholders = jobIds.map(() => '?').join(',');
      const supersededIds = jobIds.filter((id) => id !== latest_job_id);
      const supersededPh  = supersededIds.map(() => '?').join(',');

      const before = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM amazon_items WHERE market = ? AND report_job_id IN (${placeholders})`,
      ).bind(market, ...jobIds).first();
      const keptCount = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM amazon_items WHERE market = ? AND report_job_id = ?`,
      ).bind(market, latest_job_id).first();

      // Delete every row tied to a superseded job for this range.
      const delRes = await c.env.DB.prepare(
        `DELETE FROM amazon_items WHERE market = ? AND report_job_id IN (${supersededPh})`,
      ).bind(market, ...supersededIds).run();

      const deleted = (delRes.meta?.changes ?? ((before?.n || 0) - (keptCount?.n || 0)));
      summary.push({
        market,
        range_label,
        latestJobId: latest_job_id,
        jobsSeen:    jobIds.length,
        kept:        keptCount?.n || 0,
        deleted,
      });
      totalKept    += keptCount?.n || 0;
      totalDeleted += deleted;
    }

    // Bust the sales cache so the dashboard's next /api/amazon/sales call
    // re-aggregates from the now-clean amazon_items.
    await invalidateAmazonSalesCache(c.env, market);
  }

  return c.json({
    ok:           true,
    markets,
    totalKept,
    totalDeleted,
    rangesProcessed: summary.length,
    summary,
    note: 'Sales cache invalidated. Reload the dashboard or hit Refresh to see cleaned numbers.',
  });
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
  const source = (c.req.query('source') || 'woo').toLowerCase();
  if (!market || !['CA', 'US'].includes(market)) {
    return c.json({ error: 'market must be CA or US' }, 400);
  }
  if (!c.env.DB) {
    return c.json({ error: 'D1 binding DB not configured' }, 500);
  }

  if (source === 'amazon') {
    // Amazon reconcile is D1-only for now — SP-API has no cheap "give me a
    // count for [after, before)" equivalent of Woo's X-WP-Total header. We
    // surface enough state to spot-check whether the watermark is moving and
    // the Reports state machine is making progress.
    const [monthly, syncState, jobs] = await Promise.all([
      c.env.DB.prepare(
        `SELECT substr(local_date, 1, 7) AS ym, COUNT(*) AS n_orders, SUM(total) AS revenue
         FROM amazon_orders WHERE market = ? GROUP BY ym ORDER BY ym`,
      ).bind(market).all(),
      c.env.DB.prepare(
        `SELECT watermark, last_synced_at FROM sync_state WHERE source = 'amazon' AND market = ?`,
      ).bind(market).first(),
      c.env.DB.prepare(
        `SELECT range_label, status, attempts, rows_total, rows_matched, rows_unmatched,
                rows_wrong_market, filter_signal, error, updated_at
         FROM report_jobs WHERE source = 'amazon' AND market = ?
         ORDER BY range_label DESC, id DESC`,
      ).bind(market).all(),
    ]);
    const totals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(total) AS s FROM amazon_orders WHERE market = ?`,
    ).bind(market).first();
    return c.json({
      source: 'amazon',
      market,
      orders: {
        d1Count:   totals?.n || 0,
        d1Revenue: totals?.s ? +Number(totals.s).toFixed(2) : 0,
        watermark: syncState?.watermark || null,
        lastSync:  syncState?.last_synced_at || null,
        monthly:   (monthly.results || []).map((r) => ({
          yearMonth: r.ym, d1Count: r.n_orders, d1Revenue: r.revenue ? +r.revenue.toFixed(2) : 0,
        })),
      },
      reportJobs: monthly.results ? (jobs.results || []) : [],
      notes: [
        'Amazon reconcile is D1-only — SP-API has no cheap remote count comparator.',
        'Watermark advances after every Orders chunk; lastSync updates each successful chunk.',
        'reportJobs surfaces every job (latest first). status=ingested means rows landed; status=failed needs investigation.',
        'Manual catch-up: POST /api/admin/backfill?source=amazon&market=CA — loop until orders.more=false; pass nextToken back in.',
      ],
    });
  }

  // Default — WooCommerce reconcile (existing behaviour).
  const store = storeFromEnv(c.env, market);
  if (!store?.url || !store?.key || !store?.secret) {
    return c.json({ error: `WooCommerce ${market} not configured` }, 401);
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
