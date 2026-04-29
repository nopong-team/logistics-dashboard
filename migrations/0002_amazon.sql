-- Migration 0002 — Amazon SP-API tables (Step 5c.1).
--
-- Per-source design (vs polymorphic) chosen 2026-04-29: Amazon order IDs are
-- strings (e.g. '028-1234567-1234567'), and the legacy code uses two unrelated
-- SP-API flows whose rows don't share keys — Orders API for monthly revenue
-- (no line items), Reports API for per-SKU (no order ID we can join back).
-- Keeping Amazon in its own tables avoids a TEXT-PK migration over 22k
-- validated Woo rows and lets each source keep its own ingestion semantics.
--
-- The existing sync_state table is reused for the Orders-API watermark
-- (source='amazon', market='CA'|'US'). Reports API doesn't use a watermark —
-- its work is range-scheduled into report_jobs.

CREATE TABLE amazon_orders (
  id              TEXT PRIMARY KEY,            -- AmazonOrderId, e.g. '028-1234567-1234567'
  market          TEXT NOT NULL,               -- 'CA' | 'US'
  status          TEXT NOT NULL,               -- 'Shipped' | 'Unshipped' | 'PartiallyShipped' | etc.
  purchase_date   TEXT NOT NULL,               -- ISO 8601 with offset, from PurchaseDate
  total           REAL NOT NULL,               -- OrderTotal.Amount
  currency        TEXT NOT NULL,               -- 'CAD' | 'USD'
  marketplace_id  TEXT NOT NULL,               -- 'A2EUQ1WTGCTBG2' (CA) | 'ATVPDKIKX0DER' (US)
  raw_json        TEXT,                        -- nullable; left NULL on backfill (CPU cost on Workers Free)
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_amazon_orders_market_date    ON amazon_orders(market, purchase_date);
CREATE INDEX idx_amazon_orders_market_status  ON amazon_orders(market, status);

-- Reports API is async over multiple Worker calls. report_jobs tracks each
-- requested report through phases. The cron handler advances any in-flight
-- job by one phase per tick, so the whole flow self-completes over several
-- ticks without exceeding Workers Free CPU on any one invocation.
--
-- Status lifecycle:
--   pending  → POSTed to /reports, waiting for Amazon. Cron polls /reports/{id}.
--   ready    → processingStatus=DONE, document_id captured. Cron downloads + parses.
--   ingested → TSV rows in amazon_items, terminal success.
--   failed   → CANCELLED/FATAL or attempts exceeded, terminal.
--
-- range_label uses ISO date prefix (e.g. '2025-11-1h', '2026-04-2h') rather
-- than relative ('this-month-1h') so 6-month backfill jobs sit alongside
-- rolling-window jobs without semantic collision.
--
-- Defined BEFORE amazon_items so the FK reference resolves.
CREATE TABLE report_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,             -- 'amazon' (room for future Reports-style sources)
  market            TEXT NOT NULL,             -- 'CA' | 'US'
  report_type       TEXT NOT NULL,             -- e.g. 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL'
  range_label       TEXT NOT NULL,             -- e.g. '2026-04-1h', '2026-04-2h'
  data_start_time   TEXT NOT NULL,             -- ISO sent as dataStartTime
  data_end_time     TEXT NOT NULL,             -- ISO sent as dataEndTime
  amazon_report_id  TEXT,                      -- from POST /reports response
  document_id       TEXT,                      -- from GET /reports/{id} when DONE
  status            TEXT NOT NULL,             -- 'pending' | 'ready' | 'ingested' | 'failed'
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_polled_at    TEXT,
  error             TEXT,
  rows_total        INTEGER,                   -- TSV line count (excl. header)
  rows_matched      INTEGER,                   -- post-mapping match count
  rows_unmatched    INTEGER,                   -- silent-drop guard count
  rows_wrong_market INTEGER,                   -- rows filtered as belonging to other market
  filter_signal     TEXT,                      -- 'sales_channel' | 'currency' | 'ship_country' | 'NONE'
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_report_jobs_status_created     ON report_jobs(status, created_at);
CREATE INDEX idx_report_jobs_market_range       ON report_jobs(market, range_label);
CREATE INDEX idx_report_jobs_source_market      ON report_jobs(source, market);

-- Per-SKU rows from Reports API. NOT semantically joined to amazon_orders —
-- Reports come back without an order ID we can reliably match to Orders rows.
-- Treat as parallel datasets: amazon_orders → monthly revenue, amazon_items →
-- SKU breakdown. Mirrors the legacy two-cache shape. report_job_id FK gives
-- us auditable provenance and clean re-ingestion (DELETE on report_jobs
-- cascades the rows away, then re-run the job).
CREATE TABLE amazon_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  market         TEXT NOT NULL,                -- 'CA' | 'US' (post-filter — see report_jobs.filter_signal)
  seller_sku     TEXT,                         -- raw Amazon seller SKU before mapping
  dashboard_sku  TEXT,                         -- canonical via matchAmzItemToSku() — NULL if unmapped
  name           TEXT,
  quantity       INTEGER NOT NULL,
  total          REAL NOT NULL,                -- item_price column from TSV
  date_created   TEXT NOT NULL,                -- purchase_date column from TSV
  report_job_id  INTEGER NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
  ingested_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_amazon_items_market_sku_date ON amazon_items(market, dashboard_sku, date_created);
CREATE INDEX idx_amazon_items_market_date     ON amazon_items(market, date_created);
CREATE INDEX idx_amazon_items_report_job      ON amazon_items(report_job_id);
