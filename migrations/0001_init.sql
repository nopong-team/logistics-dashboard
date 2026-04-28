-- Migration 0001 — initial schema for the Logistics Dashboard.
--
-- Created 2026-04-28 as part of Step 5 of the Cloudflare rebuild.
--
-- Design notes:
--
-- • `orders` is normalized but DENORMALIZES `market` and `date_created` onto
--   `order_items`. The redundancy lets per-SKU windowed queries (the dashboard's
--   hot path) hit a single index without joining. Worth the few extra bytes per
--   row at AU's projected ~200k-order scale.
--
-- • `raw_json` on orders keeps the original Woo payload. Useful for replay,
--   debugging, and adding new derived columns later without re-fetching.
--
-- • `sync_state` is keyed (source, market). Watermark stores the latest
--   `date_created` we've successfully fetched and persisted. Backfill and
--   incremental sync use the same code path: fetch orders with `after=<watermark>`
--   ordered ascending, then advance the watermark. First run defaults to a
--   pre-Woo epoch so we get everything.
--
-- • `sync_logs` is append-only. One row per backfill chunk, incremental run,
--   or reconcile call. Lets us see "what happened" historically without
--   stomping on running state.

CREATE TABLE orders (
  id            INTEGER PRIMARY KEY,           -- Woo order id (numeric)
  market        TEXT NOT NULL,                 -- 'CA' | 'US' | 'AU'
  number        TEXT,                          -- Woo's user-visible order number (often == id)
  status        TEXT NOT NULL,                 -- 'completed' | 'processing' | 'refunded' | etc.
  date_created  TEXT NOT NULL,                 -- ISO 8601, from Woo
  total         REAL NOT NULL,                 -- order total INCLUDING tax + shipping
  currency      TEXT NOT NULL,                 -- 'CAD' | 'USD' | 'AUD'
  raw_json      TEXT,                          -- full original Woo payload
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_orders_market_date ON orders(market, date_created);
CREATE INDEX idx_orders_market_status ON orders(market, status);

CREATE TABLE order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  market        TEXT NOT NULL,                 -- denormalized from orders
  sku           TEXT,                          -- can be empty/NULL for some Woo items
  name          TEXT,                          -- product name at time of order
  quantity      INTEGER NOT NULL,
  total         REAL NOT NULL,                 -- line total, EXCLUDES tax/shipping
  date_created  TEXT NOT NULL                  -- denormalized from orders
);

CREATE INDEX idx_order_items_market_sku_date ON order_items(market, sku, date_created);
CREATE INDEX idx_order_items_order_id ON order_items(order_id);

CREATE TABLE sync_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at           TEXT NOT NULL DEFAULT (datetime('now')),
  source           TEXT NOT NULL,              -- 'woo' | 'amazon' | 'xero' | etc.
  market           TEXT NOT NULL,
  action           TEXT NOT NULL,              -- 'backfill' | 'incremental' | 'reconcile'
  pages_fetched    INTEGER,
  orders_added     INTEGER,
  items_added      INTEGER,
  watermark_before TEXT,
  watermark_after  TEXT,
  status           TEXT NOT NULL,              -- 'ok' | 'error' | 'partial'
  error            TEXT,
  duration_ms      INTEGER
);

CREATE INDEX idx_sync_logs_source_market_run ON sync_logs(source, market, run_at);

CREATE TABLE sync_state (
  source         TEXT NOT NULL,
  market         TEXT NOT NULL,
  -- Latest date_created we've successfully persisted. Subsequent fetches use
  -- `after=<watermark>` against Woo to pick up where we left off. Default
  -- to a pre-Woo epoch so the very first run pulls everything.
  watermark      TEXT NOT NULL DEFAULT '1970-01-01T00:00:00',
  last_synced_at TEXT,
  PRIMARY KEY (source, market)
);
