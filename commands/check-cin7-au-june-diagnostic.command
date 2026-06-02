#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Diagnostic for "June Amazon column is empty" after v2.2.48 deploy.
#
# Checks four things:
#   1. CIN7 sync watermarks (sync_state) — is the cron stuck?
#   2. Most recent CIN7 sales orders in D1 — what's the latest created_date?
#   3. June 2026 AU rows in cin7_sales_orders by channel_attr — how many landed?
#   4. June Amazon Seller rows specifically — count by status.
#
# Read-only — no UPDATE/INSERT/DELETE. Safe to run anytime.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  CIN7 AU June Diagnostic — $(date)"
echo "================================================================"
echo
echo "  1. CIN7 sync watermarks (where the cron currently is):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT source, watermark, watermark_id, last_synced_at FROM sync_state WHERE source LIKE 'cin7%' ORDER BY source"

echo
echo "  2. Most recent 5 CIN7 sales orders in D1 (any market):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT id, reference, market, status, channel_attr, substr(company, 1, 40) AS company_short, created_date FROM cin7_sales_orders ORDER BY created_date DESC LIMIT 5"

echo
echo "  3. June 2026 AU rows in cin7_sales_orders by channel_attr:"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT COALESCE(channel_attr, '(NULL)') AS channel_attr, COUNT(*) AS rows FROM cin7_sales_orders WHERE market='AU' AND substr(created_date, 1, 7) = '2026-06' GROUP BY channel_attr ORDER BY rows DESC"

echo
echo "  4. June 2026 AU Amazon Seller rows by status:"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT status, COUNT(*) AS rows FROM cin7_sales_orders WHERE market='AU' AND substr(created_date, 1, 7) = '2026-06' AND LOWER(TRIM(company)) LIKE 'amazon seller%' GROUP BY status"

echo
echo "  5. May 2026 AU rows by channel_attr (sanity vs backfill expectation):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT COALESCE(channel_attr, '(NULL)') AS channel_attr, COUNT(*) AS rows FROM cin7_sales_orders WHERE market='AU' AND substr(created_date, 1, 7) = '2026-05' GROUP BY channel_attr ORDER BY rows DESC"

echo
echo "================================================================"
echo "  How to read this:"
echo "    (1) — watermark is the upstream ModifiedDate the cron has"
echo "          reached. If it's days/weeks behind today, the cron is"
echo "          stuck. last_synced_at = when the cron last ran a tick."
echo "    (2) — if the latest created_date is well before today, new"
echo "          orders aren't reaching D1 even though they're in CIN7."
echo "    (3) — should show ~40 rows for June total (per CIN7 CSV)."
echo "          If 0, no June orders are in D1 yet. If shown but with"
echo "          channel_attr='(NULL)', they're there but not tagged."
echo "    (4) — should show ~40 Amazon Seller orders. Filter by status"
echo "          tells us if VOIDs are inflating the count."
echo "    (5) — should match the backfill output (695 'amz' + col + woo2"
echo "          + dist rows, no NULLs left)."
echo "================================================================"
echo
echo "  Press Return to close this window."
read -r _
