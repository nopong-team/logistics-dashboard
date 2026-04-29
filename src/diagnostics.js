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
 *
 * Both endpoints are public-within-Access (no ADMIN_KEY) — same posture as
 * the legacy Express routes, since they expose nothing the dashboard SPA
 * doesn't already consume.
 *
 * Per-source schema means the legacy "CA vs US byte-identical" check can never
 * fire structurally (separate amazon_orders + amazon_items tables), so we
 * report `caUsIdentical: false` and lean on filter_signal / wrong_market_count
 * from report_jobs to surface real divergence.
 */

import { Hono } from 'hono';
import { buildMonthWindow, getWeekKey } from './timezone.js';

export const diagnosticsRoutes = new Hono();

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

  // Order counts in parallel for both sources × both markets.
  const [wooCa, wooUs, amzCa, amzUs] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders        WHERE market = 'CA'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM orders        WHERE market = 'US'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM amazon_orders WHERE market = 'CA'`).first(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM amazon_orders WHERE market = 'US'`).first(),
  ]);

  // FBA inventory cached snapshots — best-effort, KV may not have anything yet.
  let amzInvCa = null, amzInvUs = null;
  if (cache) {
    [amzInvCa, amzInvUs] = await Promise.all([
      cache.get(FBA_INVENTORY_KV_KEY('CA'), 'json'),
      cache.get(FBA_INVENTORY_KV_KEY('US'), 'json'),
    ]);
  }

  return c.json({
    wooCA: {
      lastSync:   stateBy['woo:CA']?.last_synced_at || null,
      orderCount: wooCa?.n || 0,
      syncing:    false,
    },
    wooUS: {
      lastSync:   stateBy['woo:US']?.last_synced_at || null,
      orderCount: wooUs?.n || 0,
      syncing:    false,
    },
    amzCA: {
      lastSync:     stateBy['amazon:CA']?.last_synced_at || null,
      orderCount:   amzCa?.n || 0,
      syncComplete: true,
      syncing:      false,
    },
    amzUS: {
      lastSync:     stateBy['amazon:US']?.last_synced_at || null,
      orderCount:   amzUs?.n || 0,
      syncComplete: true,
      syncing:      false,
    },
    amzInvCA: {
      lastSync: amzInvCa?.lastSync || null,
      count:    amzInvCa?.count || 0,
      syncing:  false,
    },
    amzInvUS: {
      lastSync: amzInvUs?.lastSync || null,
      count:    amzInvUs?.count || 0,
      syncing:  false,
    },
    xero: { connected: false },
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
    lastSync:         stateRes?.last_synced_at || null,
    monthWindowStart: startDate,
  };
}

async function buildAmazonAudit(env) {
  const { startDate } = buildMonthWindow();
  const [caSku, usSku, caState, usState, caJobs, usJobs] = await Promise.all([
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
  ]);

  const splitSignals = (s) => (s ? String(s).split(',').filter(Boolean) : []);

  return {
    // Per-source schema makes byte-identical caches structurally impossible —
    // CA and US live in physically separate rows. Hard-false so the frontend's
    // health check renders the "separated via X / Y" pass label.
    caUsIdentical:      false,
    caSkuCount:         caSku?.n || 0,
    usSkuCount:         usSku?.n || 0,
    caLastSync:         caState?.last_synced_at || null,
    usLastSync:         usState?.last_synced_at || null,
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
    lastSync: {
      wooCA: wooCA.lastSync,
      wooUS: wooUS.lastSync,
      amzCA: amazon.caLastSync,
      amzUS: amazon.usLastSync,
    },
  });
});
