#!/usr/bin/env bash
# Local equivalent of .github/workflows/scrape-faction-attacks.yml
# Runs faction_attacks_update.py then sync_to_supabase.py attacks.
# No git commit/push step — that's only needed for GitHub Pages hosting.
#
# Usage:
#   ./scripts/run_faction_attacks_local.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Load .env if present
if [[ -f ".env" ]]; then
  # Export all non-comment lines
  set -a
  # shellcheck disable=SC1091
  source <(grep -v '^\s*#' .env | grep '=')
  set +a
fi

# The scripts expect TORN_API_KEY, but .env uses VITE_TORN_API_KEY.
# Fall back to the VITE_ prefix if the plain key is not set.
if [[ -z "${TORN_API_KEY:-}" && -n "${VITE_TORN_API_KEY:-}" ]]; then
  export TORN_API_KEY="$VITE_TORN_API_KEY"
fi

# Pass through Supabase vars (sync_to_supabase.py needs these)
export VITE_SUPABASE_URL="${VITE_SUPABASE_URL:-}"
export VITE_SUPABASE_ANON_KEY="${VITE_SUPABASE_ANON_KEY:-}"
export VITE_SUPABASE_SERVICE_ROLE_KEY="${VITE_SUPABASE_SERVICE_ROLE_KEY:-}"
export VITE_FACTION_ID="${VITE_FACTION_ID:-10739}"

echo "=== Step 1: Fetch faction attacks from Torn API ==="
python scripts/faction_attacks_update.py

echo ""
echo "=== Step 2: Sync faction attacks to Supabase ==="
python scripts/sync_to_supabase.py attacks

echo ""
echo "Done. faction_attacks_database.json updated and synced to Supabase."
