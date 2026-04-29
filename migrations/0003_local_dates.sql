-- Migration 0003 — local_date columns + retroactive backfill on Woo rows.
--
-- Why: order timestamps from different sources land in our DB in different
-- timezones. Woo's date_created is Eastern-naive (both nopong.ca and
-- nopongdeodorant.com are configured to America/Toronto and America/New_York
-- respectively — same DST rules). Amazon's PurchaseDate is UTC ISO with
-- explicit offset. Bucketing on substr(date_created, 1, 7|10) of an Amazon
-- timestamp gives the UTC date — an order placed at 9pm ET on April 28
-- ends up filed under April 29 (UTC) instead of April 28 (Eastern), which
-- doesn't match what we see in Seller Central or wp-admin.
--
-- Fix: every order/items table gets a `local_date TEXT` column (YYYY-MM-DD
-- in Eastern), populated at insert time. All read queries bucket on this
-- column. Per-source ingest code uses the appropriate conversion:
--   Woo:     local_date = substr(date_created, 1, 10)
--            (already Eastern-naive — substring extracts it directly).
--   Amazon:  local_date = toBusinessLocalDate(PurchaseDate)
--            (real timezone arithmetic, see src/timezone.js).
--
-- Existing 22k Woo CA + 1.9k Woo US rows are backfilled inline by the UPDATE
-- statements below — safe and idempotent thanks to the WHERE local_date IS
-- NULL guard. Amazon tables (from 0002) start empty so no UPDATE needed —
-- ingestion populates local_date from day one.

ALTER TABLE orders        ADD COLUMN local_date TEXT;
ALTER TABLE order_items   ADD COLUMN local_date TEXT;
ALTER TABLE amazon_orders ADD COLUMN local_date TEXT;
ALTER TABLE amazon_items  ADD COLUMN local_date TEXT;

UPDATE orders
   SET local_date = substr(date_created, 1, 10)
 WHERE local_date IS NULL;

UPDATE order_items
   SET local_date = substr(date_created, 1, 10)
 WHERE local_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_market_local           ON orders(market, local_date);
CREATE INDEX IF NOT EXISTS idx_order_items_market_local      ON order_items(market, local_date);
CREATE INDEX IF NOT EXISTS idx_order_items_market_sku_local  ON order_items(market, sku, local_date);
CREATE INDEX IF NOT EXISTS idx_amazon_orders_market_local    ON amazon_orders(market, local_date);
CREATE INDEX IF NOT EXISTS idx_amazon_items_market_local     ON amazon_items(market, local_date);
CREATE INDEX IF NOT EXISTS idx_amazon_items_market_sku_local ON amazon_items(market, dashboard_sku, local_date);
