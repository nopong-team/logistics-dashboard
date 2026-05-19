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
echo "  2026-05-19T00:00:00Z (today). The next cron tick (within 15 min)"
echo "  will re-fetch every order modified today and write the new"
echo "  columns (stage, dispatched_date, delivery_date)."
echo
echo "  Why 2026-05-19 (today): v2.2.10's strict-greater-than watermark"
echo "  hits tie groups at every CIN7 bulk-modification timestamp"
echo "  (we hit one at 2026-04-11T14:00:06Z, another at"
echo "  2026-05-16T14:00:03Z). Skipping straight to today avoids them"
echo "  entirely and surfaces ONLY the currently-open Processing orders"
echo "  the warehouse cares about. Anything modified in the past few"
echo "  days that's still open will be re-touched today as part of"
echo "  normal CIN7 activity."
echo
npx wrangler d1 execute logistics-db --remote --command \
  "UPDATE sync_state SET watermark = '2026-05-19T00:00:00Z', watermark_id = 0 WHERE source = 'cin7_sales_orders'"
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
