#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Aggressive watermark jump — push CIN7 SalesOrders watermark straight to
# 2026-06-01T00:00:00Z, skipping the stuck May 23 cluster entirely.
#
# Context (2026-06-02): the cin7_sales_orders cron stalled on a same-timestamp
# bulk-modification cluster at 2026-05-23T14:00:0XZ. The earlier surgical
# unstick (commands/unstick-cin7-sales-watermark.command) only advanced the
# watermark by 4 seconds in 4 hours — the cluster spans many seconds at ~1000
# records each. At that crawl rate the cron would never catch up to today.
#
# Strategy: skip the whole window. Pair this with v2.2.49 which moves the
# AU Amazon source cutover from May → June, so May still reads from the
# (accurate, CSV-imported) amazon_orders table. We're not losing data —
# we're just declining to re-sync orders we already have a source for.
#
# Safe to run if a future stall hits at a different timestamp — adjust the
# NEW_WATERMARK date string below.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "Error: $REPO not found"; read -r _; exit 1; }

NEW_WATERMARK='2026-06-01T00:00:00Z'

echo "================================================================"
echo "  Jump CIN7 sales watermark to June 1 — $(date)"
echo "================================================================"
echo
echo "  Current state (before):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT source, watermark, last_synced_at FROM sync_state WHERE source = 'cin7_sales_orders'"

echo
echo "  Pushing watermark to $NEW_WATERMARK ..."
npx wrangler d1 execute logistics-db --remote --command \
  "UPDATE sync_state SET watermark = '$NEW_WATERMARK', watermark_id = 0 WHERE source = 'cin7_sales_orders'"
STATUS=$?

echo
echo "  After:"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT source, watermark, last_synced_at FROM sync_state WHERE source = 'cin7_sales_orders'"

echo
echo "================================================================"
if [ "$STATUS" -eq 0 ]; then
  echo "  Watermark jumped to 1 June 2026."
  echo
  echo "  What happens next:"
  echo "    - Next cron tick (within 15 min) fetches all orders modified"
  echo "      from 2026-06-01T00:00:00Z onwards."
  echo "    - June has ~40 Amazon Seller orders + small amounts of other"
  echo "      channels — easily fits in a single cron tick (250 rows)."
  echo "    - After 1 tick (~15 min) June rows should be in D1."
  echo
  echo "  Verify in ~20 min by running:"
  echo "    commands/check-cin7-au-june-diagnostic.command"
  echo
  echo "  Success criteria:"
  echo "    Query 1 watermark advanced past 2026-06-02 (today)."
  echo "    Query 3 (June rows) shows ~40 'amz' rows + a few NULLs."
else
  echo "  Watermark update failed (exit $STATUS)."
fi
echo
echo "  Press Return to close this window."
read -r _
