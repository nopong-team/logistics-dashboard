#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Peek at the distribution of `stage` values + populated new-column counts
# in cin7_sales_orders. Used to verify the v2.2.27f backfill is reaching
# current orders AND that the filter ('Processing') matches a real stage
# value CIN7 actually uses.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Check CIN7 stage distribution — $(date)"
echo "================================================================"
echo
echo "  Stage distribution across AU sales orders (APPROVED only):"
echo
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT COALESCE(stage, '(NULL)') AS stage, COUNT(*) AS rows FROM cin7_sales_orders WHERE market='AU' AND status='APPROVED' GROUP BY stage ORDER BY rows DESC"

echo
echo "  Most recent 5 orders in D1 (showing new columns):"
echo
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT id, reference, status, stage, created_date, delivery_date, dispatched_date FROM cin7_sales_orders WHERE market='AU' ORDER BY created_date DESC LIMIT 5"

echo
echo "  Watermark state (sync_state):"
echo
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT source, watermark, watermark_id FROM sync_state WHERE source LIKE 'cin7%'"

echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
