#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Set the ShipStation API credentials on the Logistics Dashboard Worker.
#
# ShipStation v1 — uses HTTP Basic auth with BOTH an API Key and an API
# Secret. Both must be set, otherwise the Worker can't talk to ShipStation
# and the 11th Birthday tab's ShipStation cards will show "not connected".
#
# Created 2026-05-19, revised same day after confirming v1 (not v2).
#
# Where to get the credentials:
#   ShipStation → Account Settings (gear icon) → API Settings
#   Generate / reveal the API Key and API Secret. Copy BOTH values.
#
# What this script does:
#   1. cd into the repo
#   2. Prompt for the API Key (input hidden)
#   3. Prompt for the API Secret (input hidden)
#   4. Pipe each into `npx wrangler secret put …` so the values never live
#      in shell history or scrollback
#   5. Deploy the Worker so both secrets are in effect
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Set ShipStation API credentials — $(date)"
echo "================================================================"
echo
echo "  Repo: $REPO"
echo
echo "  ShipStation v1 uses BOTH an API Key AND an API Secret."
echo "  You'll be prompted for each in turn. Input is hidden — you"
echo "  won't see the characters as you type/paste."
echo
echo "================================================================"
echo

# Prompt 1: API Key.
printf "  ShipStation API Key:    "
read -rs SS_KEY
echo
if [ -z "$SS_KEY" ]; then
  echo "  ❌ No API Key entered — aborting."
  echo
  echo "  Press Return to close this window."
  read -r _
  exit 1
fi

# Prompt 2: API Secret.
printf "  ShipStation API Secret: "
read -rs SS_SECRET
echo
echo
if [ -z "$SS_SECRET" ]; then
  echo "  ❌ No API Secret entered — aborting."
  echo
  echo "  Press Return to close this window."
  read -r _
  exit 1
fi

# Pipe into wrangler so neither value appears as a CLI arg.
echo "  → Setting SHIPSTATION_API_KEY…"
printf '%s' "$SS_KEY" | npx wrangler secret put SHIPSTATION_API_KEY
KEY_STATUS=$?

echo
echo "  → Setting SHIPSTATION_API_SECRET…"
printf '%s' "$SS_SECRET" | npx wrangler secret put SHIPSTATION_API_SECRET
SECRET_STATUS=$?

# Wipe the variables — defence in depth, even though they're already used.
unset SS_KEY SS_SECRET

echo
if [ "$KEY_STATUS" -ne 0 ] || [ "$SECRET_STATUS" -ne 0 ]; then
  echo "  ❌ One or both secret uploads failed."
  echo "     Key upload status:    $KEY_STATUS"
  echo "     Secret upload status: $SECRET_STATUS"
  echo "     Common fix: npx wrangler login (in this same window), then re-run."
  echo
  echo "  Press Return to close this window."
  read -r _
  exit 1
fi

echo "  ✅ Both secrets set."
echo
echo "  → Deploying the Worker so the new secrets are in effect…"
echo
npx wrangler deploy
DEPLOY_STATUS=$?

echo
echo "================================================================"
if [ "$DEPLOY_STATUS" -eq 0 ]; then
  echo "  ✅ ShipStation credentials are live."
  echo
  echo "  Verify: open https://logistics.apps.nopong.com → AU → 11th Birthday"
  echo "  The ShipStation cards should now show real numbers (not '—')."
  echo "  Or hit /api/au/birthday-launch?refresh=1 directly to see the payload."
  echo
  echo "  If you see 401 errors, the Key/Secret pair is wrong — re-run this"
  echo "  script and double-check Account → API Settings in ShipStation."
else
  echo "  ⚠️  Secrets were set, but deploy failed (exit $DEPLOY_STATUS)."
  echo "     Re-run commands/deploy-worker.command to retry."
fi
echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
