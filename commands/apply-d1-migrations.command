#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Apply any unapplied D1 migrations to the live logistics-db.
#
# Wrangler doesn't auto-apply migrations on `wrangler deploy` — they're a
# separate step. Run this BEFORE deploy-worker.command whenever migrations/
# has a new 000N_*.sql file (e.g. 0007 in v2.2.27f added stage,
# dispatched_date, delivery_date columns to cin7_sales_orders).
#
# `--remote` targets the production D1 (not the local dev one).
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Apply D1 migrations — $(date)"
echo "================================================================"
echo
npx wrangler d1 migrations apply logistics-db --remote
STATUS=$?

echo
echo "================================================================"
if [ "$STATUS" -eq 0 ]; then
  echo "  ✅ Migrations applied."
  echo "  Next step: run deploy-worker.command to ship the code that"
  echo "  uses the new schema."
else
  echo "  ❌ Migration apply failed (exit $STATUS)."
  echo "     Common fix: npx wrangler login (in this same window),"
  echo "     then re-run."
fi
echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
