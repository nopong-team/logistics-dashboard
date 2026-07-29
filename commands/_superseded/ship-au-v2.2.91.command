#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Ship AU Logistics v2.2.91 — commit, push, and deploy in one go.
#   v2.2.91 — carton stock check counts assembled cartons (fix 1/48 → 48/48)
# Runs on your Mac (which has the network + GitHub + Cloudflare logins the
# cloud session doesn't). Just double-click it from Finder.
# ─────────────────────────────────────────────────────────────────────────────
set -u
REPO="$HOME/Documents/logistics-dashboard"
cd "$REPO" || { echo "❌ $REPO not found"; read -r _; exit 1; }

echo "================================================================"
echo "  Ship AU v2.2.91 — $(date)"
echo "================================================================"

echo
echo "▶ Staging changed files…"
git add -- src/logistics.js public/index.html package.json

if git diff --cached --quiet; then
  echo "  Nothing new to commit — continuing to push + deploy."
else
  echo "▶ Committing…"
  git commit -m "AU Logistics: count assembled cartons in stock check (fix 1/48 -> 48/48)" \
    -m "CIN7 stocks a carton SKU as its own product counted in cartons, but analyseLineItem() read that count as loose tins and divided by the carton size again (73 -> floor(73/48) = 1). Now reads carton-SKU stock as cartons and adds loose base-tin stock / carton size for assemblable cartons. AU v2.2.91; package.json 0.21.0 -> 0.21.1." \
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
