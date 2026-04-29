#!/usr/bin/env bash
#
# scripts/load-secrets.sh
#
# Bulk-load Wrangler secrets from a local .env file into the
# logistics-dashboard Worker. Whitelist-gated — only keys whose name
# matches a known prefix (or the explicit ADMIN_KEY) are uploaded, so
# you can keep machine-local-only env vars in the same .env without
# accidentally shipping them.
#
# Usage:
#   ./scripts/load-secrets.sh                  # uses ./.env
#   ./scripts/load-secrets.sh path/to/.env     # uses a specific file
#
# Behaviour:
#   - Comments (lines starting with '#') and blank lines are skipped.
#   - Surrounding single or double quotes on the value are stripped.
#   - Keys not matching the whitelist are reported and skipped.
#   - Empty values are reported and skipped.
#   - Each accepted key is set via `npx wrangler secret put KEY` with the
#     value piped on stdin (no shell-history exposure).
#
# Re-running is safe — `wrangler secret put` overwrites existing secrets
# silently. Add new connector prefixes to ALLOWED_PREFIXES below as we
# port more sources.

set -euo pipefail

# Whitelist: keys whose name starts with one of these prefixes are uploaded.
# Extend when adding a new connector.
ALLOWED_PREFIXES=(
  WOO_
  AMAZON_
  XERO_
  SALESBINDER_
  LOGIWA_
  CIN7_
)

# Whitelist: keys whose name is an exact match (no prefix structure).
ALLOWED_EXACT=(
  ADMIN_KEY
)

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found." >&2
  echo "Usage: $0 [path/to/.env]" >&2
  exit 1
fi

# Sanity check: must be run from a repo with wrangler configured.
if [[ ! -f "wrangler.jsonc" && ! -f "wrangler.toml" ]]; then
  echo "Error: no wrangler.jsonc / wrangler.toml in cwd." >&2
  echo "Run from the Worker repo root (cd ~/Documents/GitHub/logistics-dashboard)." >&2
  exit 1
fi

is_allowed() {
  local key="$1"
  local exact prefix
  for exact in "${ALLOWED_EXACT[@]}"; do
    if [[ "$key" == "$exact" ]]; then return 0; fi
  done
  for prefix in "${ALLOWED_PREFIXES[@]}"; do
    if [[ "$key" == "$prefix"* ]]; then return 0; fi
  done
  return 1
}

count_set=0
count_skipped_whitelist=0
count_skipped_empty=0

echo "Loading secrets from $ENV_FILE..."
echo

while IFS= read -r line || [[ -n "$line" ]]; do
  # Strip leading and trailing whitespace.
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"

  # Skip blanks and comments.
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^# ]] && continue

  # Must contain '='.
  [[ "$line" != *=* ]] && continue

  # Split on first '=' only (preserves '=' inside values).
  key="${line%%=*}"
  value="${line#*=}"

  # Strip surrounding single or double quotes.
  if [[ "${#value}" -ge 2 ]]; then
    first="${value:0:1}"
    last="${value: -1}"
    if [[ ( "$first" == '"' && "$last" == '"' ) || ( "$first" == "'" && "$last" == "'" ) ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  if ! is_allowed "$key"; then
    printf "  skip (not in whitelist): %s\n" "$key"
    count_skipped_whitelist=$((count_skipped_whitelist + 1))
    continue
  fi

  if [[ -z "$value" ]]; then
    printf "  skip (empty value):      %s\n" "$key"
    count_skipped_empty=$((count_skipped_empty + 1))
    continue
  fi

  printf "  setting:                 %s\n" "$key"
  # printf '%s' (no trailing newline). Stdout suppressed; stderr passes
  # through so wrangler errors surface immediately.
  printf '%s' "$value" | npx wrangler secret put "$key" >/dev/null
  count_set=$((count_set + 1))
done < "$ENV_FILE"

echo
echo "Done."
echo "  set:                     $count_set"
echo "  skipped (not whitelisted): $count_skipped_whitelist"
echo "  skipped (empty value):   $count_skipped_empty"
echo
echo "Verify with: npx wrangler secret list"
