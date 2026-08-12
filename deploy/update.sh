#!/usr/bin/env bash
# Deploy the latest code to this server's running stack.
#
#   ./deploy/update.sh                # pull + migrate + rebuild + verify
#   ./deploy/update.sh --if-changed   # exit quietly unless origin moved (cron)
#   SKIP_BACKUP=1 ./deploy/update.sh  # skip the pre-deploy safety dump
#
# Deploys whatever branch this checkout is ON. The production checkout is on
# `main` and STAYS on `main` permanently — that is the deploy model, not a
# transitional state. Moving it would silently publish unreleased work to every
# live tenant. Promotion to production is a `dev` → `main` merge, which this
# cron then picks up.
# Auto-deploy = a cron line running --if-changed every 5 minutes; see
# deploy/LAUNCH.md Phase 6. Chosen over a GitHub-Actions push deploy so no
# CI system holds SSH credentials to a shared box.
#
# The staging instance (#292) is a SEPARATE worktree with its own script
# (deploy/dev-deploy.sh), compose project, lock and databases. Nothing here
# touches it.
#
# Operator state is never touched: deploy/.env, docker-compose.override.yml
# and nginx/factions/*.conf are gitignored, so `git pull` cannot clobber them.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# One deploy at a time — a 5-min cron must never overlap a slow build.
exec 9>/tmp/tnl-dashboard-update.lock
flock -n 9 || { echo "another update is already running — skipping"; exit 0; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "${1:-}" = "--if-changed" ] && [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "==> deploying $BRANCH: $(git rev-parse --short HEAD) → $(git rev-parse --short "origin/$BRANCH")"
# --ff-only: a server checkout must never invent merge commits; if this fails
# someone committed on the server — resolve by hand, don't force.
git merge --ff-only "origin/$BRANCH" --quiet || git pull --ff-only origin "$BRANCH"

# Host-side CLI deps (db/migrate.mjs runs on the host).
npm ci --omit=dev --workspace @tnl/db --silent 2>/dev/null || npm ci --omit=dev --workspace @tnl/db

COMPOSE=(docker compose -f deploy/docker-compose.yml)
[ -f deploy/docker-compose.override.yml ] && COMPOSE+=(-f deploy/docker-compose.override.yml)
COMPOSE+=(--project-directory deploy)

"${COMPOSE[@]}" up -d --wait postgres

# Pre-deploy safety dump of every faction DB (local volume; also B2 once
# RCLONE_REMOTE is wired). A failed dump warns but never blocks the deploy.
# `timeout` is belt-and-braces on top of rclone's own network limits: this step
# runs in the FOREGROUND while holding the flock, so anything that hangs here
# wedges every subsequent auto-deploy — the 5-min cron just logs "another update
# is already running" and skips, and the stack silently stops updating. That is
# exactly what a Backblaze maintenance window did for over an hour.
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  echo "==> pre-deploy backup"
  timeout "${BACKUP_TIMEOUT:-15m}" \
    "${COMPOSE[@]}" run --rm -T backup node db/backup.mjs --out /backups \
    || echo "[warn] pre-deploy backup failed or timed out — continuing (local archives are unaffected)"
fi

# Idempotent migrations against every LIVE faction DB. `faction_%_dev` copies
# belong to the staging instance (#292) and are excluded: production's cron must
# never write to a staging database, and deploy/dev-deploy.sh migrates them on
# its own schedule from whatever branch staging is testing.
echo "==> migrations"
POSTGRES_USER="$(grep -s '^POSTGRES_USER=' deploy/.env | cut -d= -f2-)"
DBS="$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -tAc \
  "SELECT datname FROM pg_database
     WHERE datname LIKE 'faction\_%' AND datname NOT LIKE '%\_dev'
     ORDER BY datname")"
for db in $DBS; do
  node db/migrate.mjs --db "$db"
done

# Rebuild images; compose recreates only the containers whose config or image
# actually changed (the SPA lives in the nginx image, so it rides along).
echo "==> rebuild + restart"
"${COMPOSE[@]}" up -d --build
docker image prune -f >/dev/null

# Verify every tenant through our nginx. server_name is <slug>.*, so
# <slug>.localhost matches regardless of the real domain.
echo "==> readiness"
HTTP_PORT="$(grep -s '^HTTP_PORT=' deploy/.env | cut -d= -f2-)"
fail=0
for conf in deploy/nginx/factions/*.conf; do
  [ -e "$conf" ] || continue
  slug="$(basename "$conf" .conf)"
  # Freshly-rebuilt containers take a few seconds to start listening, so poll
  # rather than a single shot — otherwise a cold start is a false FAIL (which
  # also makes the cron deploy log spurious failures). ~40s worst case per
  # tenant, but breaks as soon as /ready answers 200.
  ok=0
  for _ in $(seq 1 20); do
    if curl -fsS -H "Host: ${slug}.localhost" \
        "http://127.0.0.1:${HTTP_PORT:-8088}/api/health/ready" >/dev/null 2>&1; then
      ok=1; break
    fi
    sleep 2
  done
  if [ "$ok" = 1 ]; then
    echo "  ok   $slug"
  else
    echo "  FAIL $slug — check: docker compose --project-directory deploy logs api-$slug"
    fail=1
  fi
done

echo "==> deployed $(git rev-parse --short HEAD) ($(date -u +%FT%TZ))"
exit "$fail"
