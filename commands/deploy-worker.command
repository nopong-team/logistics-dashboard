#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy the Logistics Dashboard Worker to Cloudflare.
#
# Same script as the original in the Drive folder — mirrored here so
# everything for this repo lives next to the code. After git push, run this
# (or double-click it from Finder) — Cloudflare doesn't auto-deploy from
# GitHub for this repo.
#
# Cloudflare publishes in ~30 seconds. Frontend changes are visible on a
# hard refresh; backend changes are live on the next request.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Deploy Worker — $(date)"
echo "================================================================"
echo
npx wrangler deploy
DEPLOY_STATUS=$?

echo
echo "================================================================"
if [ "$DEPLOY_STATUS" -eq 0 ]; then
  echo "  ✅ Deploy succeeded."
  echo "  Hard-refresh https://logistics.apps.nopong.com to see the new UI."
else
  echo "  ❌ Deploy failed (exit $DEPLOY_STATUS)."
  echo "     Common fix: npx wrangler login (in this same window), then re-run."
fi
echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
