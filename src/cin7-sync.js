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
 * D1 on the next tick. The brief flags a hidden gotcha (§8): CIN7 may not
 * populate ModifiedDate on every record type. Mitigation: we fall back to
 * createdDate per-record when modifiedDate is missing, and we run the
 * WHERE-clause filter against `ModifiedDate>=watermark`. If a deployment
 * later finds ModifiedDate truly absent for credit notes, swap the filter
 * to CreatedDate and arrange a periodic full re-sync.
 *
 * Boundary handling. We use `ModifiedDate >= watermark` (not strict `>`), so
 * the last row of the previous chunk gets re-fetched. The upsert is
 * idempotent (INSERT OR REPLACE), so duplicate fetches are harmless. Strict
 * `>` would miss any record whose modified_date exactly equals the
 * watermark, which can happen at the boundary of large batches.
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

// Read the current composite watermark `(modified_date, id)`, creating the
// sync_state row if absent. v2.2.8 adds the `watermark_id` tiebreaker; pre-
// existing rows from v2.2.7 default to watermark_id=0 via the column DEFAULT,
// so the first call after migration 0006 reads (stuck_timestamp, 0) and the
// composite WHERE clause unsticks the cluster on the next fetch.
async function readWatermark(env, source) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_state (source, market, watermark) VALUES (?, 'AU', ?)`,
  ).bind(source, EPOCH_WATERMARK).run();
  const row = await env.DB.prepare(
    `SELECT watermark, watermark_id FROM sync_state WHERE source = ? AND market = 'AU'`,
  ).bind(source).first();
  return {
    watermark: row?.watermark || EPOCH_WATERMARK,
    watermarkId: Number(row?.watermark_id ?? 0) || 0,
  };
}

// Build the CIN7 WHERE clause for the composite cursor.
//   • First run (watermarkId === 0): simple `ModifiedDate>='w'`. Avoids the
//     OR/parentheses path entirely on a known-empty state, sidestepping any
//     edge case where CIN7's where parser is fussy about parenthesised OR.
//   • Subsequent runs: `(ModifiedDate>'w') OR (ModifiedDate='w' AND Id>w_id)`.
//     "Records past this timestamp OR records at this same timestamp with a
//     higher Id" — monotonic progress through ties.
// Field-name casing: ModifiedDate matches existing where-clause usage (see
// fetchSalesOrdersForMonth in src/cin7.js). `Id` uses the same PascalCase
// convention; if CIN7 rejects it the sync_logs will surface the error and
// we'll iterate.
function buildCompositeWhere(watermark, watermarkId) {
  if (!watermarkId) {
    return `ModifiedDate>='${watermark}'`;
  }
  return `(ModifiedDate>'${watermark}') OR (ModifiedDate='${watermark}' AND Id>${watermarkId})`;
}

// Sort a CIN7 record batch by (modified_date, id) ASC. The LAST element is
// then the composite-cursor advance point. Stable across re-fetches because
// `id` is unique per CIN7 record, so the watermark moves forward
// deterministically even when many records share a modified_date.
function sortByCompositeKey(records) {
  return [...records].sort((a, b) => {
    const ma = pickModifiedDate(a) || '';
    const mb = pickModifiedDate(b) || '';
    if (ma !== mb) return ma < mb ? -1 : 1;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

// ─── Sales orders chunk ────────────────────────────────────────────────────

const SALES_FIELDS = [
  'id', 'reference', 'createdDate', 'modifiedDate', 'dispatchedDate',
  'channel', 'posRegister', 'branchName',
  'memberId', 'memberEmail', 'firstName', 'lastName', 'company',
  'status', 'invoiceStatus',
  'total', 'subTotal', 'productTotal',
  'lineItems',
].join(',');

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

  const { watermark: watermarkBefore, watermarkId: watermarkIdBefore } = await readWatermark(env, source);

  // Composite cursor (v2.2.8): see buildCompositeWhere() comment above.
  // Page=1 always — we walk by watermark, not by page index. CIN7's own
  // ordering is non-deterministic across calls, so we sort in JS by
  // (modified_date, id) before processing.
  const where = buildCompositeWhere(watermarkBefore, watermarkIdBefore);
  let rows;
  try {
    rows = await cin7Fetch(env, 'SalesOrders', {
      fields: SALES_FIELDS,
      where,
      page: 1,
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
  const orders = sortByCompositeKey(Array.isArray(rows) ? rows : []);

  let watermarkAfter = watermarkBefore;
  let watermarkIdAfter = watermarkIdBefore;
  let rowsUpserted = 0;
  let itemsUpserted = 0;

  if (orders.length > 0) {
    const stmts = [];
    for (const o of orders) {
      const modifiedDate = pickModifiedDate(o);
      const createdDate  = pickCreatedDate(o);
      if (!modifiedDate || !createdDate) {
        // Skip rows that don't even carry a usable timestamp — the row would
        // violate NOT NULL on modified_date / created_date and stop the
        // batch. Logged as itemsUpserted=0 below; rare enough that one-off
        // outliers don't justify a side-table.
        continue;
      }
      rowsUpserted++;

      const channelAttr = attributeCin7Order(o);
      const company   = String(o?.company   || '').slice(0, 200) || null;
      const firstName = String(o?.firstName || '').slice(0, 200) || null;
      const lastName  = String(o?.lastName  || '').slice(0, 200) || null;
      const memberId  = Number(o?.memberId ?? 0) || null;
      const memberEmail = String(o?.memberEmail || '').slice(0, 200) || null;
      const status   = String(o?.status || '').slice(0, 40) || 'UNKNOWN';
      const total        = Number(o?.total        ?? 0) || 0;
      const subTotal     = Number(o?.subTotal     ?? 0) || 0;
      const productTotal = Number(o?.productTotal ?? 0) || 0;
      const reference    = String(o?.reference || '').slice(0, 100) || null;
      const rawJson = persistRawJson ? truncateRawJson(o) : null;

      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO cin7_sales_orders
             (id, reference, market, status, channel_attr, company,
              first_name, last_name, member_id, member_email,
              total, sub_total, product_total,
              created_date, modified_date, raw_json,
              synced_at)
           VALUES (?, ?, 'AU', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        ).bind(
          o.id, reference, status, channelAttr, company,
          firstName, lastName, memberId, memberEmail,
          total, subTotal, productTotal,
          createdDate, modifiedDate, rawJson,
        ),
      );

      // Re-build line items: scope DELETE to this order_id, then INSERT.
      // We don't trust CIN7's per-line `id` to be globally unique, so the
      // table uses AUTOINCREMENT rowids and this scoped rebuild is the
      // canonical upsert for items. Same pattern Woo uses in admin.js.
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

    // D1 batches are transactional; chunk if we have a lot of statements.
    const CHUNK = 500;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }

    // Composite-cursor advance: the LAST element of the sorted batch carries
    // the highest (modified_date, id) we just persisted. That tuple becomes
    // the new watermark IFF it's strictly past the previous cursor — a guard
    // against rare cases where CIN7 returns rows we've already passed.
    const last = orders[orders.length - 1];
    const lastMod = pickModifiedDate(last);
    const lastId  = Number(last?.id) || 0;
    if (lastMod && (
        lastMod > watermarkBefore ||
        (lastMod === watermarkBefore && lastId > watermarkIdBefore))) {
      watermarkAfter   = lastMod;
      watermarkIdAfter = lastId;
    }
  }

  // Update sync_state heartbeat — always, even if zero rows came back, so
  // the dashboard can answer "when did we last hear from CIN7" separately
  // from "when did we last persist a new row".
  await env.DB.prepare(
    `UPDATE sync_state
        SET watermark = ?, watermark_id = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE source = ? AND market = 'AU'`,
  ).bind(watermarkAfter, watermarkIdAfter, source).run();

  const durationMs = Date.now() - startMs;
  await logRun(env, {
    source, action, pagesFetched: 1, rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter, status: 'ok', durationMs,
  });

  // `more` hint: true if (a) we got a full page AND (b) the watermark
  // actually advanced. If we got a full page but watermark didn't move,
  // something pathological is happening (CIN7 returning the same records
  // despite the cursor having advanced past them) — flag as NOT more so the
  // backfill loop bails instead of spinning forever.
  const watermarkAdvanced = watermarkAfter > watermarkBefore ||
    (watermarkAfter === watermarkBefore && watermarkIdAfter > watermarkIdBefore);

  return {
    ok: true,
    source, action,
    pagesFetched: 1,
    rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter,
    watermarkIdBefore, watermarkIdAfter,
    more: orders.length >= PAGE_SIZE && watermarkAdvanced,
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

  const { watermark: watermarkBefore, watermarkId: watermarkIdBefore } = await readWatermark(env, source);

  const where = buildCompositeWhere(watermarkBefore, watermarkIdBefore);
  let rows;
  try {
    rows = await cin7Fetch(env, 'CreditNotes', {
      fields: CREDIT_FIELDS,
      where,
      page: 1,
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
  const creditNotes = sortByCompositeKey(Array.isArray(rows) ? rows : []);

  let watermarkAfter = watermarkBefore;
  let watermarkIdAfter = watermarkIdBefore;
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

    // Composite-cursor advance — same logic as sales orders.
    const last = creditNotes[creditNotes.length - 1];
    const lastMod = pickModifiedDate(last);
    const lastId  = Number(last?.id) || 0;
    if (lastMod && (
        lastMod > watermarkBefore ||
        (lastMod === watermarkBefore && lastId > watermarkIdBefore))) {
      watermarkAfter   = lastMod;
      watermarkIdAfter = lastId;
    }
  }

  await env.DB.prepare(
    `UPDATE sync_state
        SET watermark = ?, watermark_id = ?, last_synced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE source = ? AND market = 'AU'`,
  ).bind(watermarkAfter, watermarkIdAfter, source).run();

  const durationMs = Date.now() - startMs;
  await logRun(env, {
    source, action, pagesFetched: 1, rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter, status: 'ok', durationMs,
  });

  const watermarkAdvanced = watermarkAfter > watermarkBefore ||
    (watermarkAfter === watermarkBefore && watermarkIdAfter > watermarkIdBefore);

  return {
    ok: true,
    source, action,
    pagesFetched: 1,
    rowsUpserted, itemsUpserted,
    watermarkBefore, watermarkAfter,
    watermarkIdBefore, watermarkIdAfter,
    more: creditNotes.length >= PAGE_SIZE && watermarkAdvanced,
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
    const result = await chunkFn(env, { action: 'cin7-backfill' });
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
