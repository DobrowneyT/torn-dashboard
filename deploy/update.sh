#!/usr/bin/env bash
# Deploy the latest code to this server's running stack.
#
#   ./deploy/update.sh                # pull + migrate + rebuild + verify
#   ./deploy/update.sh --if-changed   # cron: quiet unless origin has moved since
#                                     #   the last SUCCESSFUL deploy (not since
#                                     #   the last `git pull` — see MARKER below)
#   SKIP_BACKUP=1 ./deploy/update.sh  # skip the pre-deploy safety dump
#
# To force a redeploy of the current checkout — the recovery path when a run was
# interrupted — drop the flag: `./deploy/update.sh`. Prefer running it detached,
# so a dropped connection cannot kill it half-way and it never shares a terminal
# with the backup step (see the SIGTTIN note further down):
#   setsid nohup ./deploy/update.sh >> deploy.log 2>&1 &
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

# Read KEY from an env file, tolerating a missing file AND a missing key.
#
# ⚠️ `grep … | cut` is the obvious way and is a trap under `set -euo pipefail`:
# a grep that matches nothing exits 1, pipefail propagates it, and `V="$(...)"`
# makes that the status of the assignment — so the script dies mid-line with NO
# message at all, because `-s` suppressed the only output there was.
#
# That is exactly what happened on 2026-08-16: PUBLIC_DOMAIN was not in
# deploy/.env, so the deploy published the userscript and then vanished without
# a word, one line into generating tenants.json. It read as a hang.
#
# deploy/dev-deploy.sh already carried this helper with this warning attached.
# update.sh got away with the raw pipeline only because every key it read
# happened to exist; adding one that did not was enough to detonate it. sed
# always exits 0, so a miss is an empty string and callers apply their default.
env_value() {  # env_value <KEY>
  [ -f deploy/.env ] || return 0
  sed -n "s/^$1=//p" deploy/.env | tail -1
}

# What the RUNNING stack was last built from — NOT what git happens to point at.
#
# ⚠️ Those are different things, and conflating them wedged production for five
# hours on 2026-08-15. The checkout is advanced by the `git merge` below, which
# happens BEFORE the backup, the migrations and the build. Interrupt a deploy
# anywhere in that gap — abandoning a hand-run that appeared to hang is the
# usual way, see the SIGTTIN note at the backup step — and HEAD is
# already equal to origin with none of the work done. A guard comparing HEAD to
# origin then answers "nothing to do" forever: the 5-minute cron exits at this
# line, writes nothing to the log, and the stack silently stops updating. There
# is no error to find, because nothing is running.
#
# The marker is written only after a deploy has fully succeeded, so an
# interrupted run leaves it stale and the next cron tick simply retries.
# Gitignored: it describes this box, not the code.
MARKER="$REPO_DIR/deploy/.last-deployed"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
# Absent marker reads as "never deployed", so the first run after this change
# always deploys once and re-arms the mechanism. That is also what recovers a
# box already stuck in the state described above.
DEPLOYED="$(cat "$MARKER" 2>/dev/null || true)"
if [ "${1:-}" = "--if-changed" ] && [ "$DEPLOYED" = "$REMOTE" ]; then
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
#
# ⚠️ `< /dev/null` is NOT tidiness — without it an interactive run HANGS HERE,
# forever, and this cost two debugging sessions before it was understood.
#
# `timeout` runs its child in a NEW PROCESS GROUP (that is how it kills the
# whole tree). Relative to the controlling terminal that group is a BACKGROUND
# group, and `docker compose run` still opens stdin even with `-T`. A background
# process reading the terminal gets SIGTTIN, and SIGTTIN stops it — permanently,
# because a stopped process cannot act on the SIGTERM the timeout later sends.
# Observed 2026-08-16: pgrp=254751 against tpgid=254564, ShdPnd carrying signal
# 21, state T. The backup itself had already finished in 45 seconds.
#
# It only bites INTERACTIVELY. Under cron there is no controlling terminal, so
# no SIGTTIN and no stop — which is why auto-deploys were fine while every
# hand-run deploy appeared to wedge at the backup, and why this looked for a
# while like a slow Backblaze upload rather than a signal.
#
# Detaching stdin from the terminal removes the read that raises the signal.
# `timeout --foreground` would also work by keeping the child in the foreground
# group, but it costs the ability to kill the whole group on a genuine hang —
# which is the entire reason the timeout is here.
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  echo "==> pre-deploy backup"
  timeout "${BACKUP_TIMEOUT:-15m}" \
    "${COMPOSE[@]}" run --rm -T backup node db/backup.mjs --out /backups \
    < /dev/null \
    || echo "[warn] pre-deploy backup failed or timed out — continuing (local archives are unaffected)"
fi

# Idempotent migrations against every LIVE faction DB. `faction_%_dev` copies
# belong to the staging instance (#292) and are excluded: production's cron must
# never write to a staging database, and deploy/dev-deploy.sh migrates them on
# its own schedule from whatever branch staging is testing.
echo "==> migrations"
POSTGRES_USER="$(env_value POSTGRES_USER)"
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

# The backup sidecar sits behind `profiles: ["backup"]`, so the plain `up`
# above skips it — and skips REBUILDING its image. Changes to db/backup.mjs or
# deploy/backup.Dockerfile would therefore never reach the running sidecar, and
# the pre-deploy `compose run backup` above would keep using the stale image
# too. Silent, and exactly the sort of thing that only shows up when the backup
# is the thing you need. Named explicitly so the stress profile stays opt-in.
echo "==> rebuild + restart (backup sidecar)"
"${COMPOSE[@]}" --profile backup up -d --build backup

docker image prune -f >/dev/null

# ⚠️ Dangling IMAGES are not what fills this disk — the BUILD CACHE is, and
# `image prune` does not touch it. BuildKit keeps its cache in a separate store
# (under /var/lib/containerd, not /var/lib/docker/volumes), and nothing evicts
# it. Every run above builds five tenant APIs, nginx and the backup sidecar, so
# each deploy adds layers and none ever leave.
#
# Measured on 2026-08-16: 35GB of build cache — 61% of a 72GB disk, against
# 1.3GB for every faction database put together. The box was at 80% full and
# the obvious suspects (backups, DB growth) were both innocent. Pruning it back
# reclaimed 33GB in one command.
#
# 4GB rather than zero: `--keep-storage 0` would make the next deploy recompile
# the world. This keeps the most recently used layers, which are the ones the
# next build wants. The budget is shared daemon-wide with the staging stack,
# which prunes to the same figure — two different numbers would have each
# script evicting the other's layers on every tick.
echo "==> prune build cache"
docker builder prune -f --keep-storage 4GB >/dev/null 2>&1 \
  || echo "[warn] build-cache prune failed — check 'docker system df' for growth"

# Verify every tenant through our nginx. server_name is <slug>.*, so
# <slug>.localhost matches regardless of the real domain.
echo "==> readiness"
HTTP_PORT="$(env_value HTTP_PORT)"
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

# Publish the War Room dibs userscript (#487).
#
# It talks to this API and must version with it, so it ships from this repo
# rather than its own — the same arrangement torn-armoury already uses for
# armoury-notes.user.js. Members get updates automatically because the script's
# @updateURL points here and Tampermonkey re-checks it.
#
# ⚠️ Runs AFTER readiness on purpose. The tenant map below is built by ASKING
# each live tenant which faction it serves, so the containers have to be up and
# answering or the map would be written short — and a member whose faction went
# missing from it silently cannot log in.
#
# The public host is a static file server outside Docker with no DB access
# (deploy/host-nginx/files.monchoon.me.conf explains why). Nothing secret is
# published here: the script is client code and the map is derivable by anyone
# from Certificate Transparency plus the unauthenticated /api/bootstrap — see
# #486, which tracks that exposure separately.
PUBLIC_SCRIPTS_DIR="${PUBLIC_SCRIPTS_DIR:-/srv/public-files/scripts}"
USERSCRIPT_SRC="$REPO_DIR/frontend/userscripts/tnl-war-room-dibs.user.js"
if [ "$fail" = 0 ] && [ -d "$PUBLIC_SCRIPTS_DIR" ] && [ -f "$USERSCRIPT_SRC" ]; then
  echo "==> publish userscript"
  USERSCRIPT_DST="$PUBLIC_SCRIPTS_DIR/tnl-war-room-dibs.user.js"

  # ⚠️ Tampermonkey gates auto-update on @version ALONE. Ship changed code under
  # an unchanged version and every existing install keeps running the old file
  # forever — no error, no prompt, and the fix looks like it did not work. This
  # has already happened twice on this script. Publishing is not blocked (the
  # file is still strictly newer), but the run says so loudly.
  script_version() { sed -n 's|^// @version  *||p' "$1" | head -1; }
  if [ -f "$USERSCRIPT_DST" ] \
     && ! cmp -s "$USERSCRIPT_SRC" "$USERSCRIPT_DST" \
     && [ "$(script_version "$USERSCRIPT_SRC")" = "$(script_version "$USERSCRIPT_DST")" ]; then
    echo "!!! userscript changed but @version is still $(script_version "$USERSCRIPT_SRC")" >&2
    echo "!!! installed copies will NOT auto-update — bump @version" >&2
  fi

  install -m 0644 "$USERSCRIPT_SRC" "$USERSCRIPT_DST"

  # Torn faction id → tenant host, for the script's tenant lookup.
  #
  # Generated rather than hand-maintained: a stale entry means a member simply
  # cannot log in, with an error that points at the wrong thing. Each tenant is
  # asked through our own nginx for its own faction id, so adding a faction to
  # the box publishes it here on the next deploy with no one remembering to.
  PUBLIC_DOMAIN="$(env_value PUBLIC_DOMAIN)"
  PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-monchoon.me}"
  tenants_tmp="$(mktemp)"
  printf '{\n' > "$tenants_tmp"
  first=1
  published=0
  for conf in deploy/nginx/factions/*.conf; do
    [ -e "$conf" ] || continue
    slug="$(basename "$conf" .conf)"
    # ⚠️ `|| true` because -f makes curl exit non-zero on an HTTP error and
    # pipefail would then kill the whole deploy. One tenant briefly 500ing must
    # cost that tenant its entry, not everybody their deploy.
    fid="$(curl -fsS -H "Host: ${slug}.localhost" \
      "http://127.0.0.1:${HTTP_PORT:-8088}/api/bootstrap" 2>/dev/null \
      | sed -n 's/.*"torn_faction_id":"\([0-9]*\)".*/\1/p' || true)"
    # A tenant that cannot name its faction is SKIPPED, not guessed. A wrong
    # entry would send someone's API key to another faction's dashboard.
    if [ -z "$fid" ]; then
      echo "  [warn] $slug did not report a faction id — omitted from tenants.json"
      continue
    fi
    published=$((published + 1))
    [ "$first" = 1 ] || printf ',\n' >> "$tenants_tmp"
    printf '  "%s": "%s.%s"' "$fid" "$slug" "$PUBLIC_DOMAIN" >> "$tenants_tmp"
    first=0
  done
  printf '\n}\n' >> "$tenants_tmp"
  install -m 0644 "$tenants_tmp" "$PUBLIC_SCRIPTS_DIR/tenants.json"
  rm -f "$tenants_tmp"
  # ⚠️ Counted as we went rather than grepped back out of the file: `grep -c`
  # returns 1 when it matches nothing, which under pipefail would kill the
  # deploy at the final line precisely when every tenant had failed — the case
  # that most needs the warning to survive and be read.
  echo "  published $published tenant(s) → $PUBLIC_SCRIPTS_DIR/tenants.json"
  [ "$published" -gt 0 ] || echo "  [warn] tenants.json is EMPTY — the userscript cannot resolve any faction"
fi

# Re-arm --if-changed, but only on a clean run.
#
# ⚠️ A readiness failure deliberately leaves the marker stale, so the next cron
# tick retries. That is noisy — a genuinely broken commit will rebuild and log
# FAIL every five minutes until someone pushes a fix — and the noise is the
# point. The alternative is marking a half-working deploy as done and going
# quiet, which is the exact failure this marker exists to kill.
if [ "$fail" = 0 ]; then
  git rev-parse HEAD > "$MARKER"
fi

echo "==> deployed $(git rev-parse --short HEAD) ($(date -u +%FT%TZ))"
exit "$fail"
