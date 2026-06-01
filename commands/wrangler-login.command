#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Re-authenticate Wrangler against the No Pong Cloudflare account.
#
# Symptom that brought you here:
#   Authentication error [code: 10000]
#   ▲ The `account_id` in your Wrangler configuration (779c1f48e5e23cb7897...)
#     does not match any of your authenticated accounts.
#
# This means Wrangler's stored OAuth token is for the wrong CF account (or
# has been revoked). Fix: log out, log back in, and pick the No Pong
# account when the browser asks. Then re-run deploy-worker.command.
# ─────────────────────────────────────────────────────────────────────────────

set -u
REPO="$HOME/Documents/logistics-dashboard"
EXPECTED_ACCOUNT_ID="779c1f48e5e23cb7897fbb5aff600b04"

cd "$REPO" || { echo "❌ Error: $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Wrangler re-login — $(date)"
echo "================================================================"
echo
echo "Step 1/2 — Logging out of the current Wrangler OAuth session…"
npx wrangler logout || true
echo
echo "Step 2/2 — Starting OAuth flow."
echo
echo "  ⚠️  COPY the dash.cloudflare.com URL printed below and paste it into"
echo "      your No Pong Chrome window (NOT Safari). Wrangler will also try"
echo "      to open Safari automatically — close that tab and ignore it."
echo
echo "      The login callback hits http://localhost:8976 so any browser"
echo "      completes the flow correctly."
echo
echo "  When the Cloudflare page asks which account to allow, pick the"
echo "  No Pong team account (account_id starts with 779c1f48)."
echo
echo "────────────────────────────────────────────────────────────────"
echo "  ↓↓↓  COPY THE LONG dash.cloudflare.com URL FROM BELOW  ↓↓↓"
echo "────────────────────────────────────────────────────────────────"
echo

# BROWSER=true makes wrangler treat its auto-open as already-handled so
# Safari doesn't grab focus. The URL still prints to stdout — copy it.
BROWSER=true npx wrangler login
LOGIN_STATUS=$?

echo
echo "================================================================"
if [ "$LOGIN_STATUS" -ne 0 ]; then
  echo "  ❌ Login failed (exit $LOGIN_STATUS)."
  echo "     Try running this command again, or check your browser."
  echo
  echo "  Press Return to close this window."
  echo "================================================================"
  read -r _
  exit "$LOGIN_STATUS"
fi

# Verify the account matches the one in wrangler.toml.
echo "Verifying authenticated account matches wrangler.toml…"
WHOAMI_OUT=$(npx wrangler whoami 2>&1 || true)
echo "$WHOAMI_OUT"
echo
if echo "$WHOAMI_OUT" | grep -q "$EXPECTED_ACCOUNT_ID"; then
  echo "  ✅ Logged in against the No Pong CF account ($EXPECTED_ACCOUNT_ID)."
  echo "  Next: double-click deploy-worker.command to push the v2.2.43 build."
else
  echo "  ⚠️  Logged in, but the No Pong account ($EXPECTED_ACCOUNT_ID)"
  echo "      wasn't in the account list above. You may have picked the"
  echo "      wrong account in the browser — re-run this command and"
  echo "      choose the No Pong account when prompted."
fi
echo
echo "  Press Return to close this window."
echo "================================================================"
read -r _
