/**
 * Amazon SP-API integration for the Logistics Dashboard.
 *
 * Two ingestion flows + one read endpoint:
 *
 *   • Orders flow (synchronous, watermark-based) — drives monthly revenue.
 *     Mirrors the Woo runBackfillChunk pattern. Cron pulls one chunk per tick
 *     per market via runAmazonOrdersChunk; manual catch-up via
 *     /api/admin/backfill?source=amazon&market=CA. INSERT OR REPLACE on
 *     amazon_orders means re-runs are idempotent.
 *
 *   • Reports flow (async, range-scheduled) — drives per-SKU breakdown.
 *     SP-API returns reports asynchronously: POST /reports queues a job,
 *     poll until DONE, download a presigned URL, parse TSV. Each phase is
 *     CPU-cheap individually but together blow the Workers Free 50ms budget.
 *     report_jobs tracks jobs through pending → ready → ingested | failed,
 *     and runAmazonReportsTick advances up to N=3 jobs per phase per cron
 *     tick with a hard 25s wall-clock guard.
 *
 *   • /api/amazon/sales reads from D1 (amazon_orders + amazon_items), same
 *     payload shape as /api/woo/sales, KV-cached for 15 min.
 *
 * Token caching: Workers are stateless across invocations, so the legacy
 * in-memory token cache (server.js:1060) becomes a KV entry under
 * 'amazon:lwa-token' with TTL = expires_in - 60. Each invocation reads from
 * KV first, exchanges the refresh token only on miss.
 *
 * Secrets (Wrangler secrets — names match legacy backend/.env):
 *   AMAZON_REFRESH_TOKEN     — LWA refresh token (Atzr|...)
 *   AMAZON_LWA_CLIENT_ID     — LWA OAuth client id
 *   AMAZON_LWA_CLIENT_SECRET — LWA OAuth client secret
 *
 * Marketplace IDs are public constants, hardcoded below.
 */

import { Hono } from 'hono';
import {
  buildMonthWindow, getWeekKey, toBusinessLocalDate, easternIsoMidnight, getBusinessToday,
} from './timezone.js';
import { redactSecrets } from './redact.js';
import { toIsoUtc } from './diagnostics.js';

export const amazonRoutes = new Hono();

// ─── Public constants ──────────────────────────────────────────────────────

// Both CA and US marketplaces live behind the same SP-API regional endpoint.
const SP_API_HOST = 'sellingpartnerapi-na.amazon.com';

// Marketplace IDs are public, immutable, and don't belong in the secret store.
const AMAZON_MARKETPLACES = {
  CA: { id: 'A2EUQ1WTGCTBG2', currency: 'CAD', label: 'Canada' },
  US: { id: 'ATVPDKIKX0DER', currency: 'USD', label: 'United States' },
};

// LWA token cache key + safety buffer (refresh slightly before actual expiry).
const LWA_KV_KEY      = 'amazon:lwa-token';
const LWA_TTL_BUFFER  = 60; // seconds

// Reports API constants.
const REPORT_TYPE_PRIMARY  = 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL';
const REPORT_TYPE_FALLBACK = 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_SALES_DATA';
const REPORT_TYPES = [REPORT_TYPE_PRIMARY, REPORT_TYPE_FALLBACK];

// Cron tick wall-clock guard (ms). Stop spawning new work past this elapsed
// time so a slow tick doesn't blow Workers Free CPU budget on a fat report.
const CRON_TICK_BUDGET_MS = 25_000;

// Max attempts before marking a pending job 'failed'. Each attempt is a real
// poll of /reports/{id} — bumped to 30 with the per-job MIN_POLL_INTERVAL_S
// guard below so a job that takes the full Amazon processing window
// (typically 5–15 min, sometimes longer for big ranges) doesn't get
// prematurely marked failed.
const REPORT_POLL_MAX_ATTEMPTS = 30;

// Minimum seconds between polls of the same job. Without this guard, a
// caller (cron + manual admin loop racing each other) can poll one job many
// times in seconds and burn through MAX_ATTEMPTS before Amazon has even had
// a chance to generate the report.
const MIN_POLL_INTERVAL_S = 90;

// /api/amazon/sales KV cache TTL (seconds).
const SALES_TTL_SECONDS = 15 * 60;
const SALES_KV_KEY = (market) => `amazon-sales-${market.toLowerCase()}`;

// /api/amazon/inventory cache windows. We use a "stale-while-revalidate" pattern:
// the KV entry lives for 24h (so a stale snapshot is always there to serve while
// a refresh runs in the background), but we treat it as FRESH only for the first
// hour. Past that, we serve the stale snapshot immediately and spawn a background
// refresh via ctx.waitUntil so the next page load picks up new data without the
// caller ever waiting for a cold paginated fetch (~10–15s end-to-end).
const FBA_INVENTORY_FRESH_S   = 60 * 60;        // 1h "fresh" — serve as-is
const FBA_INVENTORY_KV_TTL_S  = 24 * 60 * 60;   // 24h KV retention for stale-while-revalidate
const FBA_INVENTORY_KV_KEY    = (market) => `amazon:inventory:${market.toUpperCase()}`;
// Polite pacing between paginated /fba/inventory/v1/summaries calls. Matches
// legacy backend/server.js. SP-API has fairly tight rate limits on this endpoint
// (typical 2 req/sec, 2 burst).
const FBA_INVENTORY_PAGE_SLEEP_MS = 3000;
// Hard cap on pages — defensive. No Pong's catalog is small (~12 SKUs/market)
// so this should never fire, but a misbehaving SP-API loop won't pin a Worker.
const FBA_INVENTORY_MAX_PAGES = 10;

// Active vs frozen ranges for the Reports state machine. "Active" ranges
// (this+last month × 2 halves) get refreshed every 24h; "frozen" historical
// ranges are seeded once and never re-run.
const ACTIVE_RANGE_STALE_HOURS = 24;

// ─── SKU map (lifted verbatim from legacy backend/server.js) ───────────────
//
// Maps Amazon seller SKUs (canonical CA-/US- codes AND FNSKU-style aliases)
// to the canonical dashboard SKU. US-only SKUs intentionally map to the
// CA- dashboard code so combined reporting rolls up cleanly. Source: No Pong
// Product SKU Registry (Apr 2026).
const AMZ_SKU_MAP = {
  // CA SKUs — canonical names (self-map)
  'CA-OG-NPO-85':     'CA-OG-NPO-85',   // Original 85g
  'CA-CL-VLB-85':     'CA-CL-VLB-85',   // Cool Lavender 85g
  'CA-CL-VLB-35':     'CA-CL-VLB-35',   // Cool Lavender 35g
  'CA-FF-VLB-35':     'CA-FF-VLB-35',   // Fragrance Free 35g
  'CA-FP-VLB-35':     'CA-FP-VLB-35',   // Flower Power 35g
  'CA-OG-NPO-35':     'CA-OG-NPO-35',   // Original 35g
  'CA-OG-BCF-35':     'CA-OG-BCF-35',   // Original Bicarb-Free 35g
  'CA-SC-BCF-35':     'CA-SC-BCF-35',   // Spicy Chai BCF 35g
  'CA-SC-NPO-35':     'CA-SC-NPO-35',   // Spicy Chai Original 35g
  // CA SKUs — Amazon FNSKU-style aliases (normalised to canonical CA- code)
  'V9-2U5C-RGSU':     'CA-CL-VLB-35',   // Cool Lavender 35g alias
  'HP-G88K-NR69':     'CA-FF-VLB-35',   // Fragrance Free 35g alias
  '0T-GA0Y-L3HG':     'CA-OG-NPO-35',   // Original 35g alias
  'IC-OLUM-TQLF':     'CA-SC-NPO-35',   // Spicy Chai Original 35g alias
  'EX-DHDC-UJK7':     'CA-FP-VLB-35',   // Flower Power 35g alias (added v2.22, FBA gap)
  'SC-NPO-35-GS1':    'CA-SC-NPO-35',   // Spicy Chai Original 35g GS1-barcode variant
  // US-only SKUs (normalised to CA- dashboard SKU for combined reporting)
  'US-FP-VLB-35':     'CA-FP-VLB-35',   // Flower Power 35g (US)
  'US-SC-BCF-35':     'CA-SC-BCF-35',   // Spicy Chai BCF 35g (US)
  'US-FF-VLB-35':     'CA-FF-VLB-35',   // Fragrance Free 35g (US)
  'US-OG-NPO-35':     'CA-OG-NPO-35',   // Original 35g (US)
  'US-OG-NPO-35-AM':  'CA-OG-NPO-35',   // Original 35g Amazon-specific variant (US)
  'US-OG-BCF-35':     'CA-OG-BCF-35',   // Original Bicarb-Free 35g (US)
  'US-SC-NPO-35':     'CA-SC-NPO-35',   // Spicy Chai Original 35g (US)
};

export function matchAmzItemToSku(_itemName, sellerSku) {
  if (!sellerSku) return null;
  const trimmed = String(sellerSku).trim();
  return AMZ_SKU_MAP[trimmed] || null;
}

// ─── LWA token management (KV-cached) ──────────────────────────────────────
//
// Exchanges the long-lived refresh token for a short-lived access token at
// api.amazon.com/auth/o2/token. Token shape `Atzr|...` (refresh) or
// `Atza|...` (access). Cached in KV under 'amazon:lwa-token' with the
// access token + an expiresAt unix-seconds timestamp; we refresh the moment
// expiresAt - now is within LWA_TTL_BUFFER.

async function fetchFreshLwaToken(env) {
  if (!env.AMAZON_REFRESH_TOKEN || !env.AMAZON_LWA_CLIENT_ID || !env.AMAZON_LWA_CLIENT_SECRET) {
    throw new Error(
      'Amazon not configured. Set AMAZON_REFRESH_TOKEN, AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET ' +
      'with `npx wrangler secret put` (or via scripts/load-secrets.sh from a local .env).',
    );
  }
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: env.AMAZON_REFRESH_TOKEN,
    client_id:     env.AMAZON_LWA_CLIENT_ID,
    client_secret: env.AMAZON_LWA_CLIENT_SECRET,
  });

  let resp;
  try {
    resp = await fetch('https://api.amazon.com/auth/o2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
  } catch (e) {
    // Native fetch errors can carry the request body in the message — which
    // includes refresh_token / client_secret. Sanitize before propagating.
    throw new Error('Amazon LWA fetch failed: ' + redactSecrets(e?.message || e));
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Amazon LWA ${resp.status}: ${redactSecrets(text).substring(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Amazon LWA parse error: ' + redactSecrets(text).substring(0, 200));
  }
  if (!data.access_token) {
    throw new Error('Amazon LWA missing access_token: ' + redactSecrets(text).substring(0, 200));
  }
  return {
    access_token: data.access_token,
    expires_in:   parseInt(data.expires_in || 3600, 10),
  };
}

export async function getAmazonAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (env.CACHE) {
    const cached = await env.CACHE.get(LWA_KV_KEY, 'json');
    if (cached?.access_token && cached.expiresAt && cached.expiresAt - now > LWA_TTL_BUFFER) {
      return cached.access_token;
    }
  }
  const fresh = await fetchFreshLwaToken(env);
  if (env.CACHE) {
    const expiresAt = now + fresh.expires_in;
    await env.CACHE.put(
      LWA_KV_KEY,
      JSON.stringify({ access_token: fresh.access_token, expiresAt }),
      { expirationTtl: Math.max(60, fresh.expires_in - LWA_TTL_BUFFER) },
    );
  }
  return fresh.access_token;
}

// ─── SP-API request helpers ────────────────────────────────────────────────
//
// Both helpers carry token + redaction discipline. On 429, surface a typed
// error so callers (especially the Reports state machine) can decide whether
// to retry now or back off — we don't sleep inside the helper because that
// burns Workers Free CPU credit.

class RateLimitedError extends Error {
  constructor(retryAfterSeconds) {
    super('Amazon rate limited');
    this.rateLimited = true;
    this.retryAfter  = retryAfterSeconds;
  }
}

function spApiUrl(path, queryParams) {
  const url = new URL(path, `https://${SP_API_HOST}`);
  for (const [k, v] of Object.entries(queryParams || {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Single in-handler retry on 429. Amazon's SP-API rate limit recovery is
// usually 5–15s. Cap the wait so one stuck request doesn't blow the
// scheduled-handler 30s wall-clock budget; if the second attempt also 429s,
// throw RateLimitedError and let the caller decide (Orders chunk converts to
// a graceful "rate_limited" response; Reports tick treats as "stop this
// phase, retry next tick").
const RATE_LIMIT_RETRY_CAP_S = 10;

async function spApiFetchOnce(env, path, init) {
  const token = await getAmazonAccessToken(env);
  const headers = {
    'x-amz-access-token': token,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  try {
    return await fetch(init.url, { ...init, headers });
  } catch (e) {
    throw new Error('SP-API fetch failed: ' + redactSecrets(e?.message || e));
  }
}

async function spApiHandleResponse(resp, path, mode) {
  if (resp.status === 429) {
    throw new RateLimitedError(parseInt(resp.headers.get('retry-after') || '5', 10));
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`SP-API ${mode} ${resp.status} on ${path}: ${redactSecrets(text).substring(0, 400)}`);
  }
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`SP-API ${mode} parse error (${resp.status}) on ${path}: ${redactSecrets(text).substring(0, 200)}`);
  }
}

export async function spApiRequest(env, _market, path, queryParams = {}) {
  const url = spApiUrl(path, queryParams);
  let resp = await spApiFetchOnce(env, path, { url, method: 'GET' });
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
    const waitMs = Math.min(retryAfter, RATE_LIMIT_RETRY_CAP_S) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    resp = await spApiFetchOnce(env, path, { url, method: 'GET' });
  }
  return spApiHandleResponse(resp, path, 'GET');
}

export async function spApiPost(env, _market, path, body = {}) {
  const url     = `https://${SP_API_HOST}${path}`;
  const payload = JSON.stringify(body);
  let resp = await spApiFetchOnce(env, path, { url, method: 'POST', body: payload });
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '5', 10);
    const waitMs = Math.min(retryAfter, RATE_LIMIT_RETRY_CAP_S) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    resp = await spApiFetchOnce(env, path, { url, method: 'POST', body: payload });
  }
  return spApiHandleResponse(resp, path, 'POST');
}

// ─── Orders flow ───────────────────────────────────────────────────────────
//
// Mirrors the Woo runBackfillChunk shape: fetch a watermark, pull one chunk
// of orders, INSERT OR REPLACE into amazon_orders, advance the watermark,
// log to sync_logs. NextToken pagination drives subsequent chunks (one per
// call). Status filter:
//   - incremental: 'Unshipped,Shipped' (faster, current orders only)
//   - backfill:    no status filter (per legacy: "old delivered orders no
//                  longer show as Shipped" so a status filter loses history)
//
// The defensive marketplace post-filter (`order.MarketplaceId === mp.id`)
// catches the rare cross-market row Amazon can return; legacy server.js
// hit this once and the comment is preserved there.

const AMAZON_PAGE_SIZE = 100; // SP-API /orders/v0/orders default

export async function runAmazonOrdersChunk(env, market, options = {}) {
  const startMs = Date.now();
  const mp = AMAZON_MARKETPLACES[market];
  if (!mp) throw new Error(`Unknown Amazon market: ${market}`);

  const action       = options.action || 'amazon-incremental';
  const isBackfill   = action === 'amazon-backfill';
  const statusFilter = isBackfill ? null : 'Unshipped,Shipped';

  // Get watermark.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_state (source, market) VALUES ('amazon', ?)`,
  ).bind(market).run();
  const stateRow = await env.DB.prepare(
    `SELECT watermark FROM sync_state WHERE source = 'amazon' AND market = ?`,
  ).bind(market).first();
  const watermarkBefore = stateRow?.watermark || '1970-01-01T00:00:00';

  // Build request params.
  const nextToken = options.nextToken || null;
  let params;
  if (nextToken) {
    params = { NextToken: nextToken, MarketplaceIds: mp.id };
  } else {
    params = {
      MarketplaceIds: mp.id,
      CreatedAfter:   watermarkBefore,
    };
    if (statusFilter) params.OrderStatuses = statusFilter;
  }

  let data;
  try {
    data = await spApiRequest(env, market, '/orders/v0/orders', params);
  } catch (e) {
    if (e?.rateLimited) {
      // Graceful rate-limited response — caller should back off and retry,
      // not abort the loop. more=true tells the curl loop to keep going
      // (after sleeping). watermark unchanged. Logged for audit.
      const retryAfter = e.retryAfter || 30;
      await env.DB.prepare(
        `INSERT INTO sync_logs
           (run_at, source, market, action, pages_fetched, orders_added, items_added,
            watermark_before, watermark_after, status, error, duration_ms)
         VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'amazon', ?, ?, 0, 0, 0, ?, ?, 'rate_limited', ?, ?)`,
      ).bind(
        market, action, watermarkBefore, watermarkBefore,
        `Amazon rate limited; retry after ${retryAfter}s`, Date.now() - startMs,
      ).run();
      return {
        ok:              false,
        source:          'amazon',
        market,
        action,
        error:           'rate_limited',
        retryAfter,
        pagesFetched:    0,
        rowsFetched:     0,
        ordersAdded:     0,
        watermarkBefore,
        watermarkAfter:  watermarkBefore,
        nextToken:       nextToken || null,  // preserve incoming token so caller can resume
        more:            true,
        durationMs:      Date.now() - startMs,
      };
    }
    throw e;
  }
  const orders  = data?.payload?.Orders || [];
  const newNext = data?.payload?.NextToken || null;

  // Filter: defensive marketplace check + skip canceled/pending.
  const usable = orders.filter((o) => {
    if (o.MarketplaceId && o.MarketplaceId !== mp.id) return false;
    const st = o.OrderStatus || '';
    if (st === 'Canceled' || st === 'Pending' || st === 'PendingAvailability') return false;
    return !!o.AmazonOrderId;
  });

  let watermarkAfter = watermarkBefore;
  let ordersAdded   = 0;

  if (usable.length > 0) {
    const stmts = [];
    for (const o of usable) {
      const purchase   = o.PurchaseDate || o.LastUpdateDate || '';
      const localDate  = toBusinessLocalDate(purchase);
      const total      = parseFloat(o.OrderTotal?.Amount || 0);
      const currency   = o.OrderTotal?.CurrencyCode || mp.currency;
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO amazon_orders
             (id, market, status, purchase_date, local_date, total, currency, marketplace_id, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        ).bind(
          o.AmazonOrderId,
          market,
          o.OrderStatus || 'unknown',
          purchase,
          localDate,
          total,
          currency,
          mp.id,
        ),
      );
      if (purchase > watermarkAfter) watermarkAfter = purchase;
      ordersAdded++;
    }
    // Chunk D1 batches at 500 statements (same convention as Woo).
    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }
  }

  // Heartbeat: always update last_synced_at on a successful run, even if no
  // new orders came back. Same rationale as runBackfillChunk in src/admin.js
  // — the chip on the dashboard reads this field to answer "when did we
  // last hear from this source", which is a different question from "when
  // did we last persist a NEW order" (the watermark column answers that).
  // Previously this UPDATE was gated on usable.length>0 AND watermarkAfter>
  // watermarkBefore, so a tick with zero new orders left the timestamp stale
  // and the chip showed e.g. "9h ago" while the cron was actually firing
  // every 15 min. ISO-8601 with explicit Z so JS new Date() parses as UTC,
  // not as local time on the viewer's machine.
  await env.DB.prepare(
    `UPDATE sync_state
     SET watermark = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE source = 'amazon' AND market = ?`,
  ).bind(watermarkAfter, market).run();

  await env.DB.prepare(
    `INSERT INTO sync_logs
       (run_at, source, market, action, pages_fetched, orders_added, items_added,
        watermark_before, watermark_after, status, duration_ms)
     VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'amazon', ?, ?, 1, ?, 0, ?, ?, 'ok', ?)`,
  ).bind(
    market, action, ordersAdded, watermarkBefore, watermarkAfter, Date.now() - startMs,
  ).run();

  return {
    ok:               true,
    source:           'amazon',
    market,
    action,
    pagesFetched:     1,
    rowsFetched:      orders.length,
    ordersAdded,
    watermarkBefore,
    watermarkAfter,
    nextToken:        newNext,
    more:             !!newNext,
    durationMs:       Date.now() - startMs,
  };
}

// ─── Reports state machine ─────────────────────────────────────────────────
//
// Each tick: Phase A (seed if needed) → Phase B (poll up to N pending) →
// Phase C (ingest up to N ready). All three phases share the same wall-clock
// budget (CRON_TICK_BUDGET_MS) — once we cross it, we return early.

// Build the desired set of date ranges for SKU reports. 6-month rolling
// window in Eastern, two halves per month. Active ranges (this + last month)
// are eligible for daily refresh; frozen ranges are seeded once.
function buildReportRanges() {
  const today = getBusinessToday(); // YYYY-MM-DD Eastern
  const [yStr, mStr] = today.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const ranges = [];
  for (let i = 5; i >= 0; i--) {
    let mm = m - i;
    let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    const ym = `${yy}-${String(mm).padStart(2, '0')}`;
    const isActive = i <= 1; // this month (i=0) or last month (i=1)
    let nextY = yy, nextM = mm + 1;
    if (nextM > 12) { nextM = 1; nextY += 1; }
    ranges.push({
      range_label:     `${ym}-1h`,
      data_start_time: easternIsoMidnight(yy, mm, 1),
      data_end_time:   easternIsoMidnight(yy, mm, 16),
      isActive,
    });
    ranges.push({
      range_label:     `${ym}-2h`,
      data_start_time: easternIsoMidnight(yy, mm, 16),
      data_end_time:   easternIsoMidnight(nextY, nextM, 1),
      isActive,
    });
  }
  return ranges;
}

// Seed report_jobs rows for any range that doesn't have a current in-flight
// or fresh-ingested job. Returns the number of jobs seeded.
async function seedReportJobsIfNeeded(env, market) {
  const ranges = buildReportRanges();
  let seeded = 0;
  for (const r of ranges) {
    // Most recent job for this (market, range_label). Age computed in SQL —
    // SQLite's strftime('%Y-%m-%dT%H:%M:%SZ','now') format ('YYYY-MM-DD HH:MM:SS' UTC) doesn't
    // round-trip cleanly through JS Date, but julianday() handles it natively.
    const last = await env.DB.prepare(
      `SELECT status, (julianday('now') - julianday(updated_at)) * 24.0 AS age_hours
       FROM report_jobs
       WHERE source = 'amazon' AND market = ? AND range_label = ?
       ORDER BY id DESC LIMIT 1`,
    ).bind(market, r.range_label).first();
    if (last) {
      if (last.status === 'pending' || last.status === 'ready') continue; // in-flight
      if (last.status === 'failed') continue; // manual intervention required
      if (last.status === 'ingested') {
        if (!r.isActive) continue; // frozen — historical, never re-seed
        if ((last.age_hours ?? 0) < ACTIVE_RANGE_STALE_HOURS) continue; // fresh enough
      }
    }
    await env.DB.prepare(
      `INSERT INTO report_jobs
         (source, market, report_type, range_label, data_start_time, data_end_time, status, attempts)
       VALUES ('amazon', ?, ?, ?, ?, ?, 'pending', 0)`,
    ).bind(market, REPORT_TYPE_PRIMARY, r.range_label, r.data_start_time, r.data_end_time).run();
    seeded++;
  }
  return seeded;
}

// Phase B0 — POST every un-POSTed pending job to Amazon (no LIMIT, only the
// wall-clock deadline). Cheap (~500ms per request). Lets all 12 ranges per
// market enter Amazon's processing queue in parallel rather than serially in
// batches of 3-per-tick, which previously meant higher-id jobs starved
// behind lower-id ones still in IN_PROGRESS.
async function postNewReportJobs(env, market, deadlineMs) {
  const jobs = await env.DB.prepare(
    `SELECT id, report_type, data_start_time, data_end_time
     FROM report_jobs
     WHERE source = 'amazon' AND market = ? AND status = 'pending' AND amazon_report_id IS NULL
     ORDER BY id ASC`,
  ).bind(market).all();
  let posted = 0;
  let lastError = null;
  for (const job of (jobs.results || [])) {
    if (Date.now() > deadlineMs) break;
    try {
      const create = await spApiPost(env, market, '/reports/2021-06-30/reports', {
        reportType:     job.report_type,
        dataStartTime:  job.data_start_time,
        dataEndTime:    job.data_end_time,
        marketplaceIds: [AMAZON_MARKETPLACES[market].id],
      });
      await env.DB.prepare(
        `UPDATE report_jobs
           SET amazon_report_id = ?, attempts = 1,
               last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`,
      ).bind(create.reportId || null, job.id).run();
      posted++;
    } catch (e) {
      // ALWAYS log the error to the DB before deciding whether to break, so
      // diagnostics can see what Amazon actually returned (was previously
      // invisible: rate-limited break exited without recording the message).
      const msg = e?.rateLimited
        ? `RATE_LIMITED retryAfter=${e.retryAfter || '?'}`
        : redactSecrets(e?.message || String(e)).substring(0, 500);
      lastError = msg;
      await env.DB.prepare(
        `UPDATE report_jobs
           SET error = ?, attempts = attempts + 1,
               last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`,
      ).bind(msg, job.id).run();
      if (e?.rateLimited) break; // bail this phase, retry next tick
    }
  }
  return { posted, lastError };
}

// Phase B1 — poll up to maxJobs already-POSTed pending jobs for status.
// Transitions:
//   - DONE              → ready (capture document_id)
//   - CANCELLED|FATAL   → try fallback report type (re-POST) OR mark failed
//   - IN_PROGRESS|other → leave pending, attempts++ (capped at MAX_ATTEMPTS)
async function pollExistingReportJobs(env, market, maxJobs, deadlineMs) {
  // Filter out jobs polled in the last MIN_POLL_INTERVAL_S seconds — Amazon
  // takes 5–15 min to generate a report, so polling every cron tick (15 min)
  // is plenty. Without this guard, manual admin loops + cron racing each
  // other can eat through MAX_ATTEMPTS in a few minutes and prematurely mark
  // a still-processing report as failed.
  const jobs = await env.DB.prepare(
    `SELECT * FROM report_jobs
     WHERE source = 'amazon' AND market = ? AND status = 'pending'
       AND amazon_report_id IS NOT NULL
       AND (last_polled_at IS NULL
            OR (julianday('now') - julianday(last_polled_at)) * 86400.0 > ?)
     ORDER BY id ASC LIMIT ?`,
  ).bind(market, MIN_POLL_INTERVAL_S, maxJobs).all();
  let advanced = 0;
  for (const job of (jobs.results || [])) {
    if (Date.now() > deadlineMs) break;
    try {
      const status = await spApiRequest(env, market, `/reports/2021-06-30/reports/${job.amazon_report_id}`);
      const ps = status.processingStatus || '';
      if (ps === 'DONE') {
        await env.DB.prepare(
          `UPDATE report_jobs
             SET status = 'ready', document_id = ?, attempts = attempts + 1,
                 last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE id = ?`,
        ).bind(status.reportDocumentId || null, job.id).run();
        advanced++;
      } else if (ps === 'CANCELLED' || ps === 'FATAL') {
        // Try fallback report type if we haven't already.
        if (job.report_type === REPORT_TYPE_PRIMARY) {
          await env.DB.prepare(
            `UPDATE report_jobs
               SET report_type = ?, amazon_report_id = NULL, attempts = 0,
                   last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
             WHERE id = ?`,
          ).bind(REPORT_TYPE_FALLBACK, job.id).run();
        } else {
          await env.DB.prepare(
            `UPDATE report_jobs
               SET status = 'failed', error = ?, attempts = attempts + 1,
                   last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
             WHERE id = ?`,
          ).bind(`Amazon returned ${ps} on both report types`, job.id).run();
        }
        advanced++;
      } else {
        // IN_QUEUE / IN_PROGRESS — leave pending, increment attempts.
        const newAttempts = (job.attempts || 0) + 1;
        if (newAttempts >= REPORT_POLL_MAX_ATTEMPTS) {
          await env.DB.prepare(
            `UPDATE report_jobs
               SET status = 'failed', error = ?, attempts = ?,
                   last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
             WHERE id = ?`,
          ).bind(`Stuck in ${ps} after ${newAttempts} polls`, newAttempts, job.id).run();
        } else {
          await env.DB.prepare(
            `UPDATE report_jobs
               SET attempts = ?, last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
             WHERE id = ?`,
          ).bind(newAttempts, job.id).run();
        }
      }
    } catch (e) {
      if (e?.rateLimited) break; // bail this phase, try next tick
      // Record the error on the job but leave pending so the next tick retries.
      await env.DB.prepare(
        `UPDATE report_jobs
           SET error = ?, attempts = attempts + 1, last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`,
      ).bind(redactSecrets(e?.message || String(e)).substring(0, 500), job.id).run();
    }
  }
  return advanced;
}

// Phase C: take up to maxJobs ready jobs, download the document, gunzip if
// needed, parse TSV, INSERT amazon_items rows, mark job ingested.
async function ingestReadyJobs(env, market, maxJobs, deadlineMs) {
  const jobs = await env.DB.prepare(
    `SELECT * FROM report_jobs
     WHERE source = 'amazon' AND market = ? AND status = 'ready'
     ORDER BY id ASC LIMIT ?`,
  ).bind(market, maxJobs).all();
  let ingested = 0;
  for (const job of (jobs.results || [])) {
    if (Date.now() > deadlineMs) break;
    try {
      const doc = await spApiRequest(env, market, `/reports/2021-06-30/documents/${job.document_id}`);
      const text = await downloadReportDocument(doc);
      const parsed = parseAmazonReportTsv(text, market);
      if (parsed.identityMissing > 0) {
        // The report should always carry shipment-item-id (see migration 0008).
        // If it ever doesn't, those rows fall back to range-supersede-only dedup
        // and the Data Health "Amazon rows missing line id" check goes non-zero.
        console.warn(`Amazon ${market} ${job.range_label}: ${parsed.identityMissing} matched rows missing shipment_item_id`);
      }
      // Re-ingestion dedup — two complementary layers, replacing the v2.29
      // date-window DELETE (which keyed on purchase_date while the report window
      // filters on last-updated date, so it could never fully clear a range):
      //
      //  (1) Supersede the whole range: a re-fetch fully re-downloads its
      //      range_label, so the new job is authoritative — delete every row
      //      from PRIOR ingested jobs of the same (market, range_label). This
      //      also clears legacy pre-0008 rows (NULL shipment_item_id).
      //  (2) Upsert on the stable line identity: if the same order line ever
      //      migrates to a DIFFERENT range_label (e.g. re-shipped/refunded
      //      across a half-month boundary), ON CONFLICT replaces the prior copy
      //      instead of duplicating it across ranges — the case (1) alone can't
      //      catch. Verified against SQLite's partial-index upsert semantics.
      await env.DB.prepare(
        `DELETE FROM amazon_items
           WHERE market = ?
             AND report_job_id IN (
               SELECT id FROM report_jobs
               WHERE source = 'amazon' AND market = ? AND range_label = ? AND id <> ?
             )`,
      ).bind(market, market, job.range_label, job.id).run();
      if (parsed.rows.length > 0) {
        const stmts = [];
        for (const r of parsed.rows) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO amazon_items
                 (market, seller_sku, dashboard_sku, name, quantity, total, date_created, local_date, report_job_id, shipment_item_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(market, shipment_item_id) WHERE shipment_item_id IS NOT NULL
               DO UPDATE SET
                 seller_sku    = excluded.seller_sku,
                 dashboard_sku = excluded.dashboard_sku,
                 name          = excluded.name,
                 quantity      = excluded.quantity,
                 total         = excluded.total,
                 date_created  = excluded.date_created,
                 local_date    = excluded.local_date,
                 report_job_id = excluded.report_job_id`,
            ).bind(
              market, r.sellerSku, r.dashboardSku, r.name, r.quantity, r.total, r.dateCreated, r.localDate, job.id, r.shipmentItemId,
            ),
          );
        }
        const CHUNK = 500;
        for (let i = 0; i < stmts.length; i += CHUNK) {
          await env.DB.batch(stmts.slice(i, i + CHUNK));
        }
      }
      await env.DB.prepare(
        `UPDATE report_jobs
           SET status = 'ingested', rows_total = ?, rows_matched = ?, rows_unmatched = ?,
               rows_wrong_market = ?, filter_signal = ?, error = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`,
      ).bind(
        parsed.totalRows, parsed.matchedCount, parsed.unmatchedCount,
        parsed.wrongMarketCount, parsed.filterSignal, job.id,
      ).run();
      // Invalidate the sales cache so the dashboard picks up the new rows.
      await invalidateAmazonSalesCache(env, market);
      ingested++;
    } catch (e) {
      if (e?.rateLimited) break;
      await env.DB.prepare(
        `UPDATE report_jobs
           SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`,
      ).bind(redactSecrets(e?.message || String(e)).substring(0, 500), job.id).run();
    }
  }
  return ingested;
}

// Download a presigned report document URL. Workers' fetch() automatically
// decompresses content-encoding: gzip, but Amazon Reports docs come down with
// no content-encoding header even when the body is gzipped (signalled by
// `compressionAlgorithm: 'GZIP'` in the document descriptor instead). Use
// DecompressionStream for that case.
async function downloadReportDocument(doc) {
  const r = await fetch(doc.url);
  if (!r.ok) throw new Error(`Document download ${r.status}`);
  let stream = r.body;
  if (doc.compressionAlgorithm === 'GZIP') {
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  return await new Response(stream).text();
}

// Parse a tab-separated Amazon report into normalized item rows. Mirrors
// legacy server.js fetchAmzSkuItems parsing logic — column probing, three
// marketplace filter signals (sales_channel / currency / ship_country) in
// priority order, matchAmzItemToSku for canonical SKU mapping.
function parseAmazonReportTsv(text, market) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) {
    return { rows: [], totalRows: 0, matchedCount: 0, unmatchedCount: 0, wrongMarketCount: 0, filterSignal: 'NONE' };
  }
  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase().replace(/[- ]/g, '_'));
  const skuCol         = headers.findIndex((h) => h === 'sku' || h === 'seller_sku');
  const nameCol        = headers.findIndex((h) => h === 'product_name' || h === 'product_title' || h === 'item_name');
  const qtyCol         = headers.findIndex((h) => h === 'quantity' || h === 'quantity_ordered' || h === 'quantity_shipped');
  // GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL uses 'item-price'.
  // GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_SALES_DATA (fallback) uses 'item-price-per-unit'.
  const priceCol       = headers.findIndex((h) => h === 'item_price' || h === 'item_price_per_unit' || h === 'price' || h === 'item_total');
  const dateCol        = headers.findIndex((h) => h === 'purchase_date' || h === 'last_updated_date' || h === 'shipment_date' || h === 'payments_date');
  // Stable per-line identity for dedup. 'shipment-item-id' / "Shipment Item ID"
  // both normalise to 'shipment_item_id'. Fall back to 'amazon_order_item_id' if
  // a report variant omits the shipment id. This is the key the UNIQUE index +
  // upsert rely on (migration 0008) — the same column the AU importer dedups on.
  const lineIdCol      = headers.findIndex((h) => h === 'shipment_item_id' || h === 'amazon_order_item_id' || h === 'order_item_id');
  const channelCol     = headers.findIndex((h) => h === 'sales_channel');
  const currencyCol    = headers.findIndex((h) => h === 'currency');
  const shipCountryCol = headers.findIndex((h) => h === 'ship_country' || h === 'ship_to_country' || h === 'ship_country_code');
  const filterSignal =
    channelCol     >= 0 ? 'sales_channel'
    : currencyCol  >= 0 ? 'currency'
    : shipCountryCol >= 0 ? 'ship_country'
    : 'NONE';

  const rows = [];
  let matched = 0, unmatched = 0, wrongMarket = 0, identityMissing = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const sellerSku   = skuCol >= 0 ? (cols[skuCol] || '').trim() : '';
    const productName = nameCol >= 0 ? (cols[nameCol] || '').trim() : '';
    const qty         = qtyCol >= 0 ? parseInt(cols[qtyCol] || '0', 10) : 1;
    const price       = priceCol >= 0 ? parseFloat(cols[priceCol] || '0') : 0;
    const dateStr     = dateCol >= 0 ? (cols[dateCol] || '').trim() : '';
    const lineId      = lineIdCol >= 0 ? (cols[lineIdCol] || '').trim() : '';

    // Marketplace filter — three signals in priority order. If none of them
    // apply, accept the row (filterSignal === 'NONE' surfaces this in
    // report_jobs so we can investigate).
    let signalled = false, isCA = false, isUS = false;
    if (channelCol >= 0) {
      const v = (cols[channelCol] || '').trim().toLowerCase();
      if (v) {
        signalled = true;
        isCA = v === 'amazon.ca';
        isUS = v === 'amazon.com' || v === 'amazon.com.us' || v === 'amazon';
      }
    } else if (currencyCol >= 0) {
      const v = (cols[currencyCol] || '').trim().toUpperCase();
      if (v) { signalled = true; isCA = v === 'CAD'; isUS = v === 'USD'; }
    } else if (shipCountryCol >= 0) {
      const v = (cols[shipCountryCol] || '').trim().toUpperCase();
      if (v) { signalled = true; isCA = v === 'CA'; isUS = v === 'US' || v === 'USA'; }
    }
    if (signalled) {
      if (market === 'CA' && !isCA) { wrongMarket++; continue; }
      if (market === 'US' && !isUS) { wrongMarket++; continue; }
    }

    const dashSku = matchAmzItemToSku(productName, sellerSku);
    if (!dashSku) { unmatched++; continue; }
    matched++;
    if (!lineId) identityMissing++;  // guard: surfaced in report_jobs + Data Health if the report ever drops the id
    rows.push({
      sellerSku,
      dashboardSku:   dashSku,
      name:           productName || null,
      quantity:       qty,
      total:          price,
      dateCreated:    dateStr,
      localDate:      toBusinessLocalDate(dateStr),
      shipmentItemId: lineId || null,  // null only if the report omitted the column — then dedup falls back to range-supersede
    });
  }
  return {
    rows,
    totalRows:          lines.length - 1,
    matchedCount:       matched,
    unmatchedCount:     unmatched,
    wrongMarketCount:   wrongMarket,
    identityMissing,    // matched rows with no shipment_item_id — should be 0
    filterSignal,
  };
}

// One cron tick of Reports work for a market.
//   Phase A  — seed any missing range jobs (cheap)
//   Phase B0 — POST every un-POSTed pending job (cheap, ~500ms each)
//   Phase B1 — poll up to maxJobs already-POSTed pending jobs for status
//   Phase C  — ingest up to maxJobs ready jobs (download + parse + INSERT)
// All phases share a single wall-clock budget (CRON_TICK_BUDGET_MS).
//
// Splitting POST from POLL means all 12 ranges enter Amazon's queue in
// parallel within the first 1-2 ticks rather than starving behind lower-id
// in-flight jobs.
export async function runAmazonReportsTick(env, market, options = {}) {
  const startMs    = Date.now();
  const deadlineMs = startMs + (options.budgetMs || CRON_TICK_BUDGET_MS);
  const maxJobs    = options.maxJobsPerPhase || 3;

  let seeded = 0, posted = 0, polled = 0, ingested = 0;
  let postError = null;
  let runError  = null;
  try {
    seeded = await seedReportJobsIfNeeded(env, market);
    if (Date.now() < deadlineMs) {
      const r = await postNewReportJobs(env, market, deadlineMs);
      posted = r.posted;
      postError = r.lastError;
    }
    if (Date.now() < deadlineMs) {
      polled = await pollExistingReportJobs(env, market, maxJobs, deadlineMs);
    }
    if (Date.now() < deadlineMs) {
      ingested = await ingestReadyJobs(env, market, maxJobs, deadlineMs);
    }
  } catch (e) {
    // Don't blow the whole cron — log and capture the error so the heartbeat
    // row reflects it. Partial counts (seeded/posted/polled/ingested) from
    // before the throw are still meaningful and get persisted as-is.
    runError = redactSecrets(e?.message || String(e));
    console.error(`Amazon reports tick ${market} error:`, runError);
  }

  // Heartbeat: write to sync_logs every tick, even when the system is idle
  // (all 24 ranges fresh-ingested → seeded/posted/polled/ingested all 0). Same
  // rationale as runAmazonOrdersChunk's write — the dashboard's chips and
  // activity log are downstream of sync_logs, and a silent table means a silent
  // UI even though cron is firing every 15 min. This is the canonical writer
  // for "when did the Reports tick last run for this market".
  //
  // action='amazon-reports' is the discriminator used by summariseSyncLog and
  // by /api/sync-status to find the latest tick per market. orders_added and
  // items_added carry the meaningful "did work happen" counters (newly ingested
  // jobs, in-flight polls advanced) — the watermark + pages_fetched columns
  // aren't applicable to Reports so they're NULL/0.
  //
  // Wrapped in its own try/catch so a sync_logs INSERT failure can't break the
  // tick — we'd rather surface the error in console than abort. Outside the
  // main try so it fires even when an upstream phase threw.
  const status = runError ? 'error' : (postError ? 'rate_limited' : 'ok');
  const errMsg = runError || (postError ? redactSecrets(String(postError)) : null);
  try {
    await env.DB.prepare(
      `INSERT INTO sync_logs
         (run_at, source, market, action, pages_fetched, orders_added, items_added,
          watermark_before, watermark_after, status, error, duration_ms)
       VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'amazon', ?, 'amazon-reports', 0, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).bind(market, ingested, polled, status, errMsg, Date.now() - startMs).run();
  } catch (e) {
    console.error(`Amazon reports tick ${market} sync_logs write failed:`, redactSecrets(e?.message || String(e)));
  }

  return { market, seeded, posted, polled, ingested, postError, durationMs: Date.now() - startMs };
}

// ─── Sales read endpoint (D1-backed, KV-cached) ────────────────────────────

export async function invalidateAmazonSalesCache(env, market) {
  if (!env?.CACHE) return;
  const m = String(market || '').toLowerCase();
  if (!m) return;
  await env.CACHE.delete(SALES_KV_KEY(m));
}

// Aggregate D1 result rows into the dashboard payload shape — same shape as
// /api/woo/sales so the frontend can treat both sources interchangeably.
function aggregateAmazonFromD1(monthRows, itemRows) {
  const { monthMap } = buildMonthWindow();
  const monthlyRevenue = [0, 0, 0, 0, 0, 0];
  const monthlyOrders  = [0, 0, 0, 0, 0, 0];
  const skuTotals = {};

  for (const row of monthRows) {
    const idx = monthMap[row.ym];
    if (idx === undefined) continue;
    monthlyRevenue[idx] = row.revenue || 0;
    monthlyOrders[idx]  = row.n_orders || 0;
  }

  for (const row of itemRows) {
    const sku = row.sku || 'unknown';
    if (!skuTotals[sku]) {
      skuTotals[sku] = {
        qty: 0, revenue: 0, name: row.name || '',
        monthly:    [0, 0, 0, 0, 0, 0],
        monthlyQty: [0, 0, 0, 0, 0, 0],
        weeklyQty:  {},
      };
    } else if (!skuTotals[sku].name && row.name) {
      skuTotals[sku].name = row.name;
    }
    const qty     = row.qty || 0;
    const revenue = row.revenue || 0;
    skuTotals[sku].qty     += qty;
    skuTotals[sku].revenue += revenue;
    const ym = (row.day || '').substring(0, 7);
    const idx = monthMap[ym];
    if (idx !== undefined) {
      skuTotals[sku].monthly[idx]    += revenue;
      skuTotals[sku].monthlyQty[idx] += qty;
    }
    const wk = getWeekKey(row.day);
    if (wk) skuTotals[sku].weeklyQty[wk] = (skuTotals[sku].weeklyQty[wk] || 0) + qty;
  }
  return { monthlyRevenue, monthlyOrders, skuTotals };
}

async function handleAmazonSalesRequest(c) {
  const market = (c.req.query('market') || 'CA').toUpperCase();
  if (!AMAZON_MARKETPLACES[market]) {
    return c.json({ error: `unsupported Amazon market: ${market}` }, 400);
  }
  if (!c.env.DB) return c.json({ error: 'D1 binding DB not configured' }, 500);

  const cacheKey = SALES_KV_KEY(market);
  const force    = c.req.query('refresh') === '1';
  if (!force && c.env.CACHE) {
    const cached = await c.env.CACHE.get(cacheKey, 'json');
    if (cached) return c.json({ ...cached, cached: true });
  }

  const { startDate } = buildMonthWindow();

  // Three D1 queries in parallel — per-month order rollup, per-SKU per-day
  // item rollup, and the sync_state watermark for the lastSync field.
  // amazon_items doesn't currently filter by status (legacy didn't either —
  // the report types we use are themselves status-filtered server-side).
  const [monthRes, itemRes, syncStateRes, jobStatusRes, unmatchedRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT substr(local_date, 1, 7) AS ym,
              COUNT(*)                 AS n_orders,
              SUM(total)               AS revenue
       FROM amazon_orders
       WHERE market = ?
         AND local_date >= ?
       GROUP BY ym`,
    ).bind(market, startDate).all(),
    c.env.DB.prepare(
      `SELECT dashboard_sku            AS sku,
              MAX(name)                AS name,
              local_date               AS day,
              SUM(quantity)            AS qty,
              SUM(total)               AS revenue
       FROM amazon_items
       WHERE market = ?
         AND dashboard_sku IS NOT NULL
         AND local_date >= ?
       GROUP BY dashboard_sku, local_date
       ORDER BY dashboard_sku, local_date ASC`,
    ).bind(market, startDate).all(),
    c.env.DB.prepare(
      `SELECT watermark, last_synced_at FROM sync_state
       WHERE source = 'amazon' AND market = ?`,
    ).bind(market).first(),
    c.env.DB.prepare(
      `SELECT status, COUNT(*) AS n
       FROM report_jobs WHERE source = 'amazon' AND market = ?
       GROUP BY status`,
    ).bind(market).all(),
    // Surface unmatched-row counts so silent SKU drops are visible to the UI.
    c.env.DB.prepare(
      `SELECT SUM(rows_unmatched) AS unmatched, SUM(rows_matched) AS matched
       FROM report_jobs WHERE source = 'amazon' AND market = ? AND status = 'ingested'`,
    ).bind(market).first(),
  ]);

  const monthRows = monthRes.results || [];
  const itemRows  = itemRes.results  || [];
  const { monthlyRevenue, monthlyOrders, skuTotals } = aggregateAmazonFromD1(monthRows, itemRows);
  const ordersInWindow = monthlyOrders.reduce((a, b) => a + b, 0);

  const reportJobsByStatus = {};
  for (const row of (jobStatusRes.results || [])) reportJobsByStatus[row.status] = row.n;

  const payload = {
    marketplace:        'Amazon',
    currency:           AMAZON_MARKETPLACES[market].currency,
    monthlyRevenue,
    monthlyOrders,
    skuTotals,
    source:             'amazon',
    dataSource:         'd1',
    windowStart:        startDate,
    ordersInWindow,
    watermark:          syncStateRes?.watermark || null,
    lastSync:           toIsoUtc(syncStateRes?.last_synced_at) || new Date().toISOString(),
    reportJobsByStatus,
    rowsMatched:        unmatchedRes?.matched || 0,
    rowsUnmatched:      unmatchedRes?.unmatched || 0,
  };

  if (c.env.CACHE) {
    await c.env.CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: SALES_TTL_SECONDS });
  }
  return c.json({ ...payload, cached: false });
}

// /api/amazon/sales — Orders-driven monthly revenue + Reports-driven per-SKU
// breakdown, bundled into one D1-backed response.
amazonRoutes.get('/sales', handleAmazonSalesRequest);

// /api/amazon/sku-sales — alias for /sales. The legacy backend/server.js had
// two separate Amazon endpoints (sales for the Orders-API monthly revenue,
// sku-sales for the Reports-API per-SKU breakdown). The Worker bundles both
// into one D1-backed response, but the frontend's Monthly SKU view still
// calls /sku-sales as a separate fetch (loadAmazonSkuSales in
// public/index.html). Without this alias, that fetch 404s, the catch
// silently logs "not available", and the per-SKU Amazon columns stay empty
// even when the data is in D1. The same KV cache key (amazon-sales-{market})
// serves both routes; refresh on either invalidates for both.
amazonRoutes.get('/sku-sales', handleAmazonSalesRequest);

// ─── FBA Inventory snapshot (KV-cached, stale-while-revalidate) ────────────
//
// Mirrors the SalesBinder snapshot pattern (REST → flatten → KV) with a few
// SP-API-specific wrinkles ported from legacy backend/server.js fetchAmzInventory:
//
//   • Endpoint: GET /fba/inventory/v1/summaries with granularityType=Marketplace
//     and details=true. Returns inventorySummaries[] with nested inventoryDetails.
//   • Pagination via data.pagination.nextToken (note: nested under .pagination,
//     unlike Orders' top-level NextToken). 3s sleep between paginated calls,
//     hard cap of 10 pages. No Pong's FBA catalog is small (~12 SKUs/market in
//     practice) so we never hit the cap, but it's defensive.
//   • dashboardSku is mapped via matchAmzItemToSku so cross-channel SKU rollups
//     can join (additive — the existing FBA tile only reads sellerSku +
//     fulfillable, so this doesn't break the legacy frontend reader).
//   • RateLimitedError on a fresh fetch falls back to whatever's in KV (with
//     `staleFallback: true`). Matches SalesBinder's upstream-error pattern.
//
// Caching strategy: KV entry lives 24h, but considered FRESH only for 1h. After
// 1h we serve the stale snapshot immediately and spawn a background refresh via
// ctx.waitUntil — so users never block on a 10–15s paginated cold fetch unless
// the cache is genuinely empty. ?refresh=true forces synchronous refresh.

async function fetchFbaInventoryFromSpApi(env, market) {
  const mp = AMAZON_MARKETPLACES[market];
  if (!mp) throw new Error(`Unknown Amazon market: ${market}`);

  let allItems  = [];
  let nextToken = null;
  let page      = 0;

  do {
    const params = nextToken
      ? { nextToken }
      : {
          granularityType: 'Marketplace',
          granularityId:   mp.id,
          marketplaceIds:  mp.id,
          details:         'true',
        };
    const data = await spApiRequest(env, market, '/fba/inventory/v1/summaries', params);
    const items = data?.payload?.inventorySummaries || [];
    allItems = allItems.concat(items);
    nextToken = data?.pagination?.nextToken || null;
    page++;
    if (nextToken && page < FBA_INVENTORY_MAX_PAGES) {
      await new Promise((r) => setTimeout(r, FBA_INVENTORY_PAGE_SLEEP_MS));
    }
  } while (nextToken && page < FBA_INVENTORY_MAX_PAGES);

  let matched = 0, unmatched = 0;
  const inventory = allItems.map((item) => {
    const sellerSku   = item.sellerSku || '';
    const productName = item.productName || '';
    const dashboardSku = matchAmzItemToSku(productName, sellerSku);
    if (dashboardSku) matched++; else if (sellerSku) unmatched++;
    return {
      asin:          item.asin || '',
      sellerSku,
      dashboardSku:  dashboardSku || null,
      fnSku:         item.fnSku || '',
      productName,
      // Sellable stock only. Fall back to totalQuantity ONLY when inventoryDetails
      // is absent — NOT when fulfillable is a real 0. A genuine 0 (stock all
      // inbound/reserved during a restock) must stay 0; `|| totalQuantity` used to
      // leak inbound+reserved units into "sellable" and under-flag reorders.
      fulfillable:   item.inventoryDetails
                       ? (item.inventoryDetails.fulfillableQuantity ?? 0)
                       : (item.totalQuantity || 0),
      inbound:       item.inventoryDetails?.inboundWorkingQuantity || 0,
      reserved:      item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
      unfulfillable: item.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity || 0,
    };
  });

  return {
    inventory,
    count:        inventory.length,
    matched,
    unmatched,
    marketplace:  market,
    source:       'amazon-sp-api',
    pagesFetched: page,
    lastSync:     new Date().toISOString(),
  };
}

// Refresh helper used both for the foreground cold-fetch path and the
// background stale-while-revalidate path. Persists to KV on success; logs
// (but doesn't throw) on RateLimitedError so a background refresh failure
// doesn't surface as an unhandled rejection.
async function refreshFbaInventory(env, market, { background = false } = {}) {
  try {
    const fresh = await fetchFbaInventoryFromSpApi(env, market);
    if (env.CACHE) {
      await env.CACHE.put(
        FBA_INVENTORY_KV_KEY(market),
        JSON.stringify(fresh),
        { expirationTtl: FBA_INVENTORY_KV_TTL_S },
      );
    }
    return fresh;
  } catch (e) {
    if (background) {
      console.error(
        `Amazon ${market} FBA bg refresh failed:`,
        redactSecrets(e?.message || String(e)),
      );
      return null;
    }
    throw e;
  }
}

// ─── FBA Inventory cron sync ───────────────────────────────────────────────
//
// Runs from the scheduled handler (src/index.js) every 15 min. For each
// market, refresh the KV snapshot if it's older than FBA_INVENTORY_FRESH_S
// (1h) — so worst-case staleness is ~1h regardless of whether anyone has the
// dashboard open. Cheaper than refreshing on every tick, and stays within the
// 30s scheduled-handler budget when paired with Orders + Reports work.
//
// Markets run in parallel via Promise.allSettled — a SP-API rate-limit on one
// shouldn't starve the other. Failures are logged and swallowed so a bad tick
// doesn't poison the next.
export async function runAmazonInventoryCronSync(env) {
  if (!(env.AMAZON_REFRESH_TOKEN && env.AMAZON_LWA_CLIENT_ID && env.AMAZON_LWA_CLIENT_SECRET)) {
    return; // not configured — silent skip, matches Orders cron behaviour
  }
  if (!env.CACHE) return;

  const FRESH_MS = FBA_INVENTORY_FRESH_S * 1000;
  const now = Date.now();

  async function maybeRefresh(market) {
    try {
      const cached = await env.CACHE.get(FBA_INVENTORY_KV_KEY(market), 'json');
      const ageMs = cached?.lastSync ? now - new Date(cached.lastSync).getTime() : Infinity;
      if (ageMs < FRESH_MS) {
        // Still fresh — skip the upstream call. This is what keeps us under
        // SP-API rate limits on the typical "no one's using it" tick.
        return { market, action: 'skip', reason: `fresh (${Math.round(ageMs / 60000)}m old)` };
      }
      const fresh = await refreshFbaInventory(env, market, { background: true });
      if (fresh === null) return { market, action: 'rate_limited' };
      return { market, action: 'refreshed', count: fresh.count, ageMs };
    } catch (e) {
      console.error(
        `Amazon FBA inventory cron ${market} failed:`,
        redactSecrets(e?.message || String(e)),
      );
      return { market, action: 'error', error: e?.message };
    }
  }

  const results = await Promise.allSettled([maybeRefresh('CA'), maybeRefresh('US')]);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.action === 'refreshed') {
      console.log(
        `Amazon FBA inventory cron ${r.value.market}: refreshed (${r.value.count} SKUs)`,
      );
    }
  }
}

amazonRoutes.get('/inventory', async (c) => {
  const market = (c.req.query('market') || 'CA').toUpperCase();
  if (!AMAZON_MARKETPLACES[market]) {
    return c.json({ error: `unsupported Amazon market: ${market}` }, 400);
  }
  const force = c.req.query('refresh') === 'true' || c.req.query('refresh') === '1';
  const cache = c.env.CACHE;
  const kvKey = FBA_INVENTORY_KV_KEY(market);

  // Forced refresh — synchronous, falls back to cache on rate-limit.
  if (force) {
    try {
      const fresh = await refreshFbaInventory(c.env, market);
      return c.json({ ...fresh, cached: false });
    } catch (e) {
      if (e?.rateLimited && cache) {
        const cached = await cache.get(kvKey, 'json');
        if (cached) {
          return c.json({
            ...cached,
            cached:        true,
            staleFallback: true,
            error:         `Amazon rate-limited; serving cached snapshot (retry after ${e.retryAfter || 30}s)`,
          });
        }
      }
      throw e; // global onError sanitizes
    }
  }

  // Cached path — fast.
  if (cache) {
    const cached = await cache.get(kvKey, 'json');
    if (cached) {
      const ageS = (Date.now() - new Date(cached.lastSync).getTime()) / 1000;
      if (Number.isFinite(ageS) && ageS < FBA_INVENTORY_FRESH_S) {
        // Fresh — serve as-is.
        return c.json({ ...cached, cached: true });
      }
      // Stale — serve immediately, refresh in background.
      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(refreshFbaInventory(c.env, market, { background: true }));
      }
      return c.json({ ...cached, cached: true, stale: true });
    }
  }

  // Cold cache — synchronous fetch. ~10–15s end-to-end with pagination.
  try {
    const fresh = await refreshFbaInventory(c.env, market);
    return c.json({ ...fresh, cached: false });
  } catch (e) {
    if (e?.rateLimited) {
      return c.json(
        { error: 'rate_limited', retryAfter: e.retryAfter || 30, market, source: 'amazon-sp-api' },
        503,
      );
    }
    throw e;
  }
});

// Lightweight connection check — fetches the LWA token only. No SP-API call.
amazonRoutes.get('/test', async (c) => {
  try {
    const token = await getAmazonAccessToken(c.env);
    return c.json({ connected: true, tokenPrefix: (token || '').substring(0, 4) });
  } catch (e) {
    return c.json({ connected: false, error: redactSecrets(e?.message || String(e)) });
  }
});
