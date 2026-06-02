#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Compare Amazon AU numbers between the two D1 sources for March/April/May 2026:
#   1. cin7_sales_orders   — Amazon Seller orders currently filtered out by
#                            channel_attr=NULL, would become the new source.
#   2. amazon_orders       — CSV-imported Amazon Seller Central data, the
#                            current source the dashboard reads from.
#
# Used to size the impact of switching the dashboard's Amazon AU column from
# the CSV-import pipeline to the CIN7 sync pipeline before cutting over.
# Read-only — no writes.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Amazon AU — CIN7 vs amazon_orders comparison — $(date)"
echo "================================================================"
echo

for MONTH in 2026-03 2026-04 2026-05; do
  echo "----------------------------------------------------------------"
  echo "  Month: $MONTH"
  echo "----------------------------------------------------------------"
  echo
  echo "  CIN7 source (cin7_sales_orders WHERE company LIKE 'Amazon Seller%'):"
  npx wrangler d1 execute logistics-db --remote --command \
    "SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.tins), 0) AS tins, ROUND(COALESCE(SUM(i.total), 0), 2) AS revenue FROM cin7_sales_orders o JOIN cin7_sales_order_items i ON i.order_id = o.id WHERE o.market = 'AU' AND o.status NOT IN ('VOID','VOIDED','CANCELLED') AND LOWER(TRIM(o.company)) LIKE 'amazon seller%' AND substr(o.created_date, 1, 7) = '$MONTH' AND i.parent_id = 0"
  echo
  echo "  amazon_orders source (current dashboard source, CSV-imported):"
  npx wrangler d1 execute logistics-db --remote --command \
    "SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.quantity), 0) AS tins, ROUND(COALESCE(SUM(o.total), 0), 2) AS revenue FROM amazon_orders o JOIN amazon_items i ON i.market = o.market AND substr(i.local_date, 1, 7) = substr(o.local_date, 1, 7) WHERE o.market = 'AU' AND substr(o.local_date, 1, 7) = '$MONTH'"
  echo
done

echo "================================================================"
echo "  How to read this:"
echo "    - 'orders' should be roughly the same between the two sources."
echo "    - 'tins' should be very close (small differences from refund"
echo "      handling between CIN7 credit notes vs Amazon CSV)."
echo "    - 'revenue' may differ — Amazon CSV total includes shipping;"
echo "      CIN7 item totals are line-item-only without shipping."
echo "================================================================"
echo
echo "  Press Return to close this window."
read -r _
