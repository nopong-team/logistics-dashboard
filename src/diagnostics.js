/**
 * Cross-source diagnostics endpoints.
 *
 *   GET /api/sync-status   — per-source freshness for the dashboard's sync bar.
 *                            Reads sync_state + COUNT(*) per source+market,
 *                            plus FBA inventory snapshots from KV.
 *   GET /api/audit         — read-only data audit. Powers the "Data Health"
 *                            panel's checks (revenue reconciliation, duplicate
 *                            order IDs, marketplace filter, SKU mapping
 *                            coverage, daily order flow).
 *   GET /api/import-log    — unified activity log of every cron tick / manual
 *                            backfill / report state change / KV-snapshot
 *                            upload across the past `?hours=N` (default 24,
 *                            cap 168). Powers the dashboard's Activity dropdown
 *                            — the "is the data fresh?" answer that sits beside
 *                            "Last updated".
 *
 * All three are public-within-Access (no ADMIN_KEY) — same posture as the
 * legacy Express routes, since they expose nothing the dashboard SPA doesn't
 * already consume.
 *
 * Per-source schema means the legacy "CA vs US byte-identical" check can never
 * fire structurally (separate amazon_orders + amazon_items tables), so we
 * report `caUsIdentical: false` and lean on filter_signal / wrong_market_count
 * from report_jobs to surface real divergence.
 */

import { Hono } from 'hono';
import { buildMonthWindow, getWeekKey, getBusinessToday } from './timezone.js';

// First day of LAST month (Eastern) — the start of the "active" report ranges
// (this month + last month) that re-fetch on a ~24h gate. Rows older than this
// live in frozen ranges that never re-seed, so they must NOT be counted by the
// line-id coverage guard (they'd never clear and would nag forever).
function activeRangeStart() {
  let [y, m] = getBusinessToday().split('-').map(Number);
  m -= 1; if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

export const diagnosticsRoutes = new Hono();

// ─── Timestamp normalisation ───────────────────────────────────────────────
//
// New writes use strftime('%Y-%m-%dT%H:%M:%SZ', 'now') so D1 columns end up
// as ISO-8601 UTC with explicit Z. But until a row is overwritten, older
// values written with the legacy datetime('now') call still come back as
// naive 'YYYY-MM-DD HH:MM:SS' strings — which JavaScript's `new Date()`
// parses as LOCAL time, producing a timezone-shifted display on any non-UTC
// machine. (We hit this on Chris's UTC+9 machine: chip showed "13h ago" for
// a 4h-old timestamp.)
//
// toIsoUtc normalises both formats to ISO Z so frontend timestamp parsing
// works regardless of which write-era a row came from. Applied to every
// timestamp this module surfaces.

export function toIsoUtc(s) {
  if (!s) return null;
  if (typeof s !== 'string') s = String(s);
  // Already ISO-with-offset (Z or +/-HH:MM) — pass through.
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return s;
  // SQLite naive 'YYYY-MM-DD HH:MM:SS[.fff]' (UTC by SQLite convention).
  // Replace the space with T and append Z so JS treats it as UTC.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.replace(' ', 'T') + 'Z';
  }
  return s; // Some other shape — leave alone, let the caller handle.
}

// FBA Inventory KV key shape — kept in sync with src/amazon.js. We read from
// here without going through the Amazon module to avoid a paginated SP-API
// fetch on the audit/sync-status hot paths; if the snapshot doesn't exist
// yet the field just reports null/0.
const FBA_INVENTORY_KV_KEY = (market) => `amazon:inventory:${market.toUpperCase()}`;

// ─── /api/sync-status ──────────────────────────────────────────────────────
//
// Per-source freshness map. The dashboard's loadAllData() reads
// `wooCA.lastSync`, `wooUS.lastSync`, `amzCA.lastSync`, `amzUS.lastSync` to
// power the per-source-time chips in the sync status bar. Other fields
// (orderCount, syncing) are kept for parity with the legacy shape even though
// they're informational only.
//
// `syncing` is always false — Workers cron is fire-and-forget and there's no
// in-flight lock to expose. The legacy file-cache lock was a Node-server
// concept that doesn't apply here.

diagnosticsRoutes.get('/sync-status', async (c) => {
  if (!c.env.DB) return c.json({ error: 'D1 binding DB not configured' }, 500);
  const cache = c.env.CACHE;

  // Pull every sync_state row in one go and key it for lookup.
  const stateRes = await c.env.DB.prepare(
    `SELECT source, market, watermark, last_synced_at
     FROM sync_state`,
  ).all();
  const stateBy = {};
  for (const r of (stateRes.results || [])) {
    stateBy[`${r.source}:${r.market}`] = r;
  }

  // Order counts in parallel for both sources × both markets, plus the two
  // Amazon Reports chip queries (one tick-freshness, one ranges-ingested per
  // market). All six are independent reads — no point serialising.
  //
  // Reports freshness comes from sync_logs (canonical "tick fired" history)
  // not sync_state — sync_state's amazon row is owned by runAmazonOrdersChunk
  // and we don't want to collide on its key. The MAX(run_at) here will move
  // every 15 min once Layer 1's heartbeat ships; before then it's null.
  //
  // ingestedCount + totalCount let the chip tooltip render "12/12 ingested"
  // (or "9/12 ingested · 3 pending" mid-backfill) without a separate roundtrip.
  const [wooCa, wooUs, amzCa, amzUs, amzReportsCaTick, amzReportsUsTick, amzReportsCaJobs, amzReportsUsJobs] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders        WHERE market = 'CA'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders        WHERE market = 'US'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM amazon_orders WHERE market = 'CA'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM amazon_orders WHERE market = 'US'`).first(),
    c.env.DB.prepare(
      `SELECT MAX(run_at) AS lastSync
       FROM sync_logs
       WHERE source = 'amazon' AND market = 'CA' AND action = 'amazon-reports'`,
    ).first(),
    c.env.DB.prepare(
      `SELECT MAX(run_at) AS lastSync
       FROM sync_logs
       WHERE source = 'amazon' AND market = 'US' AND action = 'amazon-reports'`,
    ).first(),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n
       FROM report_jobs
       WHERE source = 'amazon' AND market = 'CA'
       GROUP BY status`,
    ).all(),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n
       FROM report_jobs
       WHERE source = 'amazon' AND market = 'US'
       GROUP BY status`,
    ).all(),
  ]);

  // Roll the per-status counts up into ingested/total per market. Mid-backfill
  // states (pending, ready, failed) all count toward total but only ingested
  // counts toward "done". Anything not-yet-seeded shows as a smaller total
  // until the next seed phase fills it in.
  function rollupJobs(res) {
    const by = {};
    let total = 0;
    for (const r of (res?.results || [])) {
      by[r.status] = r.n;
      total += r.n;
    }
    return { ingested: by.ingested || 0, total };
  }
  const caJobs = rollupJobs(amzReportsCaJobs);
  const usJobs = rollupJobs(amzReportsUsJobs);

  // FBA inventory cached snapshots + the three KV-only connectors. Best-effort
  // — any of these may not be in KV yet on a fresh env, in which case the chip
  // just renders "never" until the first ingest/upload.
  let amzInvCa = null, amzInvUs = null, logiwa = null, sbInv = null;
  if (cache) {
    [amzInvCa, amzInvUs, logiwa, sbInv] = await Promise.all([
      cache.get(FBA_INVENTORY_KV_KEY('CA'),    'json'),
      cache.get(FBA_INVENTORY_KV_KEY('US'),    'json'),
      cache.get('logiwa:inventory:current',    'json'),
      cache.get('salesbinder:inventory',       'json'),
    ]);
  }

  // Xero freshness = the xero_tokens.updated_at row (last successful token
  // refresh / re-auth). If the row isn't there or D1 is unreachable, leave the
  // chip null — "never" reads cleanly. Wrapped in try/catch so an absent table
  // on a fresh env doesn't take the rest of /api/sync-status with it.
  let xeroLastSync = null;
  try {
    const xeroRow = await c.env.DB.prepare(
      `SELECT updated_at FROM xero_tokens WHERE id = 1`,
    ).first();
    xeroLastSync = toIsoUtc(xeroRow?.updated_at) || null;
  } catch { /* table missing on a fresh env — silent */ }

  return c.json({
    wooCA: {
      lastSync:   toIsoUtc(stateBy['woo:CA']?.last_synced_at) || null,
      orderCount: wooCa?.n || 0,
      syncing:    false,
    },
    wooUS: {
      lastSync:   toIsoUtc(stateBy['woo:US']?.last_synced_at) || null,
      orderCount: wooUs?.n || 0,
      syncing:    false,
    },
    amzCA: {
      lastSync:     toIsoUtc(stateBy['amazon:CA']?.last_synced_at) || null,
      orderCount:   amzCa?.n || 0,
      syncComplete: true,
      syncing:      false,
    },
    amzUS: {
      lastSync:     toIsoUtc(stateBy['amazon:US']?.last_synced_at) || null,
      orderCount:   amzUs?.n || 0,
      syncComplete: true,
      syncing:      false,
    },
    // Amazon Reports — separate chips from Amazon Orders because they ride a
    // different state machine (12 ranges per market, async POST→poll→ingest)
    // and their freshness story is independent of Orders. lastSync comes from
    // the Layer 1 heartbeat row in sync_logs; ingestedCount/totalCount let the
    // chip tooltip render "12/12 ranges ingested" without a separate roundtrip.
    amzReportsCA: {
      lastSync:      toIsoUtc(amzReportsCaTick?.lastSync) || null,
      ingestedCount: caJobs.ingested,
      totalCount:    caJobs.total,
      syncing:       false,
    },
    amzReportsUS: {
      lastSync:      toIsoUtc(amzReportsUsTick?.lastSync) || null,
      ingestedCount: usJobs.ingested,
      totalCount:    usJobs.total,
      syncing:       false,
    },
    amzInvCA: {
      lastSync: amzInvCa?.lastSync || null, // already ISO-Z (KV writes from JS)
      count:    amzInvCa?.count || 0,
      syncing:  false,
    },
    amzInvUS: {
      lastSync: amzInvUs?.lastSync || null, // already ISO-Z (KV writes from JS)
      count:    amzInvUs?.count || 0,
      syncing:  false,
    },
    // Logiwa is a CSV upload, not a pull — lastSync = uploadedAt of the most
    // recent snapshot. fileName surfaced for tooltip use on the chip.
    logiwa: {
      lastSync: logiwa?.uploadedAt || logiwa?.storedAt || null,
      count:    logiwa?.count      || logiwa?.inventory?.length || 0,
      fileName: logiwa?.fileName   || null,
    },
    salesBinder: {
      lastSync: sbInv?.lastSync || null,
      count:    sbInv?.inventory?.length ?? sbInv?.count ?? 0,
    },
    xero: {
      lastSync:  xeroLastSync,
      connected: !!xeroLastSync,
    },
  });
});

// ─── /api/audit ────────────────────────────────────────────────────────────
//
// Read-only data audit. The frontend's runDataHealthChecks() reads:
//   audit.woo[mkt].monthlyRevenue / monthlyOrders / skuTotals[].monthly[]
//                .orderIdCount / uniqueOrderIds
//                .dailyOrderCounts{date: count}
//                .lastSync / monthWindowStart
//   audit.amazon.caUsIdentical (bool)
//                .caSkuCount / usSkuCount
//                .caLastSync / usLastSync / monthWindowStart
//                .caUnmatchedSkus[] / usUnmatchedSkus[] (sample list)
//                .caUnmatchedCount / usUnmatchedCount
//                .caFilterSignals[] / usFilterSignals[]
//                .caWrongMarketCount / usWrongMarketCount
//   audit.lastSync = { wooCA, wooUS, amzCA, amzUS } convenience map.
//
// In the per-source D1 world the "byte-identical caches" check is structurally
// impossible (separate tables), so caUsIdentical is hard-false and the real
// divergence info comes from report_jobs.filter_signal + rows_wrong_market.

function aggregateWooMonthly(monthRows, itemRows) {
  const { monthMap } = buildMonthWindow();
  const monthlyRevenue = [0, 0, 0, 0, 0, 0];
  const monthlyOrders  = [0, 0, 0, 0, 0, 0];
  const skuTotals = {};

  for (const r of monthRows) {
    const idx = monthMap[r.ym];
    if (idx === undefined) continue;
    monthlyRevenue[idx] = r.revenue || 0;
    monthlyOrders[idx]  = r.n_orders || 0;
  }
  for (const r of itemRows) {
    const sku = r.sku || 'unknown';
    if (!skuTotals[sku]) {
      skuTotals[sku] = {
        qty: 0, revenue: 0, name: r.name || '',
        monthly:    [0, 0, 0, 0, 0, 0],
        monthlyQty: [0, 0, 0, 0, 0, 0],
        weeklyQty:  {},
      };
    } else if (!skuTotals[sku].name && r.name) {
      skuTotals[sku].name = r.name;
    }
    const qty     = r.qty || 0;
    const revenue = r.revenue || 0;
    skuTotals[sku].qty     += qty;
    skuTotals[sku].revenue += revenue;
    const ym = (r.day || '').substring(0, 7);
    const idx = monthMap[ym];
    if (idx !== undefined) {
      skuTotals[sku].monthly[idx]    += revenue;
      skuTotals[sku].monthlyQty[idx] += qty;
    }
    const wk = getWeekKey(r.day);
    if (wk) skuTotals[sku].weeklyQty[wk] = (skuTotals[sku].weeklyQty[wk] || 0) + qty;
  }
  return { monthlyRevenue, monthlyOrders, skuTotals };
}

async function buildWooAuditForMarket(env, market, startDate) {
  const [monthRes, itemRes, idRes, dailyRes, stateRes] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(local_date, 1, 7) AS ym,
              COUNT(*)                 AS n_orders,
              SUM(total)               AS revenue
       FROM orders
       WHERE market = ?
         AND status IN ('completed','processing')
         AND local_date >= ?
       GROUP BY ym`,
    ).bind(market, startDate).all(),
    env.DB.prepare(
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
    // orders.id is the Woo order ID and is the table's PK — uniqueness is
    // enforced structurally, so orderIdCount === uniqueOrderIds. We surface
    // both for parity with the legacy shape; the frontend's duplicate-IDs
    // check just becomes a tautological pass.
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE market = ?`,
    ).bind(market).first(),
    env.DB.prepare(
      `SELECT local_date AS day, COUNT(*) AS n
       FROM orders
       WHERE market = ?
         AND status IN ('completed','processing')
         AND local_date >= ?
       GROUP BY local_date
       ORDER BY local_date ASC`,
    ).bind(market, startDate).all(),
    env.DB.prepare(
      `SELECT last_synced_at FROM sync_state WHERE source = 'woo' AND market = ?`,
    ).bind(market).first(),
  ]);

  const { monthlyRevenue, monthlyOrders, skuTotals } = aggregateWooMonthly(
    monthRes.results || [], itemRes.results || [],
  );
  const dailyOrderCounts = {};
  for (const r of (dailyRes.results || [])) dailyOrderCounts[r.day] = r.n;

  return {
    monthlyRevenue,
    monthlyOrders,
    skuTotals,
    orderIdCount:    idRes?.n || 0,
    uniqueOrderIds:  idRes?.n || 0, // structurally equal — see note above
    dailyOrderCounts,
    lastSync:         toIsoUtc(stateRes?.last_synced_at) || null,
    monthWindowStart: startDate,
  };
}

// Count amazon_items rows tied to superseded (non-latest) ingested jobs per
// range_label for a market. >0 means the v2.28 doubling bug has rows still
// sitting in D1 — either pre-fix data not yet cleaned up, or a regression.
// Powers the Data Health "Amazon SKU rows duplicated across jobs" check, the
// blind spot that let the original bug ship green for weeks. SQL: per
// range_label, find MAX(id) of ingested jobs (the survivor) and count rows
// tied to OTHER ingested jobs for the same range. Sums across range_labels.
async function countAmazonSupersededRows(env, market) {
  const res = await env.DB.prepare(
    `SELECT COALESCE(SUM(superseded), 0) AS n
     FROM (
       SELECT (
         SELECT COUNT(*)
         FROM amazon_items ai
         WHERE ai.market = rj.market
           AND ai.report_job_id IN (
             SELECT id FROM report_jobs
             WHERE source = 'amazon' AND market = rj.market
               AND range_label = rj.range_label AND status = 'ingested'
           )
           AND ai.report_job_id != (
             SELECT MAX(id) FROM report_jobs
             WHERE source = 'amazon' AND market = rj.market
               AND range_label = rj.range_label AND status = 'ingested'
           )
       ) AS superseded
       FROM report_jobs rj
       WHERE rj.source = 'amazon' AND rj.market = ? AND rj.status = 'ingested'
       GROUP BY rj.range_label
     )`,
  ).bind(market).first();
  return res?.n || 0;
}

// TRUE dedup invariant (post-migration 0008): count how many extra rows exist
// beyond one per (market, shipment_item_id). Must be 0. Unlike the superseded
// check this catches duplicates ACROSS range_labels too, and it's independent of
// job bookkeeping — it's the real "is any order line double-counted" question.
async function countAmazonDuplicateIdentities(env, market) {
  const res = await env.DB.prepare(
    `SELECT COALESCE(SUM(extra), 0) AS n FROM (
       SELECT COUNT(*) - 1 AS extra
       FROM amazon_items
       WHERE market = ? AND shipment_item_id IS NOT NULL
       GROUP BY shipment_item_id
       HAVING COUNT(*) > 1
     )`,
  ).bind(market).first();
  return res?.n || 0;
}

// Line-id coverage across the ACTIVE report ranges only (this + last month).
// Returns { missing, withId }. `missing` = matched rows with no shipment_item_id;
// `withId` = matched rows that have one. Scoped to activeRangeStart so frozen
// historical rows (which never re-seed and keep their legacy NULL id forever)
// don't count. The frontend uses withId to tell "just deployed, waiting for the
// first re-fetch" (withId 0 → calm) apart from a genuine problem.
async function amazonLineIdCoverage(env, market, activeStart) {
  const res = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN shipment_item_id IS NULL     THEN 1 ELSE 0 END), 0) AS missing,
       COALESCE(SUM(CASE WHEN shipment_item_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_id
     FROM amazon_items
     WHERE market = ? AND dashboard_sku IS NOT NULL AND local_date >= ?`,
  ).bind(market, activeStart).first();
  return { missing: res?.missing || 0, withId: res?.with_id || 0 };
}

async function buildAmazonAudit(env) {
  const { startDate } = buildMonthWindow();
  const activeStart = activeRangeStart();
  const [caSku, usSku, caState, usState, caJobs, usJobs, caSuperseded, usSuperseded,
         caDupIdentity, usDupIdentity, caCoverage, usCoverage] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(DISTINCT dashboard_sku) AS n
       FROM amazon_items
       WHERE market = 'CA' AND dashboard_sku IS NOT NULL AND local_date >= ?`,
    ).bind(startDate).first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT dashboard_sku) AS n
       FROM amazon_items
       WHERE market = 'US' AND dashboard_sku IS NOT NULL AND local_date >= ?`,
    ).bind(startDate).first(),
    env.DB.prepare(
      `SELECT last_synced_at FROM sync_state WHERE source = 'amazon' AND market = 'CA'`,
    ).first(),
    env.DB.prepare(
      `SELECT last_synced_at FROM sync_state WHERE source = 'amazon' AND market = 'US'`,
    ).first(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(rows_unmatched), 0)    AS unmatched,
              COALESCE(SUM(rows_wrong_market), 0) AS wrong_market,
              GROUP_CONCAT(DISTINCT filter_signal) AS signals
       FROM report_jobs
       WHERE source = 'amazon' AND market = 'CA' AND status = 'ingested'`,
    ).first(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(rows_unmatched), 0)    AS unmatched,
              COALESCE(SUM(rows_wrong_market), 0) AS wrong_market,
              GROUP_CONCAT(DISTINCT filter_signal) AS signals
       FROM report_jobs
       WHERE source = 'amazon' AND market = 'US' AND status = 'ingested'`,
    ).first(),
    countAmazonSupersededRows(env, 'CA'),
    countAmazonSupersededRows(env, 'US'),
    countAmazonDuplicateIdentities(env, 'CA'),
    countAmazonDuplicateIdentities(env, 'US'),
    amazonLineIdCoverage(env, 'CA', activeStart),
    amazonLineIdCoverage(env, 'US', activeStart),
  ]);

  const splitSignals = (s) => (s ? String(s).split(',').filter(Boolean) : []);

  return {
    // Per-source schema makes byte-identical caches structurally impossible —
    // CA and US live in physically separate rows. Hard-false so the frontend's
    // health check renders the "separated via X / Y" pass label.
    caUsIdentical:      false,
    caSkuCount:         caSku?.n || 0,
    usSkuCount:         usSku?.n || 0,
    caLastSync:         toIsoUtc(caState?.last_synced_at) || null,
    usLastSync:         toIsoUtc(usState?.last_synced_at) || null,
    monthWindowStart:   startDate,
    // Per-row unmatched-SKU strings aren't persisted (only the count), so the
    // sample arrays stay empty. The count is the load-bearing signal.
    caUnmatchedSkus:    [],
    usUnmatchedSkus:    [],
    caUnmatchedCount:   caJobs?.unmatched     || 0,
    usUnmatchedCount:   usJobs?.unmatched     || 0,
    caFilterSignals:    splitSignals(caJobs?.signals),
    usFilterSignals:    splitSignals(usJobs?.signals),
    caWrongMarketCount: caJobs?.wrong_market  || 0,
    usWrongMarketCount: usJobs?.wrong_market  || 0,
    // Doubling-bug guard: rows in amazon_items belonging to superseded
    // (non-latest) ingested jobs for the same range_label, per market.
    // Should be 0 in steady state. >0 = stale duplicate rows are still in
    // D1 (run POST /api/admin/amazon/dedupe-items to clean), or — if it
    // climbs after a clean run — the ingest fix has regressed.
    caSupersededRowCount: caSuperseded,
    usSupersededRowCount: usSuperseded,
    // v2.36 bulletproof dedup (migration 0008). duplicateIdentityCount is the
    // true invariant — 0 means no order line is double-counted anywhere, across
    // ranges included. missingLineIdCount flags rows the report delivered with
    // no shipment-item-id (dedup then falls back to range-supersede only).
    caDuplicateIdentityCount: caDupIdentity,
    usDuplicateIdentityCount: usDupIdentity,
    // Active-range line-id coverage (this + last month). *MissingLineIdCount =
    // rows still on the legacy NULL id; *LineIdActiveCount = rows already carrying
    // one. A calm "waiting for first re-fetch" state = missing>0 while active==0.
    caMissingLineIdCount:  caCoverage.missing,
    usMissingLineIdCount:  usCoverage.missing,
    caLineIdActiveCount:   caCoverage.withId,
    usLineIdActiveCount:   usCoverage.withId,
  };
}

diagnosticsRoutes.get('/audit', async (c) => {
  if (!c.env.DB) return c.json({ error: 'D1 binding DB not configured' }, 500);
  const { startDate } = buildMonthWindow();

  const [wooCA, wooUS, amazon] = await Promise.all([
    buildWooAuditForMarket(c.env, 'CA', startDate),
    buildWooAuditForMarket(c.env, 'US', startDate),
    buildAmazonAudit(c.env),
  ]);

  return c.json({
    woo:    { CA: wooCA, US: wooUS },
    amazon,
    // wooCA.lastSync etc. are already ISO-normalised inside buildWooAuditForMarket
    // / buildAmazonAudit; this convenience block just re-projects them.
    lastSync: {
      wooCA: wooCA.lastSync,
      wooUS: wooUS.lastSync,
      amzCA: amazon.caLastSync,
      amzUS: amazon.usLastSync,
    },
  });
});

// ─── /api/import-log ───────────────────────────────────────────────────────
//
// Unified activity feed for the dashboard's "Activity" dropdown. Returns a
// single sorted-by-timestamp-desc array of rows describing every recent piece
// of system activity:
//
//   • sync_logs                    → cron-tick / manual-backfill / reconcile
//                                    rows for Woo and Amazon Orders.
//   • report_jobs                  → Amazon Reports state-machine snapshot
//                                    (one row per job, latest state surfaced).
//   • KV markers (FBA, SalesBinder,
//     Logiwa)                      → "current snapshot" rows — these sources
//                                    don't have a per-tick history by design.
//   • xero_tokens.updated_at       → "current snapshot" of the OAuth tokens.
//
// Row shape (stable wire contract — frontend renders fields verbatim):
//   { when, source, market, action, status, summary, durationMs, scope }
// where `scope` is 'tick' for sync_logs, 'snapshot' for KV/single-row reads,
// and 'job' for report_jobs entries.
//
// Query params:
//   hours  — lookback window for sync_logs (default 24, max 168 = 7 days)
//   limit  — total rows cap after merge (default 200, max 1000)
//
// KV/snapshot rows always render regardless of the `hours` filter — they're
// the source-of-truth for "is this connector even alive". sync_logs and
// report_jobs entries respect the lookback so we don't render last week's
// ~600 cron ticks every time the dropdown opens.

// FBA_INVENTORY_KV_KEY is already declared at the top of this file (used by
// /api/sync-status). Only add the new ones the import log needs.
const SALESBINDER_INVENTORY_KV_KEY = 'salesbinder:inventory';
const SALESBINDER_PACKAGING_KV_KEY = 'salesbinder:packaging';
const LOGIWA_KV_KEY = 'logiwa:inventory:current';

function summariseSyncLog(row) {
  // status is 'ok' | 'error' | 'rate_limited' | 'partial'.
  if (row.status === 'rate_limited') return row.error || 'rate-limited by upstream';
  if (row.status === 'error')        return row.error?.substring(0, 200) || 'error';

  // Amazon Reports heartbeat rows reuse orders_added/items_added as
  // jobs-ingested/polls-advanced counters (see runAmazonReportsTick in
  // src/amazon.js). The "0 new orders" language doesn't fit, so render with
  // Reports-native vocabulary. Idle ticks are normal — once all 24 ranges are
  // ingested, most ticks do no work; we show that explicitly so the activity
  // log doesn't read as "broken" when it's actually "healthy and quiet".
  if (row.action === 'amazon-reports') {
    const ing = row.orders_added || 0;
    const pol = row.items_added  || 0;
    if (ing === 0 && pol === 0) return 'idle (all ranges fresh)';
    if (pol === 0) return `+${ing} job${ing === 1 ? '' : 's'} ingested`;
    if (ing === 0) return `+${pol} poll${pol === 1 ? '' : 's'} advanced`;
    return `+${ing} job${ing === 1 ? '' : 's'} ingested, +${pol} poll${pol === 1 ? '' : 's'} advanced`;
  }

  const ord = row.orders_added || 0;
  const itm = row.items_added  || 0;
  if (ord === 0 && itm === 0) return '0 new orders, system healthy';
  if (itm === 0)              return `+${ord} order${ord === 1 ? '' : 's'}`;
  return `+${ord} order${ord === 1 ? '' : 's'}, +${itm} item${itm === 1 ? '' : 's'}`;
}

function summariseReportJob(row) {
  // report_jobs.status: pending | ready | ingested | failed.
  if (row.status === 'ingested') {
    const matched   = row.rows_matched   || 0;
    const unmatched = row.rows_unmatched || 0;
    const wrong     = row.rows_wrong_market || 0;
    const tail = unmatched || wrong
      ? ` (${unmatched} unmatched, ${wrong} wrong-market)`
      : '';
    return `${row.range_label || '?'} ingested · ${matched} rows matched${tail}`;
  }
  if (row.status === 'failed') {
    return `${row.range_label || '?'} failed: ${(row.error || 'unknown').substring(0, 160)}`;
  }
  if (row.status === 'ready') {
    return `${row.range_label || '?'} ready to ingest`;
  }
  // pending — surface poll attempts so a stuck job is visible.
  const attempts = row.attempts || 0;
  return `${row.range_label || '?'} pending (${attempts} poll${attempts === 1 ? '' : 's'})`;
}

diagnosticsRoutes.get('/import-log', async (c) => {
  if (!c.env.DB) return c.json({ error: 'D1 binding DB not configured' }, 500);

  const hours = Math.min(Math.max(parseInt(c.req.query('hours') || '24', 10) || 24, 1), 168);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '200', 10) || 200, 10), 1000);
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // 1. sync_logs (Woo + Amazon Orders cron ticks, manual backfills, reconciles).
  //    Filter by run_at >= sinceIso. Both string formats (legacy naive +
  //    ISO-Z) sort lexicographically the same way for the same wall-clock
  //    instant after ' '↔'T' normalisation, but legacy rows lack the Z and
  //    sort BEFORE their ISO equivalent — to handle the boundary cleanly we
  //    just compare using SQL substr(run_at, 1, 19) which strips the trailing
  //    Z and matches both shapes.
  const sinceCmp = sinceIso.substring(0, 19); // 'YYYY-MM-DDTHH:MM:SS'
  const sinceLegacy = sinceCmp.replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS'
  const syncLogsRes = await c.env.DB.prepare(
    `SELECT run_at, source, market, action, status, error,
            orders_added, items_added, duration_ms
     FROM sync_logs
     WHERE substr(replace(run_at, 'T', ' '), 1, 19) >= ?
     ORDER BY run_at DESC
     LIMIT ?`,
  ).bind(sinceLegacy, limit).all();

  const rows = [];
  for (const r of (syncLogsRes.results || [])) {
    // Relabel Reports heartbeat rows so they render as a distinct source in
    // the activity log. The underlying sync_logs row uses source='amazon'
    // (single source-of-truth for Amazon ticks at the storage level), but in
    // the user-facing feed Orders and Reports should be visually separate —
    // and report_jobs rows below already use source='amazon-reports', so
    // matching the convention groups them together. Action discriminator
    // stays on the row so summariseSyncLog still picks the right vocabulary.
    const displaySource = r.action === 'amazon-reports' ? 'amazon-reports' : r.source;
    rows.push({
      when:       toIsoUtc(r.run_at),
      source:     displaySource,
      market:     r.market || null,
      action:     r.action || 'sync',
      status:     r.status || 'ok',
      summary:    summariseSyncLog(r),
      durationMs: r.duration_ms || null,
      scope:      'tick',
    });
  }

  // 2. report_jobs (Amazon Reports state machine). One row per job, surfacing
  //    the most recent updated_at — that's the latest state transition.
  const reportJobsRes = await c.env.DB.prepare(
    `SELECT updated_at, market, range_label, status, attempts, error,
            rows_total, rows_matched, rows_unmatched, rows_wrong_market
     FROM report_jobs
     WHERE source = 'amazon'
       AND substr(replace(updated_at, 'T', ' '), 1, 19) >= ?
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(sinceLegacy, limit).all();
  for (const r of (reportJobsRes.results || [])) {
    const status = r.status === 'ingested' ? 'ok'
                 : r.status === 'failed'   ? 'error'
                 : r.status === 'ready'    ? 'ok'
                 : 'pending';
    rows.push({
      when:       toIsoUtc(r.updated_at),
      source:     'amazon-reports',
      market:     r.market || null,
      action:     r.status, // pending | ready | ingested | failed — semantic value
      status,
      summary:    summariseReportJob(r),
      durationMs: null,
      scope:      'job',
    });
  }

  // 3. Snapshot rows — KV-backed connectors and Xero. These don't have a
  //    per-tick history by design, so we surface the "current state" with
  //    its associated timestamp regardless of the hours window. If the
  //    timestamp falls outside the window the row is still useful: it's
  //    proving the connector is alive (or, if missing, that it isn't).
  const cache = c.env.CACHE;
  if (cache) {
    const [fbaCa, fbaUs, sbInv, sbPkg, logiwa] = await Promise.all([
      cache.get(FBA_INVENTORY_KV_KEY('CA'), 'json'),
      cache.get(FBA_INVENTORY_KV_KEY('US'), 'json'),
      cache.get(SALESBINDER_INVENTORY_KV_KEY, 'json'),
      cache.get(SALESBINDER_PACKAGING_KV_KEY, 'json'),
      cache.get(LOGIWA_KV_KEY, 'json'),
    ]);
    if (fbaCa?.lastSync) {
      rows.push({
        when:       toIsoUtc(fbaCa.lastSync),
        source:     'amazon-fba-inventory',
        market:     'CA',
        action:     'snapshot',
        status:     'ok',
        summary:    `${fbaCa.count || 0} SKU${(fbaCa.count || 0) === 1 ? '' : 's'} cached`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
    if (fbaUs?.lastSync) {
      rows.push({
        when:       toIsoUtc(fbaUs.lastSync),
        source:     'amazon-fba-inventory',
        market:     'US',
        action:     'snapshot',
        status:     'ok',
        summary:    `${fbaUs.count || 0} SKU${(fbaUs.count || 0) === 1 ? '' : 's'} cached`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
    if (sbInv?.lastSync) {
      rows.push({
        when:       toIsoUtc(sbInv.lastSync),
        source:     'salesbinder',
        market:     null,
        action:     'snapshot',
        status:     'ok',
        summary:    `${sbInv.inventory?.length ?? sbInv.count ?? '?'} inventory rows cached`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
    if (sbPkg?.lastSync) {
      rows.push({
        when:       toIsoUtc(sbPkg.lastSync),
        source:     'salesbinder-packaging',
        market:     null,
        action:     'snapshot',
        status:     'ok',
        summary:    `${sbPkg.items?.length ?? sbPkg.count ?? '?'} packaging rows cached`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
    if (logiwa?.uploadedAt || logiwa?.storedAt) {
      const when = logiwa.uploadedAt || logiwa.storedAt;
      const fname = logiwa.fileName ? ` (${logiwa.fileName})` : '';
      rows.push({
        when:       toIsoUtc(when),
        source:     'logiwa',
        market:     null,
        action:     'upload',
        status:     'ok',
        summary:    `${logiwa.count || logiwa.inventory?.length || 0} rows uploaded${fname}`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
  }

  // 4. Xero tokens — updated_at on the single-row table is the freshness anchor.
  try {
    const xeroRow = await c.env.DB.prepare(
      `SELECT updated_at, tenant_name FROM xero_tokens WHERE id = 1`,
    ).first();
    if (xeroRow?.updated_at) {
      rows.push({
        when:       toIsoUtc(xeroRow.updated_at),
        source:     'xero',
        market:     null,
        action:     'token-refresh',
        status:     'ok',
        summary:    `tokens stored for ${xeroRow.tenant_name || 'tenant'}`,
        durationMs: null,
        scope:      'snapshot',
      });
    }
  } catch { /* xero_tokens table may not exist on a fresh env — skip silently. */ }

  // Sort by timestamp desc, cap to limit. lexicographic sort works because
  // every `when` field has been normalised to ISO-Z by toIsoUtc above.
  rows.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  const trimmed = rows.slice(0, limit);

  return c.json({
    generatedAt: new Date().toISOString(),
    hours,
    limit,
    sinceIso,
    rowCount:    trimmed.length,
    rows:        trimmed,
  });
});
