/**
 * CIN7 → D1 incremental sync. Phase A of the v2.36 AU→D1+cron port.
 *
 * Why this exists. Until v2.36 the AU dashboard read CIN7 on demand on every
 * cold cache miss — ~50 paginated calls per month tab. NA solved the same
 * problem in v2.31 with a D1+cron architecture (15-min cron writes
 * incremental Woo/Amazon rows to D1; dashboard reads from D1). After the
 * v2.35.6 KV-key-bump invalidated all months at once and the front-end
 * pre-fetch fired 5 concurrent month fetches into CIN7's 3/sec rate limit,
 * the architectural gap was no longer tolerable. Full design + phased
 * rollout: `Melanie's Context/next-session-brief-v2.36-au-d1-port.md`.
 *
 * Two chunk functions, mirroring `runBackfillChunk` (src/admin.js) for Woo:
 *
 *   runCin7SalesOrdersChunk(env)
 *     One incremental tick. Reads watermark from sync_state, fetches one
 *     page (≤250 records) of SalesOrders whose ModifiedDate >= watermark,
 *     upserts each row + its line items into D1, advances the watermark to
 *     the latest modified_date seen, appends a sync_logs row, returns a
 *     result the cron handler logs.
 *
 *   runCin7CreditNotesChunk(env)
 *     Same shape against CIN7's /CreditNotes endpoint. CIN7 Omni v1 keeps
 *     sales orders and credit notes on separate endpoints, so each has its
 *     own watermark (`sync_state.source = 'cin7_credit_notes'`).
 *
 * Watermark strategy. We watermark on `ModifiedDate` (not `CreatedDate`) so
 * retroactive edits — e.g. a DRAFT credit note flipping to APPROVED days
 * after creation, or a VOID landing on an old order — propagate through to
 * D1 on the next tick. We fall back to createdDate per-record when
 * modifiedDate is missing.
 *
 * Boundary handling (v2.2.10). Strict `ModifiedDate > '${watermark}'` on the
 * WHERE clause + advance to `MAX(modifiedDate) seen`. Why strict `>`: v2.2.7
 * shipped with `>=` and stalled forever on a 250-record cluster all sharing
 * `2025-11-08T13:00:06Z` (`MAX = watermark`, no forward progress). v2.2.8/9
 * tried a composite `(modified_date, id)` cursor to walk through the
 * cluster, but CIN7's `where` clause silently drops `Id` filters — see the
 * 2026-05-12 transcript for the diagnosis — so the composite reduces to
 * `ModifiedDate >= watermark` at the API layer and the same stall returns.
 *
 * The accepted trade-off: if a future cluster of >250 records ever shares
 * a single modifiedDate, the cluster members that don't fit on the first
 * page get skipped. In AU steady state (a few new records per day) clusters
 * are vanishingly rare; the recovery path when it happens is a CSV
 * reconcile via `scripts/import-cin7-csv.py` for the affected date range.
 * INSERT OR REPLACE makes any reconcile idempotent.
 *
 * Schema note. `sync_state.watermark_id` was added by migration 0006 for the
 * v2.2.8 composite cursor; v2.2.10 stops reading or writing it. The column
 * stays in the schema (cheap to leave) and can be dropped in a future
 * cleanup migration.
 *
 * Soft-delete VOID. VOID/CANCELLED rows are stored in D1 with `status='VOID'`
 * (or as-returned) rather than deleted, so their line items remain auditable.
 * Read queries filter `WHERE status NOT IN ('VOID','VOIDED','CANCELLED')`.
 * DRAFT credit notes: written to D1 (so a later promotion to APPROVED gets
 * captured via ModifiedDate); filtered out at read time.
 *
 * Rate-limit budget. One page per tick × 2 endpoints (sales orders + credit
 * notes) × 4 ticks/hour = 8 CIN7 calls/hour. Well under all three of
 * CIN7's limits (3/sec, 60/min, 5000/day).
 *
 * Backfill from epoch. On first deploy, watermark defaults to
 * '1970-01-01T00:00:00Z', so cron starts pulling from the beginning of CIN7
 * history one page per tick. For ~10K orders/month and ~250 rows/page that
 * is roughly 1 hour to backfill 12 months. Faster initial backfill is
 * available via POST /api/admin/cin7-backfill (defined in src/admin.js).
 */

import {
  cin7Fetch,
  normalizeAuSku,
  isAuSkuCode,
  attributeCin7Order,
  CIN7_PAGE_SIZE,
} from './cin7.js';

const PAGE_SIZE = CIN7_PAGE_SIZE;
const EPOCH_WATERMARK = '1970-01-01T00:00:00Z';

// ─── Helpers ────────────────────────────────────────────────────────────────

// Pick the best timestamp we can use for the watermark. CIN7's response
// fields are camelCase. Prefer modifiedDate (the watermark field); fall back
// to createdDate if a record doesn't carry modifiedDate (defensive — the
// brief flagged this gotcha in §8). If both are missing, return null and
// the caller will skip the row's watermark contribution.
function pickModifiedDate(row) {
  return String(row?.modifiedDate || row?.createdDate || '').trim() || null;
}
function pickCreatedDate(row) {
  return String(row?.createdDate || row?.modifiedDate || '').trim() || null;
}

// ─── Cluster-aware cursor advance (v2.2.50) ──────────────────────────────────
//
// The 2026-05-23 and 2026-06-06 stalls had the same root cause: a block of
// >250 records all sharing one ModifiedDate. CIN7 Omni coerces
// `ModifiedDate > X` to `>=` and silently drops `Id` filters (see file
// docstring), so the ONLY lever for walking past such a same-timestamp cluster
// is the `page` parameter. We persist the page in the dormant
// `sync_state.watermark_id` column ("cluster page").
//
// Given the page of rows just fetched at (watermark, clusterPage):
//   • FULL page AND every row sits exactly on the watermark timestamp → we're
//     inside a cluster bigger than one page. Hold the watermark, advance the
//     page; next tick reads the next slice of the same cluster.
//   • Otherwise the cluster (if any) is cleared → advance the watermark to the
//     newest timestamp on the page and reset the page to 1.
//
// This walks any cluster in ceil(clusterSize / PAGE_SIZE) ticks instead of
// looping forever. It assumes CIN7 returns a stable order for the same query
// across ticks; for the real-world case (historical, static clusters) it does.
// The weekly CreatedDate safety-net backfill is the insurance for any edge.
//
// Pure function (no I/O) so the advance logic is trivially reviewable.
function decideNextCursor({ rows, watermark, clusterPage, pageSize, pickTs }) {
  const timestamps = (rows || []).map(pickTs).filter(Boolean);
  if (timestamps.length === 0) {
    // Nothing came back — stay on the watermark, reset the page so we never
    // strand the cursor mid-cluster on an empty tail page.
    return { watermark, clusterPage: 1 };
  }
  let maxTs = watermark;
  for (const t of timestamps) if (t > maxTs) maxTs = t;
  const fullPage = rows.length >= pageSize;
  const allAtWatermark = timestamps.every((t) => t === watermark);
  if (fullPage && allAtWatermark) {
    // Mid-cluster: same watermark, next page.
    return { watermark, clusterPage: clusterPage + 1 };
  }
  // Cluster cleared (or there never was one): advance, reset page to 1.
  return { watermark: maxTs, clusterPage: 1 };
}

// Truncate raw_json strings to a safe ceiling so a giant payload doesn't
// blow up a single D1 write. 32 KB per row is generous (typical CIN7 sales
// orders are under 4 KB) and bounds the write size predictably.
const RAW_JSON_MAX = 32 * 1024;
function truncateRawJson(obj) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch {
    return null;
  }
  return s.length > RAW_JSON_MAX ? s.slice(0, RAW_JSON_MAX) : s;
}

// Compute precomputed line-item fields. Returns the same shape for both
// sales-order items and credit-note items, but `tinsSigned` differs:
//   • salesItem:    tins = uomSize > 1 ? qty : qty * multiplier   (POSITIVE)
//   • creditItem:   tins = is_au_sku ? -|that same value| : 0     (SIGNED)
// Mirrors the v2.35.4 / v2.35.6 read-side rules in src/cin7.js so write-time
// columns make read-side queries simple SUMs.
function deriveLineFields(li, { kind /* 'sales' | 'credit' */ }) {
  const code      = String(li?.code || li?.sku || '').trim() || null;
  const qty       = Number(li?.qty ?? li?.quantity ?? 0) || 0;
  const uomSize   = Number(li?.uomSize ?? 0) || 0;
  const unitPrice = Number(li?.unitPrice ?? 0) || 0;
  const total     = Number(li?.total ?? (qty * unitPrice)) || 0;
  const name      = String(li?.name || '').slice(0, 60) || null;
  const parentId  = Number(li?.parentId ?? 0) || 0;
  const isAu      = isAuSkuCode(code);

  let baseSku = null;
  let mult    = 1;
  if (code) {
    const [b, m] = normalizeAuSku(code);
    baseSku = b || null;
    mult = Number(m) || 1;
  }

  // Encode the v2.35.4 Alt UOM rule once, at write time. uomSize > 1 means
  // CIN7 already reports `qty` in BASE tin units (Alt UOM line); standalone
  // SKUs report qty in product units and need the SKU-pattern multiplier.
  const tinsRaw = uomSize > 1 ? qty : qty * mult;
  let tins = 0;
  if (kind === 'sales') {
    // Sales: positive tins for every line; parent/child handling happens at
    // read time via WHERE parent_id = 0 (we still store children so the row
    // shape is auditable, and so a future read query can use them if needed).
    tins = tinsRaw;
  } else {
    // Credit notes: per v2.35.6, tins only contribute from real AU-SKU
    // lines (empty-code "Amount" and non-AU placeholders like "196" don't
    // move the tin counter). Sign is always negative.
    tins = isAu ? -Math.abs(tinsRaw) : 0;
  }

  return {
    code,
    baseSku,
    multiplier: mult,
    uomSize: uomSize || 1,
    qty,
    unitPrice,
    total,
    name,
    isAuSku: isAu ? 1 : 0,
    parentId,
    tins,
    revenueSigned: -Math.abs(total),  // used by credit-note items only
  };
}

// Append a sync_logs row. Reuses the existing schema (no migration needed)
// with `source` carrying one of 'cin7_sales_orders' | 'cin7_credit_notes'.
async function logRun(env, {
  source, action, pagesFetched, rowsUpserted, itemsUpserted,
  watermarkBefore, watermarkAfter, status, error, durationMs,
}) {
  await env.DB.prepare(
    `INSERT INTO sync_logs
       (run_at, source, market, action, pages_fetched, orders_added, items_added,
        watermark_before, watermark_after, status, error, duration_ms)
     VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    source, action, pagesFetched, rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter, status, error || null, durationMs,
  ).run();
}

// v2.2.50: read both the watermark AND the cluster page (watermark_id), which
// the cluster-aware pagination re-purposes. Creates the row if absent.
async function readSyncCursor(env, source) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_state (source, market, watermark) VALUES (?, 'AU', ?)`,
  ).bind(source, EPOCH_WATERMARK).run();
  const row = await env.DB.prepare(
    `SELECT watermark, watermark_id FROM sync_state WHERE source = ? AND market = 'AU'`,
  ).bind(source).first();
  const page = Number(row?.watermark_id);
  return {
    watermark: row?.watermark || EPOCH_WATERMARK,
    clusterPage: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

// ─── Sales orders chunk ────────────────────────────────────────────────────

const SALES_FIELDS = [
  'id', 'reference', 'createdDate', 'modifiedDate', 'dispatchedDate',
  'channel', 'posRegister', 'branchName',
  'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
  'status', 'stage', 'invoiceStatus',
  'estimatedDeliveryDate',
  'total', 'subTotal', 'productTotal',
  'lineItems',
].join(',');

/**
 * Build the INSERT/DELETE statements for a batch of sales orders. Extracted in
 * v2.2.50 so the incremental cron chunk AND the CreatedDate safety-net backfill
 * share ONE copy of the attribution + column mapping (no second code path to
 * drift). Returns { stmts, rowsUpserted, itemsUpserted }; the caller batches
 * the statements. Rows missing a usable timestamp are skipped (they'd violate
 * NOT NULL on created_date/modified_date).
 */
function buildSalesOrderStatements(env, orders, { persistRawJson }) {
  const stmts = [];
  let rowsUpserted = 0;
  let itemsUpserted = 0;
  for (const o of orders) {
    const modifiedDate = pickModifiedDate(o);
    const createdDate  = pickCreatedDate(o);
    if (!modifiedDate || !createdDate) continue;
    rowsUpserted++;

    const channelAttr = attributeCin7Order(o);
    const company   = String(o?.company   || '').slice(0, 200) || null;
    const firstName = String(o?.firstName || '').slice(0, 200) || null;
    const lastName  = String(o?.lastName  || '').slice(0, 200) || null;
    const memberId  = Number(o?.memberId ?? 0) || null;
    const memberEmail = String(o?.memberEmail || '').slice(0, 200) || null;
    const status   = String(o?.status || '').slice(0, 40) || 'UNKNOWN';
    const stage          = String(o?.stage || '').slice(0, 40) || null;
    const dispatchedDate = String(o?.dispatchedDate || '').trim() || null;
    const deliveryDate   = String(o?.estimatedDeliveryDate || '').trim() || null;
    const total        = Number(o?.total        ?? 0) || 0;
    const subTotal     = Number(o?.subTotal     ?? 0) || 0;
    const productTotal = Number(o?.productTotal ?? 0) || 0;
    const reference    = String(o?.reference || '').slice(0, 100) || null;
    const rawJson = persistRawJson ? truncateRawJson(o) : null;

    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO cin7_sales_orders
           (id, reference, market, status, stage, channel_attr, company,
            first_name, last_name, member_id, member_email,
            total, sub_total, product_total,
            created_date, modified_date, dispatched_date, delivery_date,
            raw_json, synced_at)
         VALUES (?, ?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      ).bind(
        o.id, reference, status, stage, channelAttr, company,
        firstName, lastName, memberId, memberEmail,
        total, subTotal, productTotal,
        createdDate, modifiedDate, dispatchedDate, deliveryDate,
        rawJson,
      ),
    );

    // Re-build line items: scope DELETE to this order_id, then INSERT.
    stmts.push(
      env.DB.prepare(`DELETE FROM cin7_sales_order_items WHERE order_id = ?`).bind(o.id),
    );
    const lineItems = Array.isArray(o.lineItems) ? o.lineItems : [];
    for (const li of lineItems) {
      const d = deriveLineFields(li, { kind: 'sales' });
      itemsUpserted++;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO cin7_sales_order_items
             (order_id, market, parent_id, code, base_sku, multiplier,
              uom_size, qty, unit_price, total, name, is_au_sku, tins, created_date)
           VALUES (?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          o.id, d.parentId, d.code, d.baseSku, d.multiplier,
          d.uomSize, d.qty, d.unitPrice, d.total, d.name, d.isAuSku, d.tins,
          createdDate,
        ),
      );
    }
  }
  return { stmts, rowsUpserted, itemsUpserted };
}

/**
 * Run one CIN7 SalesOrders → D1 chunk.
 *
 * Returns:
 *   {
 *     ok, source, action, pagesFetched, rowsUpserted, itemsUpserted,
 *     watermarkBefore, watermarkAfter, durationMs, more
 *   }
 *
 * `more` is a hint that another page is available (the response was full).
 * Cron ignores it (next tick handles it); admin backfill uses it to drive a
 * loop until caught up.
 *
 * @param {object} env  Worker env (DB binding, CIN7 secrets).
 * @param {object} opts
 *   - action: 'cin7-incremental' (cron) | 'cin7-backfill' (admin loop)
 *   - persistRawJson: boolean (default true). Set false for bulk backfill
 *     where CPU is the constraint.
 */
export async function runCin7SalesOrdersChunk(env, opts = {}) {
  const startMs = Date.now();
  const source = 'cin7_sales_orders';
  const action = opts.action || 'cin7-incremental';
  const persistRawJson = opts.persistRawJson !== false;

  if (!env.DB) {
    throw new Error('cin7 sync: env.DB binding not configured');
  }
  if (!(env.CIN7_USERNAME && env.CIN7_CONNECTION_KEY)) {
    throw new Error('cin7 sync: CIN7_USERNAME / CIN7_CONNECTION_KEY not set');
  }

  const { watermark: watermarkBefore, clusterPage } = await readSyncCursor(env, source);

  // v2.2.50 cluster-aware: fetch ModifiedDate >= watermark at the current
  // cluster page, ascending ModifiedDate. We use `>=` explicitly (CIN7 coerces
  // `>` to `>=` regardless) because the page-walk in decideNextCursor relies on
  // re-reading from the watermark timestamp. The `order` param is essential —
  // without it CIN7 returns id-ordered batches and the advance point would skip
  // records (v2.2.8's regression). See decideNextCursor for the cluster logic.
  const where = `ModifiedDate>='${watermarkBefore}'`;
  let rows;
  try {
    rows = await cin7Fetch(env, 'SalesOrders', {
      fields: SALES_FIELDS,
      where,
      order: 'ModifiedDate ASC',
      page: clusterPage,
      rows: PAGE_SIZE,
    });
  } catch (e) {
    const durationMs = Date.now() - startMs;
    await logRun(env, {
      source, action, pagesFetched: 0, rowsUpserted: 0, itemsUpserted: 0,
      watermarkBefore, watermarkAfter: watermarkBefore,
      status: 'error', error: String(e?.message || e).slice(0, 500), durationMs,
    });
    throw e;
  }
  const orders = Array.isArray(rows) ? rows : [];

  let rowsUpserted = 0;
  let itemsUpserted = 0;

  if (orders.length > 0) {
    const built = buildSalesOrderStatements(env, orders, { persistRawJson });
    rowsUpserted = built.rowsUpserted;
    itemsUpserted = built.itemsUpserted;

    // D1 batches are transactional; chunk if we have a lot of statements.
    const CHUNK = 500;
    for (let i = 0; i < built.stmts.length; i += CHUNK) {
      await env.DB.batch(built.stmts.slice(i, i + CHUNK));
    }
  }

  // v2.2.50 cluster-aware advance. Either step the watermark forward to the
  // newest timestamp seen (and reset the page), or — if this whole page sat on
  // a single timestamp cluster — hold the watermark and advance the page so the
  // next tick walks the next slice. watermark_id now carries the cluster page.
  const next = decideNextCursor({
    rows: orders, watermark: watermarkBefore, clusterPage,
    pageSize: PAGE_SIZE, pickTs: pickModifiedDate,
  });

  await env.DB.prepare(
    `UPDATE sync_state
        SET watermark = ?, watermark_id = ?,
            last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE source = ? AND market = 'AU'`,
  ).bind(next.watermark, next.clusterPage, source).run();

  const durationMs = Date.now() - startMs;
  await logRun(env, {
    source, action, pagesFetched: 1, rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter: next.watermark, status: 'ok', durationMs,
  });

  // `more`: a full page means either the cluster continues or another
  // ModifiedDate slice awaits — the backfill loop keeps going while true.
  return {
    ok: true,
    source, action,
    pagesFetched: 1,
    rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter: next.watermark,
    clusterPage: next.clusterPage,
    more: orders.length >= PAGE_SIZE,
    durationMs,
  };
}

// ─── Credit notes chunk ────────────────────────────────────────────────────

const CREDIT_FIELDS = [
  'id', 'reference', 'createdDate', 'modifiedDate',
  'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
  'status', 'invoiceStatus',
  'total', 'subTotal', 'productTotal',
  'lineItems',
].join(',');

/**
 * Run one CIN7 CreditNotes → D1 chunk. Same shape as the sales-orders chunk;
 * separate watermark; precomputes signed `tins` + `revenue_signed` so the
 * read-side aggregate is a simple SUM.
 */
export async function runCin7CreditNotesChunk(env, opts = {}) {
  const startMs = Date.now();
  const source = 'cin7_credit_notes';
  const action = opts.action || 'cin7-incremental';
  const persistRawJson = opts.persistRawJson !== false;

  if (!env.DB) {
    throw new Error('cin7 sync: env.DB binding not configured');
  }
  if (!(env.CIN7_USERNAME && env.CIN7_CONNECTION_KEY)) {
    throw new Error('cin7 sync: CIN7_USERNAME / CIN7_CONNECTION_KEY not set');
  }

  const { watermark: watermarkBefore, clusterPage } = await readSyncCursor(env, source);

  // v2.2.50 cluster-aware: same shape as the sales-orders chunk (ModifiedDate
  // >= watermark, ascending, at the current cluster page). Credit notes are
  // far lower volume so clusters are unlikely, but sharing the logic keeps the
  // two endpoints from drifting.
  const where = `ModifiedDate>='${watermarkBefore}'`;
  let rows;
  try {
    rows = await cin7Fetch(env, 'CreditNotes', {
      fields: CREDIT_FIELDS,
      where,
      order: 'ModifiedDate ASC',
      page: clusterPage,
      rows: PAGE_SIZE,
    });
  } catch (e) {
    const durationMs = Date.now() - startMs;
    await logRun(env, {
      source, action, pagesFetched: 0, rowsUpserted: 0, itemsUpserted: 0,
      watermarkBefore, watermarkAfter: watermarkBefore,
      status: 'error', error: String(e?.message || e).slice(0, 500), durationMs,
    });
    throw e;
  }
  const creditNotes = Array.isArray(rows) ? rows : [];

  let rowsUpserted = 0;
  let itemsUpserted = 0;

  if (creditNotes.length > 0) {
    const stmts = [];
    for (const cn of creditNotes) {
      const modifiedDate = pickModifiedDate(cn);
      const createdDate  = pickCreatedDate(cn);
      if (!modifiedDate || !createdDate) continue;
      rowsUpserted++;

      const company   = String(cn?.company   || '').slice(0, 200) || null;
      const firstName = String(cn?.firstName || '').slice(0, 200) || null;
      const lastName  = String(cn?.lastName  || '').slice(0, 200) || null;
      const memberId  = Number(cn?.memberId ?? 0) || null;
      const memberEmail = String(cn?.memberEmail || '').slice(0, 200) || null;
      const status   = String(cn?.status || '').slice(0, 40) || 'UNKNOWN';
      const total        = Number(cn?.total        ?? 0) || 0;
      const subTotal     = Number(cn?.subTotal     ?? 0) || 0;
      const productTotal = Number(cn?.productTotal ?? 0) || 0;
      const reference    = String(cn?.reference || '').slice(0, 100) || null;
      const rawJson = persistRawJson ? truncateRawJson(cn) : null;

      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO cin7_credit_notes
             (id, reference, market, status, company,
              first_name, last_name, member_id, member_email,
              total, sub_total, product_total,
              created_date, modified_date, raw_json,
              synced_at)
           VALUES (?, ?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        ).bind(
          cn.id, reference, status, company,
          firstName, lastName, memberId, memberEmail,
          total, subTotal, productTotal,
          createdDate, modifiedDate, rawJson,
        ),
      );

      stmts.push(
        env.DB.prepare(`DELETE FROM cin7_credit_note_items WHERE credit_note_id = ?`).bind(cn.id),
      );

      const lineItems = Array.isArray(cn.lineItems) ? cn.lineItems : [];
      for (const li of lineItems) {
        const d = deriveLineFields(li, { kind: 'credit' });
        itemsUpserted++;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO cin7_credit_note_items
               (credit_note_id, market, parent_id, code, base_sku, multiplier,
                uom_size, qty, unit_price, total, name, is_au_sku,
                tins, revenue_signed, created_date)
             VALUES (?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            cn.id, d.parentId, d.code, d.baseSku, d.multiplier,
            d.uomSize, d.qty, d.unitPrice, d.total, d.name, d.isAuSku,
            d.tins, d.revenueSigned,
            createdDate,
          ),
        );
      }
    }

    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }

  }

  // v2.2.50 cluster-aware advance — identical logic to the sales-orders chunk.
  const next = decideNextCursor({
    rows: creditNotes, watermark: watermarkBefore, clusterPage,
    pageSize: PAGE_SIZE, pickTs: pickModifiedDate,
  });

  await env.DB.prepare(
    `UPDATE sync_state
        SET watermark = ?, watermark_id = ?,
            last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE source = ? AND market = 'AU'`,
  ).bind(next.watermark, next.clusterPage, source).run();

  const durationMs = Date.now() - startMs;
  await logRun(env, {
    source, action, pagesFetched: 1, rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter: next.watermark, status: 'ok', durationMs,
  });

  return {
    ok: true,
    source, action,
    pagesFetched: 1,
    rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter: next.watermark,
    clusterPage: next.clusterPage,
    more: creditNotes.length >= PAGE_SIZE,
    durationMs,
  };
}

// ─── Backfill driver (used by admin endpoint) ──────────────────────────────

/**
 * Loop one of the chunk functions until caught up (or wall-clock budget hit).
 * Used by POST /api/admin/cin7-backfill as an accelerator over the 15-min
 * cron cadence. Manual trigger only; same chunk functions used by cron, so
 * there is no second code path to keep in sync.
 *
 * Bounded by:
 *   • maxChunks         — hard upper bound on iterations (default 60).
 *   • wallClockBudgetMs — stop when we approach the Workers Free 30s cap
 *                         (default 25000 — leaves headroom for the response).
 */
export async function runCin7BackfillLoop(env, chunkFn, opts = {}) {
  // Defaults sized to stay well under the Cloudflare Workers 50-subrequest
  // budget per invocation (brief §8). Each chunk = 1 CIN7 fetch + a few D1
  // batches, so ~30 chunks gives meaningful progress while leaving headroom
  // for the response itself. Caller can override either bound via query params
  // if the chunks are running cheap and they want to push further.
  const maxChunks = Math.max(1, Number(opts.maxChunks) || 30);
  const wallClockBudgetMs = Math.max(1000, Number(opts.wallClockBudgetMs) || 20_000);
  const start = Date.now();

  const chunks = [];
  let totalRows = 0;
  let totalItems = 0;
  let lastResult = null;

  for (let i = 0; i < maxChunks; i++) {
    if (Date.now() - start > wallClockBudgetMs) {
      // Budget exhausted — return what we have. Caller can re-invoke to
      // continue (watermark persists on the sync_state row).
      break;
    }
    const result = await chunkFn(env, {
      action: opts.action || 'cin7-backfill',
      persistRawJson: opts.persistRawJson,
    });
    chunks.push({
      rowsUpserted: result.rowsUpserted,
      itemsUpserted: result.itemsUpserted,
      watermarkBefore: result.watermarkBefore,
      watermarkAfter: result.watermarkAfter,
      durationMs: result.durationMs,
    });
    totalRows  += result.rowsUpserted;
    totalItems += result.itemsUpserted;
    lastResult = result;
    if (!result.more) break;
  }

  return {
    ok: true,
    chunksRun: chunks.length,
    totalRowsUpserted: totalRows,
    totalItemsUpserted: totalItems,
    finalWatermark: lastResult?.watermarkAfter,
    moreAvailable: !!(lastResult && lastResult.more),
    durationMs: Date.now() - start,
    chunks,
  };
}

// ─── Weekly safety-net backfill (v2.2.50) ───────────────────────────────────

/**
 * Re-fetch recent SalesOrders ordered by CreatedDate (NOT ModifiedDate) and
 * INSERT OR REPLACE them. This is the insurance the v2.2.49 changelog queued:
 * because it orders by CreatedDate, it sidesteps the ModifiedDate clusters that
 * stall the incremental cron entirely, and because it sweeps a whole window it
 * catches anything the incremental path structurally missed — e.g. the
 * 2026-06-02 manual watermark jump that skipped May 24-31, or any future jump.
 *
 * Idempotent (INSERT OR REPLACE) and stateless: each run re-sweeps the window
 * from scratch, so it never strands a cursor. Bounded by `maxPages` and
 * `wallClockBudgetMs` so a single invocation can't run away or exceed the
 * Workers subrequest budget — a partial sweep is harmless (the incremental
 * cron keeps the most-recent data fresh; the next run finishes the rest).
 *
 * Ordered CreatedDate ASC, so when bounded it always covers the OLDEST part of
 * the window first — exactly the part most likely to have a historical hole.
 *
 * @param {object} env
 * @param {object} opts
 *   - sinceDays:          window length in days (default 60).
 *   - maxPages:           hard page cap per run (default 40).
 *   - wallClockBudgetMs:  stop when approaching this (default 45000).
 *   - persistRawJson:     default true.
 */
export async function runCin7SafetyNetBackfill(env, opts = {}) {
  const startMs = Date.now();
  const source = 'cin7_sales_orders';
  if (!env.DB) {
    throw new Error('cin7 safety-net: env.DB binding not configured');
  }
  if (!(env.CIN7_USERNAME && env.CIN7_CONNECTION_KEY)) {
    throw new Error('cin7 safety-net: CIN7_USERNAME / CIN7_CONNECTION_KEY not set');
  }

  const sinceDays = Math.max(1, Number(opts.sinceDays) || 60);
  const maxPages = Math.max(1, Number(opts.maxPages) || 40);
  const wallClockBudgetMs = Math.max(1000, Number(opts.wallClockBudgetMs) || 45_000);
  const persistRawJson = opts.persistRawJson !== false;

  // Window. Default start = now - sinceDays; both bounds can be overridden with
  // explicit ISO `since`/`until` (used to target a specific gap, e.g. early May,
  // in a single bounded call). CreatedDate is ISO-8601; range comparisons work
  // lexicographically. The optional upper bound keeps a targeted sweep small.
  const sinceISO = opts.since
    ? String(opts.since)
    : new Date(startMs - sinceDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const untilISO = opts.until ? String(opts.until) : null;
  const where = `CreatedDate>='${sinceISO}'` + (untilISO ? ` AND CreatedDate<'${untilISO}'` : '');

  let page = 1;
  let pagesFetched = 0;
  let rowsUpserted = 0;
  let itemsUpserted = 0;
  let more = false;

  try {
    while (page <= maxPages && (Date.now() - startMs) < wallClockBudgetMs) {
      const rows = await cin7Fetch(env, 'SalesOrders', {
        fields: SALES_FIELDS,
        where,
        order: 'CreatedDate ASC',
        page,
        rows: PAGE_SIZE,
      });
      const orders = Array.isArray(rows) ? rows : [];
      pagesFetched++;

      if (orders.length > 0) {
        const built = buildSalesOrderStatements(env, orders, { persistRawJson });
        rowsUpserted += built.rowsUpserted;
        itemsUpserted += built.itemsUpserted;
        const CHUNK = 500;
        for (let i = 0; i < built.stmts.length; i += CHUNK) {
          await env.DB.batch(built.stmts.slice(i, i + CHUNK));
        }
      }

      if (orders.length < PAGE_SIZE) break;   // last page of the window
      if (page >= maxPages) { more = true; break; } // hit the cap; more remains
      page++;
    }
  } catch (e) {
    const durationMs = Date.now() - startMs;
    await logRun(env, {
      source, action: 'cin7-safetynet', pagesFetched, rowsUpserted, itemsUpserted,
      watermarkBefore: sinceISO, watermarkAfter: sinceISO,
      status: 'error', error: String(e?.message || e).slice(0, 500), durationMs,
    });
    throw e;
  }

  const durationMs = Date.now() - startMs;
  await logRun(env, {
    source, action: 'cin7-safetynet', pagesFetched, rowsUpserted, itemsUpserted,
    watermarkBefore: sinceISO, watermarkAfter: sinceISO, status: 'ok', durationMs,
  });

  return {
    ok: true,
    source, action: 'cin7-safetynet',
    sinceISO, untilISO, pagesFetched, rowsUpserted, itemsUpserted,
    more, durationMs,
  };
}
