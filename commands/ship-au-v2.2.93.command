#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Ship AU Logistics v2.2.93 — commit, push, and deploy in one go.
#   v2.2.93 — stock check reads on-hand (packed cartons allocated to the order
#             count), not available. Double-click from Finder.
# ─────────────────────────────────────────────────────────────────────────────
set -u
REPO="$HOME/Documents/logistics-dashboard"
cd "$REPO" || { echo "❌ $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Ship AU v2.2.93 — $(date)"
echo "================================================================"

echo
echo "▶ Staging changed files…"
git add -- src/logistics.js public/index.html package.json

if git diff --cached --quiet; then
  echo "  Nothing new to commit — continuing to push + deploy."
else
  echo "▶ Committing…"
  git commit -m "AU Logistics: stock check reads on-hand, not available (v2.2.93)" \
    -m "CIN7 allocates packed cartons to the very orders shown on the tab, which drops each SKU's 'available' to zero even though the cartons are physically packed and ready for the order. The carton/tin stock check now uses stock on hand instead of available, so allocated packed cartons still count. Amazon FBA stock stays excluded (soh - fba_soh); on-hand is reduced at dispatch, so a despatched order's stock is never double-counted. AU v2.2.93; package.json 0.21.2 -> 0.21.3." \
    -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" \
    -m "Claude-Session: https://claude.ai/code/session_01CMVQJbRQbJv5eSUiaYaiMo"
fi

echo
echo "▶ Pushing to origin/main…"
git push origin main
PUSH_STATUS=$?

echo
echo "▶ Deploying to Cloudflare (Cloudflare doesn't auto-deploy from GitHub)…"
npx wrangler deploy
DEPLOY_STATUS=$?

echo
echo "================================================================"
if [ "$PUSH_STATUS" -eq 0 ]; then echo "  ✅ Pushed to GitHub."; else echo "  ⚠ Push failed (exit $PUSH_STATUS) — see messages above."; fi
if [ "$DEPLOY_STATUS" -eq 0 ]; then
  echo "  ✅ Deployed. Hard-refresh https://logistics.apps.nopong.com (Cmd+Shift+R)."
else
  echo "  ❌ Deploy failed (exit $DEPLOY_STATUS)."
  echo "     If it mentions auth: run 'npx wrangler login' in THIS window, then re-run."
fi
echo "  Press Return to close this window."
echo "================================================================"
read -r _
