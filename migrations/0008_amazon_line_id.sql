-- 0008_amazon_line_id.sql
-- Bulletproof Amazon SKU dedup — give amazon_items a stable per-line identity so
-- re-ingesting an active report range can NEVER accumulate duplicate rows again.
--
-- Why the old approach leaked (root cause of the recurring "Run cleanup" need):
-- three different date axes were in play and none matched —
--   • the report WINDOW filters on last-updated / shipment date
--   • date_created stores purchase_date (a raw UTC string)
--   • the reads bucket on Eastern local_date
-- so the v2.29 date-window DELETE could never be a perfect inverse of the INSERT:
-- an order purchased Apr 28 but shipped May 3 lands in the "May 1-16" report,
-- is stored with date_created = Apr 28, and the May DELETE (date_created >= May 1)
-- never removes the prior copy. Every daily refresh added one more.
--
-- shipment-item-id is unique per shipped order line — the SAME key the AU CSV
-- importer already dedups on (scripts/import-amazon-au-csv.py). With a UNIQUE
-- index the ingest can upsert, making duplicates structurally impossible under
-- any window/date/timezone condition.

ALTER TABLE amazon_items ADD COLUMN shipment_item_id TEXT;  -- from the report's shipment-item-id / "Shipment Item ID" column

-- Partial UNIQUE index: legacy rows (ingested before this migration) have a NULL
-- shipment_item_id and are excluded from the index, so the migration applies
-- cleanly against existing data. New rows carry the id and are forced unique per
-- market. The WHERE clause is what lets INSERT ... ON CONFLICT target it.
CREATE UNIQUE INDEX IF NOT EXISTS ux_amazon_items_market_shipitem
  ON amazon_items(market, shipment_item_id)
  WHERE shipment_item_id IS NOT NULL;
