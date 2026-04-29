-- Migration 0004 — Xero OAuth token storage.
--
-- Single-row table (CHECK id = 1) for the connected Xero org's tokens. We're
-- single-tenant by design — No Pong has one Xero org, and the legacy server.js
-- always read xero.tenants[0]. If multi-org support is ever needed, drop the
-- CHECK constraint and the read paths can pick by tenant_id.
--
-- expires_at is unix seconds (consistent with the Amazon LWA cache shape) so
-- comparisons against `Math.floor(Date.now()/1000)` work without conversion.
--
-- updated_at is informational — useful for the dashboard's connected-since
-- chip and for debugging stale-token scenarios. Refresh writes always bump it.

CREATE TABLE IF NOT EXISTS xero_tokens (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,           -- unix seconds
  tenant_id     TEXT,
  tenant_name   TEXT,
  scope         TEXT,
  updated_at    TEXT DEFAULT (datetime('now')),
  CHECK (id = 1)
);
