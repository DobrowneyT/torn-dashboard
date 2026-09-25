#!/usr/bin/env bash
# Deploy a branch to the STAGING instance (#292).
#
#   ./deploy/dev-deploy.sh <branch>     # put a pushed branch on the staging ground
#   ./deploy/dev-deploy.sh              # rebuild whatever is checked out
#   ./deploy/dev-deploy.sh --if-changed # cron: auto-follow `dev`, no-op otherwise
#
# Runs from the DEV WORKTREE (see deploy/DEV.md), never the production checkout.
#
# The checked-out branch IS the mode switch. On `dev` the cron auto-updates the
# instance; on any other branch the cron stands down, so a manually deployed
# feature branch is never clobbered mid-test. There is no pin file to forget —
# `git -C <worktree> symbolic-ref --short HEAD` is the whole state.
#
# Production isolation, in three parts, none of which are incidental:
#   - its own compose project (`tnl-dashboard-dev`), so `up`/`down` here cannot
#     recreate or remove a production container;
#   - its own flock, so this never blocks (or is blocked by) update.sh;
#   - its own databases (`faction_*_dev` only), so migrations here cannot reach
#     a live tenant. deploy/update.sh symmetrically skips `*_dev`.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Distinct from /tmp/tnl-dashboard-update.lock — a staging rebuild and a
# production deploy are allowed to run at the same time; they share nothing but
# the Postgres server and the docker daemon.
exec 9>/tmp/tnl-dashboard-dev-deploy.lock
flock -n 9 || { echo "another dev deploy is already running — skipping"; exit 0; }

MODE="${1:-}"
CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# What this instance was last successfully BUILT from, not what git points at.
# Same reasoning as deploy/update.sh: the checkout is moved (hard reset, below)
# before any of the work, so an interrupted run would otherwise leave the guard
# permanently satisfied and staging would quietly stop following `dev`.
# Distinct filename from production's so a shared or symlinked deploy/ directory
# can never have one instance read the other's marker.
MARKER="$REPO_DIR/deploy/.last-deployed-dev"

if [ "$MODE" = "--if-changed" ]; then
  # The branch guard. Auto-follow is for `dev` only; anything else is a human
  # testing something and must be left exactly as they left it.
  if [ "$CURRENT" != "dev" ]; then
    exit 0
  fi
  git fetch --quiet origin dev
  if [ "$(cat "$MARKER" 2>/dev/null || true)" = "$(git rev-parse origin/dev)" ]; then
    exit 0
  fi
  TARGET="dev"
elif [ -n "$MODE" ]; then
  TARGET="$MODE"
else
  TARGET="$CURRENT"
fi

# Guard against being pointed at the production checkout by mistake: that
# checkout is on `main` and must only ever be moved by deploy/update.sh.
if [ "$CURRENT" = "main" ] && [ "$TARGET" != "main" ]; then
  echo "Refusing to move a checkout that is on main — this looks like the production" >&2
  echo "checkout, not the dev worktree. See deploy/DEV.md for the worktree setup." >&2
  exit 1
fi

echo "==> staging: $CURRENT → $TARGET"
git fetch --quiet origin "$TARGET"
# --hard, not --ff-only: the staging ground is disposable and swapping between
# feature branches must always succeed. Nothing here is anyone's only copy.
git checkout --quiet -B "$TARGET" "origin/$TARGET"
git reset --hard --quiet "origin/$TARGET"

# deploy/.env is gitignored and lives in the production checkout; the worktree
# reaches it by symlink so credential rotation propagates (DEV.md § Setup).
if [ ! -e deploy/.env ]; then
  echo "deploy/.env not found in this worktree — symlink it from the production" >&2
  echo "checkout: ln -s <prod>/deploy/.env $REPO_DIR/deploy/.env" >&2
  exit 1
fi

# Read KEY from an env file, tolerating both a missing file and a missing key.
#
# `grep … | cut` is the obvious way to do this and is a trap here: under
# `set -e` with `pipefail`, a grep that matches nothing (or names a file that
# does not exist) makes the whole pipeline non-zero, and the script dies
# mid-assignment with NO message at all. sed always exits 0, so a miss is an
# empty string and the explicit checks below get to report it properly.
env_value() {  # env_value <file> <KEY>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -1
}

# Which tenant is on the staging ground. Sticky across runs (the cron has no
# argument to pass), so it is set once via the environment and then persisted.
if [ -z "${DEV_SLUG:-}" ]; then
  DEV_SLUG="$(env_value deploy/.env.dev DEV_SLUG)"
fi
if [ -z "${DEV_SLUG:-}" ]; then
  echo "DEV_SLUG is not set and deploy/.env.dev does not carry one." >&2
  echo "Pick the tenant once:  DEV_SLUG=forge ./deploy/dev-deploy.sh $TARGET" >&2
  exit 1
fi

DEV_DB="faction_${DEV_SLUG}_dev"
DB_PASSWORD_VAR="DB_PASSWORD_$(echo "$DEV_SLUG" | tr '[:lower:]' '[:upper:]')"
DB_PASSWORD="$(env_value deploy/.env "$DB_PASSWORD_VAR")"
if [ -z "$DB_PASSWORD" ]; then
  echo "$DB_PASSWORD_VAR missing from deploy/.env — is $DEV_SLUG a provisioned tenant?" >&2
  exit 1
fi

POSTGRES_USER="$(env_value deploy/.env POSTGRES_USER)"
DEV_HTTP_PORT="${DEV_HTTP_PORT:-$(env_value deploy/.env.dev DEV_HTTP_PORT)}"

# ⚠️ Chain Watch's staging config has to SURVIVE A REDEPLOY, and .env.dev is
# rewritten from scratch every run. Passing the token once on the command line
# looked like it worked — and then the --if-changed cron redeployed on the next
# push, regenerated .env.dev without it, and the endpoint went back to 404 with
# nothing to indicate why. The board just quietly stopped updating.
#
# Precedence: the environment, then deploy/.env (durable, operator-owned, the
# right home for a secret), then the previous .env.dev (sticky, the same trick
# DEV_SLUG and DEV_HTTP_PORT already use). Set it once in deploy/.env and no
# deploy ever has to be told again.
DEV_CHAIN_WATCH_TOKEN="${DEV_CHAIN_WATCH_TOKEN:-$(env_value deploy/.env DEV_CHAIN_WATCH_TOKEN)}"
DEV_CHAIN_WATCH_TOKEN="${DEV_CHAIN_WATCH_TOKEN:-$(env_value deploy/.env.dev DEV_CHAIN_WATCH_TOKEN)}"
DEV_CHAIN_NOTIFY_DIR="${DEV_CHAIN_NOTIFY_DIR:-$(env_value deploy/.env DEV_CHAIN_NOTIFY_DIR)}"
DEV_CHAIN_NOTIFY_DIR="${DEV_CHAIN_NOTIFY_DIR:-$(env_value deploy/.env.dev DEV_CHAIN_NOTIFY_DIR)}"
DEV_HTTP_PORT="${DEV_HTTP_PORT:-8090}"

# Host-side CLI deps for db/migrate.mjs (and db/clone-tenant-dev.mjs, which the
# operator runs by hand before the first deploy). A fresh worktree has no
# node_modules of its own, so this has to happen before anything calls node.
if [ ! -d node_modules/dotenv ]; then
  echo "==> installing host CLI deps"
  npm ci --omit=dev --workspace @tnl/db --silent 2>/dev/null || npm ci --omit=dev --workspace @tnl/db
fi

COMPOSE=(docker compose -f deploy/docker-compose.dev.yml --project-directory deploy)

# The staging copy must exist before we point an API at it.
if ! docker compose -f deploy/docker-compose.yml --project-directory deploy \
     exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -tAc \
     "SELECT 1 FROM pg_database WHERE datname = '$DEV_DB'" | grep -q 1; then
  echo "$DEV_DB does not exist — clone it first:" >&2
  echo "  node db/clone-tenant-dev.mjs --tenant $DEV_SLUG" >&2
  exit 1
fi

# Generated, not hand-edited: the credential is derived from deploy/.env so it
# cannot drift, and the live-outbound toggles stay unset unless the operator
# opted in via the environment. Rewritten on every deploy.
cat > deploy/.env.dev <<EOF
# Generated by deploy/dev-deploy.sh — do not edit; your changes will be lost.
# Staging instance config (#292). See deploy/DEV.md.
DEV_SLUG=${DEV_SLUG}
DEV_HTTP_PORT=${DEV_HTTP_PORT}
DEV_DATABASE_URL=postgres://app_${DEV_SLUG}:${DB_PASSWORD}@postgres:5432/${DEV_DB}
# Live outbound — empty means OFF. Opt in per deploy, e.g.
#   DEV_FEEDBACK_GITHUB_REPO=DobrowneyT/scratch ./deploy/dev-deploy.sh dev
DEV_VAPID_PUBLIC_KEY=${DEV_VAPID_PUBLIC_KEY:-}
DEV_VAPID_PRIVATE_KEY=${DEV_VAPID_PRIVATE_KEY:-}
DEV_VAPID_SUBJECT=${DEV_VAPID_SUBJECT:-}
DEV_FEEDBACK_GITHUB_TOKEN=${DEV_FEEDBACK_GITHUB_TOKEN:-}
DEV_FEEDBACK_GITHUB_REPO=${DEV_FEEDBACK_GITHUB_REPO:-}
# Chain Watch bot endpoint (#782) — empty means the route is not registered.
# Set it once in deploy/.env so every deploy, including the cron, keeps it.
DEV_CHAIN_WATCH_TOKEN=${DEV_CHAIN_WATCH_TOKEN:-}
EOF
chmod 600 deploy/.env.dev

# Compose interpolates from the shell environment; env_file only reaches the
# container. Both are needed, hence the export-and-source.
set -a
# shellcheck disable=SC1091
. deploy/.env.dev
set +a

# Refresh the host CLI deps on every deploy — the branch we just checked out may
# carry a different lockfile than the one installed above.
npm ci --omit=dev --workspace @tnl/db --silent 2>/dev/null || npm ci --omit=dev --workspace @tnl/db

# Migrations, staging copies ONLY. The `_dev` filter is the mirror image of the
# exclusion in deploy/update.sh; between them, neither loop can touch the
# other's databases.
echo "==> migrations (staging copies only)"
DBS="$(docker compose -f deploy/docker-compose.yml --project-directory deploy \
  exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -tAc \
  "SELECT datname FROM pg_database WHERE datname LIKE 'faction\_%\_dev' ORDER BY datname")"
for db in $DBS; do
  node db/migrate.mjs --db "$db"
done

echo "==> rebuild + restart (project tnl-dashboard-dev)"
"${COMPOSE[@]}" up -d --build
docker image prune -f >/dev/null

# ⚠️ The BUILD CACHE, not dangling images, is what fills this disk — and
# `image prune` does not touch it. See the longer note in deploy/update.sh: 35GB
# of it had accumulated by 2026-08-16 against 1.3GB for every database on the
# box. Staging builds on the same daemon and into the same cache, so it prunes
# too: relying on update.sh alone would let the cache grow unchecked whenever
# production has nothing to deploy and this cron keeps following `dev`.
#
# Same 4GB budget as production, deliberately. Two different figures would have
# each script evicting the other's layers every time it ran.
echo "==> prune build cache"
docker builder prune -f --keep-storage 4GB >/dev/null 2>&1 \
  || echo "[warn] build-cache prune failed — check 'docker system df' for growth"

echo "==> readiness"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${DEV_HTTP_PORT}/api/health/ready" >/dev/null 2>&1; then
    ok=1; break
  fi
  sleep 2
done
if [ "$ok" = 1 ]; then
  echo "  ok   staging ($DEV_SLUG @ $DEV_DB)"
  # Re-arm --if-changed only on a clean run; a failure leaves the marker stale
  # so the next tick retries rather than declaring a broken instance current.
  git rev-parse HEAD > "$MARKER"
else
  echo "  FAIL staging — check: docker compose -f deploy/docker-compose.dev.yml --project-directory deploy logs api-dev"
fi

echo "==> staging on $TARGET @ $(git rev-parse --short HEAD) ($(date -u +%FT%TZ))"
echo "    tunnel: ssh -L ${DEV_HTTP_PORT}:127.0.0.1:${DEV_HTTP_PORT} <user>@<vps>  →  http://localhost:${DEV_HTTP_PORT}"
[ "$ok" = 1 ]
