#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Reset the CIN7 SalesOrders sync watermark back to 2026-04-01 so the next
# cron tick (within 15 minutes) re-fetches all recent orders and writes the
# new first-class columns (stage, dispatched_date, delivery_date) added in
# migration 0007.
#
# Why this is needed: the incremental cron only re-fetches orders whose
# modifiedDate is past the watermark. After a schema migration that adds
# new columns to existing rows, those rows stay with NULL on the new
# columns until something re-fetches them. Resetting the watermark forces
# the next cron tick to repopulate the recent window.
#
# Safe to run repeatedly. The cron's composite watermark (modified_date +
# watermark_id) handles re-fetched rows idempotently via INSERT OR REPLACE.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Reset CIN7 sales-orders watermark — $(date)"
echo "================================================================"
echo
echo "  Setting sync_state.watermark for cin7_sales_orders to"
echo "  2026-04-01T00:00:00Z. The next cron tick (within 15 min) will"
echo "  re-fetch every order modified since then and write the new"
echo "  columns (stage, dispatched_date, delivery_date)."
echo
npx wrangler d1 execute logistics-db --remote --command \
  "UPDATE sync_state SET watermark = '2026-04-01T00:00:00Z', watermark_id = 0 WHERE source = 'cin7_sales_orders'"
STATUS=$?

echo
echo "================================================================"
if [ "$STATUS" -eq 0 ]; then
  echo "  ✅ Watermark reset."
  echo "  Wait ≤15 min for the next cron tick, OR force a backfill now"
  echo "  by POSTing to /api/admin/cin7-backfill?source=sales-orders"
  echo "  (Cloudflare Access SSO required)."
else
  echo "  ❌ Watermark reset failed (exit $STATUS)."
fi
echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
