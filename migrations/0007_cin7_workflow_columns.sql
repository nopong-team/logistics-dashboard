-- Migration 0007 — promote workflow + delivery fields to first-class columns
-- on cin7_sales_orders.
--
-- Created 2026-05-19 during the v2.2.27 logistics-tab iteration. v2.2.27c–e
-- exposed two problems with reading these fields out of `raw_json`:
--
--   1. `raw_json` is NULL for many existing rows (backfill-era inserts that
--      didn't persist it). `json_extract(NULL, '$.foo') IS NULL` is always
--      true, which silently broke the `dispatchedDate IS NULL` filter — the
--      logistics endpoint was showing every order as "open" regardless of
--      dispatch state.
--
--   2. The cron's existing SALES_FIELDS whitelist never asked CIN7 for
--      `estimatedDeliveryDate` or `stage`, so those values aren't anywhere
--      in D1 right now (not even in raw_json). The Sales Order edit UI's
--      "Delivery Date (ETD)" is `estimatedDeliveryDate`; the workflow
--      position (Quote / Approved / Processing / Dispatched / etc.) is
--      `stage`.
--
-- Promoting them to columns makes the filter queryable + indexable, and
-- removes the raw_json dependency for the load-bearing open-orders check.
--
-- Compatibility: nullable columns. Existing rows have NULL on insert. A
-- backfill via `runCin7BackfillLoop` on /api/admin re-fetches recent
-- orders and writes the new columns. New cron ticks (after the matching
-- cin7-sync.js update) populate them on every upsert.

ALTER TABLE cin7_sales_orders ADD COLUMN stage TEXT;
ALTER TABLE cin7_sales_orders ADD COLUMN dispatched_date TEXT;
ALTER TABLE cin7_sales_orders ADD COLUMN delivery_date TEXT;

-- Composite index for the logistics endpoint's hot path: "AU orders where
-- stage = Processing and dispatched_date IS NULL, sorted by delivery_date".
CREATE INDEX idx_cin7_so_stage_dispatch ON cin7_sales_orders(market, stage, dispatched_date);
CREATE INDEX idx_cin7_so_delivery       ON cin7_sales_orders(market, delivery_date);
