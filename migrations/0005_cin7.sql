-- Migration 0005 — CIN7 (AU) sales orders + credit notes tables.
--
-- Created 2026-05-11 as Phase A of the v2.36 AU→D1+cron port. Closes the
-- AU/NA architecture parity gap surfaced by the v2.35.6 KV-key-bump incident
-- (5 concurrent month fetches × ~50 paginated CIN7 calls each = 429 storm).
-- Full design and rationale lives in
-- `Melanie's Context/next-session-brief-v2.36-au-d1-port.md`.
--
-- Phase A is invisible to the dashboard: cron writes CIN7 data into these
-- tables in the background, but read-side endpoints (/api/au/sales,
-- /api/au/pos) continue fetching from CIN7 directly until Phase C/D ship.
-- That means deploying this migration carries near-zero user-facing risk.
--
-- Design notes:
--
-- • Per-source tables, not retrofitted onto `orders`/`order_items`. CIN7's
--   shape (channel attribution via company-name substring, parent/child line
--   items, Alt UOM rules, separate /CreditNotes endpoint, REAL qty for
--   fractional credit-note lines) is dissimilar enough from Woo+Amazon that
--   shared schema would force compromise on all three. Same rationale that
--   put Amazon in its own tables in migration 0002.
--
-- • Watermark on `modified_date` (ISO 8601 from CIN7), not `created_date`.
--   ModifiedDate captures both new orders AND retroactive edits to old
--   orders — important because CIN7 orders can flip status (e.g. DRAFT →
--   APPROVED) days after creation. If ModifiedDate turns out to be missing
--   on some record types in the wild, fall back to a CreatedDate watermark
--   with periodic full re-sync (see brief §8 "Hidden gotchas").
--
-- • Soft-delete VOID. The sync layer writes VOID/CANCELLED orders with the
--   row intact (status='VOID') so the original line items stay auditable.
--   Read queries filter `WHERE status NOT IN ('VOID','VOIDED','CANCELLED')`.
--   Same treatment for DRAFT credit notes (kept in D1, filtered out at read).
--
-- • Precomputed `tins` column on `*_items`. The v2.35.4 Alt UOM rule
--   (`uomSize > 1 ? qty : qty * multiplier`) is encoded at write time so
--   read-side queries are simple `SUM(tins)` without CASE expressions.
--   Credit-note `tins` is already SIGNED (negative if is_au_sku else 0)
--   for the same reason — sum directly.
--
-- • `is_au_sku` flag cached at write time. Mirrors `isAuSkuCode()` in
--   src/cin7.js — `/^(?:WC-|D-)?AU-/i`. Gates per-SKU rollup and tin
--   contribution for credit-note lines (CIN7 puts non-AU placeholder codes
--   like "196" on Woolies reconciliation credit notes — those contribute
--   revenue but not tins).
--
-- • `qty` is REAL, not INTEGER. Credit notes occasionally have fractional
--   line quantities (e.g. -0.1775 on the Woolies "196" reconciliation
--   lines), which would round-trunc in INTEGER and produce a nonsense
--   total.
--
-- • `raw_json` kept for replay/debug, same pattern as `orders.raw_json`.
--   Whether to NULL it out for backfill (Workers Free CPU) vs always
--   persist (auditability) is decided at the sync layer.
--
-- • New rows in `sync_state` use source values `'cin7_sales_orders'` and
--   `'cin7_credit_notes'` (NOT just `'cin7'`) so each endpoint advances its
--   own watermark independently — they progress at different rates.
--
-- • New row in `sync_logs.source` will be either of those two values plus
--   the existing `pages_fetched`/`orders_added`/`items_added`/watermark
--   columns. No schema change needed.

CREATE TABLE cin7_sales_orders (
  id              INTEGER PRIMARY KEY,           -- CIN7 SalesOrder.id
  reference       TEXT,                          -- e.g. "SOR-72796"
  market          TEXT NOT NULL DEFAULT 'AU',    -- room for future regions
  status          TEXT NOT NULL,                 -- APPROVED | VOID | DRAFT | etc.
  channel_attr    TEXT,                          -- 'col' | 'woo2' | 'dist' | 'refund' | NULL (skip)
  company         TEXT,                          -- shipping-address company (used for attribution)
  first_name      TEXT,
  last_name       TEXT,
  member_id       INTEGER,
  member_email    TEXT,
  total           REAL,                          -- order grand total
  sub_total       REAL,
  product_total   REAL,
  created_date    TEXT NOT NULL,                 -- ISO 8601 from CIN7
  modified_date   TEXT NOT NULL,                 -- ISO 8601 — drives watermark
  raw_json        TEXT,                          -- full original payload (replay/debug)
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cin7_so_modified  ON cin7_sales_orders(modified_date);
CREATE INDEX idx_cin7_so_created   ON cin7_sales_orders(market, created_date);
CREATE INDEX idx_cin7_so_status    ON cin7_sales_orders(market, status);
CREATE INDEX idx_cin7_so_attr      ON cin7_sales_orders(market, channel_attr, created_date);

CREATE TABLE cin7_sales_order_items (
  -- AUTOINCREMENT rowid, not CIN7 line.id. We don't know if CIN7's line.id is
  -- unique across orders (the API doesn't document it), so we don't assume.
  -- Items get re-built on every upsert via DELETE-then-INSERT scoped to
  -- order_id, same pattern as Woo's order_items in migration 0001.
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES cin7_sales_orders(id) ON DELETE CASCADE,
  market          TEXT NOT NULL,                 -- denormalized
  parent_id       INTEGER NOT NULL DEFAULT 0,    -- 0 for parent/standalone, >0 for bundle children
  code            TEXT,                          -- raw CIN7 product code (may not be an AU SKU)
  base_sku        TEXT,                          -- normalizeAuSku(code)[0] at write time
  multiplier      INTEGER NOT NULL DEFAULT 1,    -- normalizeAuSku(code)[1] at write time
  uom_size        INTEGER NOT NULL DEFAULT 1,    -- raw CIN7 uomSize (Alt UOM marker)
  qty             REAL NOT NULL,                 -- raw CIN7 qty (can be fractional on credit notes)
  unit_price      REAL,
  total           REAL,                          -- raw CIN7 line total
  name            TEXT,
  is_au_sku       INTEGER NOT NULL DEFAULT 0,    -- isAuSkuCode(code) at write time
  tins            REAL NOT NULL DEFAULT 0,       -- PRECOMPUTED: uomSize>1 ? qty : qty*mult (positive)
  created_date    TEXT NOT NULL                  -- denormalized from order
);
CREATE INDEX idx_cin7_soi_order      ON cin7_sales_order_items(order_id);
CREATE INDEX idx_cin7_soi_sku_date   ON cin7_sales_order_items(market, base_sku, created_date);
CREATE INDEX idx_cin7_soi_parent     ON cin7_sales_order_items(order_id, parent_id);

CREATE TABLE cin7_credit_notes (
  id              INTEGER PRIMARY KEY,           -- CIN7 CreditNote.id
  reference       TEXT,                          -- e.g. "CRN-72795"
  market          TEXT NOT NULL DEFAULT 'AU',
  status          TEXT NOT NULL,                 -- APPROVED | DRAFT | VOID | etc.
  company         TEXT,
  first_name      TEXT,
  last_name       TEXT,
  member_id       INTEGER,
  member_email    TEXT,
  total           REAL,
  sub_total       REAL,
  product_total   REAL,
  created_date    TEXT NOT NULL,
  modified_date   TEXT NOT NULL,
  raw_json        TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_cin7_cn_modified ON cin7_credit_notes(modified_date);
CREATE INDEX idx_cin7_cn_created  ON cin7_credit_notes(market, created_date);
CREATE INDEX idx_cin7_cn_status   ON cin7_credit_notes(market, status);

CREATE TABLE cin7_credit_note_items (
  -- AUTOINCREMENT rowid; rebuilt via DELETE-then-INSERT per credit_note_id.
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  credit_note_id  INTEGER NOT NULL REFERENCES cin7_credit_notes(id) ON DELETE CASCADE,
  market          TEXT NOT NULL,
  parent_id       INTEGER NOT NULL DEFAULT 0,
  code            TEXT,
  base_sku        TEXT,
  multiplier      INTEGER NOT NULL DEFAULT 1,
  uom_size        INTEGER NOT NULL DEFAULT 1,
  qty             REAL NOT NULL,
  unit_price      REAL,
  total           REAL,                          -- raw CIN7 line total
  name            TEXT,
  is_au_sku       INTEGER NOT NULL DEFAULT 0,
  -- PRECOMPUTED, SIGNED. Negative if is_au_sku else 0 — matches the v2.35.6
  -- refund-aggregation rule that empty-code "Amount" lines + non-AU
  -- placeholder codes contribute revenue but NOT tins.
  tins            REAL NOT NULL DEFAULT 0,
  -- PRECOMPUTED, SIGNED. -ABS(total) always. Matches v2.35.6's `-Math.abs(lineTotal)`
  -- rule — robust against CIN7 returning credit-note totals as either
  -- positive or already-negated.
  revenue_signed  REAL NOT NULL DEFAULT 0,
  created_date    TEXT NOT NULL
);
CREATE INDEX idx_cin7_cni_credit_note ON cin7_credit_note_items(credit_note_id);
CREATE INDEX idx_cin7_cni_sku_date    ON cin7_credit_note_items(market, base_sku, created_date);
