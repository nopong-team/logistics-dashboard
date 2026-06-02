#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# One-time D1 backfill for v2.2.47 — Amazon AU cutover to CIN7.
#
# Before v2.2.47 attributeCin7Order returned null for any company starting
# with "amazon", so existing Amazon Seller rows in cin7_sales_orders have
# channel_attr = NULL. The new code returns 'amz' for Amazon Seller orders
# (FBA still null), but legacy rows need to be updated to match.
#
# We backfill ALL Amazon Seller rows regardless of date — the cutover guard
# in buildAuSalesPayloadFromD1 (AU_AMAZON_CIN7_CUTOVER_MONTH = '2026-05')
# decides per-month whether to read them. Backfilling pre-cutover rows is
# harmless because the SQL filter excludes 'amz' for pre-cutover months.
#
# Safe to re-run — UPDATE is no-op once channel_attr is already 'amz'.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Backfill Amazon AU channel_attr — $(date)"
echo "================================================================"
echo

echo "  Before — Amazon Seller rows currently NULL channel_attr:"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT COUNT(*) AS rows_pending FROM cin7_sales_orders WHERE market='AU' AND channel_attr IS NULL AND LOWER(TRIM(company)) LIKE 'amazon seller%'"

echo
echo "  Running UPDATE …"
npx wrangler d1 execute logistics-db --remote --command \
  "UPDATE cin7_sales_orders SET channel_attr = 'amz' WHERE market='AU' AND channel_attr IS NULL AND LOWER(TRIM(company)) LIKE 'amazon seller%'"

echo
echo "  After — rows now tagged 'amz':"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT COUNT(*) AS rows_amz FROM cin7_sales_orders WHERE market='AU' AND channel_attr='amz'"

echo
echo "  Per-month breakdown (sanity check):"
npx wrangler d1 execute logistics-db --remote --command \
  "SELECT substr(created_date, 1, 7) AS month, COUNT(*) AS rows FROM cin7_sales_orders WHERE market='AU' AND channel_attr='amz' GROUP BY substr(created_date, 1, 7) ORDER BY month"

echo
echo "================================================================"
echo "  Next steps:"
echo "    1. Bust the AU sales KV cache so the dashboard re-aggregates:"
echo "       npx wrangler kv key list --binding CACHE --remote | grep 'au:sales:'"
echo "       (then delete the v8 keys with `wrangler kv key delete`)"
echo "       — OR just hard-refresh https://logistics.apps.nopong.com and"
echo "       let the 15-min TTL expire naturally. The v7→v8 key bump in"
echo "       v2.2.47 means stale v7 keys are ignored anyway."
echo "    2. Visit the dashboard, switch to May 2026, verify Amazon column"
echo "       matches expectations (~700-800 orders, ~900 tins for partial May)."
echo "================================================================"
echo
echo "  Press Return to close this window."
read -r _
