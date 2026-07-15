#!/usr/bin/env bash
# Refresh the LOCAL dev stack with a live faction database from the server.
#
#   ./deploy/pull-live-db.sh [slug] [--pull-only]
#
# Streams a pg_dump straight over SSH (no temp files on the server), then
# restores it into the local compose stack's faction_<slug> and re-applies the
# scoped grants. member_secrets data is ALWAYS excluded: those are members'
# Torn keys encrypted with the SERVER's KEY_ENCRYPTION_KEY — undecryptable
# here, and live key material has no business on a dev machine.
#
#   DEPLOY_SERVER      ssh target        (default monchoon@5.161.91.183)
#   DEPLOY_REMOTE_DIR  repo path there   (default ~/torn/torn-forge-oc-system)
set -euo pipefail

SLUG="${1:-forge}"
MODE="${2:-}"
SERVER="${DEPLOY_SERVER:-monchoon@5.161.91.183}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-torn/torn-forge-oc-system}"

[[ "$SLUG" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "bad slug: $SLUG"; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR/deploy"
mkdir -p backups

ARCHIVE="live-${SLUG}-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
echo "==> dumping faction_${SLUG} on ${SERVER} (member_secrets excluded)…"
# The dump runs inside the server's backup sidecar (version-matched pg_dump,
# PGPASSWORD already in its env) and streams gzip over the SSH pipe.
ssh "$SERVER" "cd ${REMOTE_DIR} && docker compose -f deploy/docker-compose.yml --project-directory deploy \
  run --rm -T backup sh -c 'pg_dump --host postgres --username postgres --no-owner --no-privileges \
    --exclude-table-data=public.member_secrets faction_${SLUG} | gzip'" > "backups/${ARCHIVE}"

[ -s "backups/${ARCHIVE}" ] || { echo "dump is empty — check the server output above"; exit 1; }
echo "    $(du -h "backups/${ARCHIVE}" | cut -f1) → deploy/backups/${ARCHIVE}"

if [ "$MODE" = "--pull-only" ]; then
  echo "Pulled only. Restore later with:"
  echo "  docker compose run --rm -v \"\$(pwd)/backups:/seed\" backup \\"
  echo "    node db/restore.mjs --create --db faction_${SLUG} --role app_${SLUG} --archive /seed/${ARCHIVE}"
  exit 0
fi

echo "==> restoring into the local faction_${SLUG} (api-${SLUG} stops for the drop)…"
docker compose stop "api-${SLUG}" >/dev/null 2>&1 || true
docker compose run --rm -T -v "$(pwd)/backups:/seed" backup \
  node db/restore.mjs --create --db "faction_${SLUG}" --role "app_${SLUG}" --archive "/seed/${ARCHIVE}"
docker compose up -d "api-${SLUG}" >/dev/null 2>&1 || true

echo "==> done — local faction_${SLUG} now mirrors the server (minus member keys)."
