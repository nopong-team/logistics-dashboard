#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Push the CIN7 SalesOrders watermark FORWARD past a stuck same-timestamp
# cluster.
#
# Diagnosed 2026-06-02: cin7_sales_orders watermark stuck at
# '2026-05-23T14:00:02Z' (per check-cin7-au-june-diagnostic.command).
# RECURRED 2026-06-29: same stall, this time stuck at '2026-06-06T14:00:02Z'
# — confirmed a 275-row cluster all sharing that exact modified_date (page
# size is 250, so the page can never clear the cluster). NEW_WATERMARK
# below updated to escape it.
# The cron has been re-fetching the same cluster of records at :02Z every
# 15 min because CIN7 Omni's `WHERE ModifiedDate > X` silently treats `>`
# as `>=` — so the watermark never advances past timestamps that are tied
# across multiple records. Durable fix = cluster-aware pagination (v2.50
# Part A); this script is the manual escape hatch.
#
# Recovery: set the watermark to one second past the stuck point. The
# stuck records ARE already in D1 (the cron has been re-fetching them
# and INSERT OR REPLACE-ing every tick) so we don't lose data; we just
# stop the loop. The cron then walks forward through ~10 days of orders
# (~300 records) over the next 1-2 ticks.
#
# Safe to re-run if a different stall hits at a later timestamp — just
# update the date string below.
#
# Companion to reset-cin7-watermark.command (which moves the watermark
# BACKWARDS to force a re-pull). This script does the opposite — moves
# it FORWARDS to escape a stall.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "Error: $REPO not found"; read -r _; exit 1; }

NEW_WATERMARK='2026-06-06T14:00:03Z'   # 1 second past the stuck cluster (2026-06-29 stall)

echo "================================================================"
echo "  Unstick CIN7 sales-orders watermark — $(date)"
echo "================================================================"
echo
echo "  Current state (before):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT source, watermark, last_synced_at FROM sync_state WHERE source = 'cin7_sales_orders'"

echo
echo "  Setting watermark to $NEW_WATERMARK ..."
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
  echo "  Watermark advanced past stuck cluster."
  echo
  echo "  What happens next:"
  echo "    - Next CIN7 cron tick runs within 15 min (cron schedule */15)."
  echo "    - That tick pulls ~250 orders from 2026-05-23T14:00:03Z forward."
  echo "    - Second tick (15 min later) pulls the next ~250."
  echo "    - After 2 ticks (~30 min), all orders through today should be"
  echo "      in D1 with correct channel_attr (new code writes 'amz' for"
  echo "      Amazon Seller orders at sync time)."
  echo
  echo "  Re-run check-cin7-au-june-diagnostic.command in 15 min to verify"
  echo "  the watermark has advanced past 2026-06-01 and June rows appear"
  echo "  in cin7_sales_orders."
else
  echo "  Watermark update failed (exit $STATUS)."
fi
echo
echo "  Press Return to close this window."
read -r _
