#!/usr/bin/env bash
# Reclaim Docker disk on the deploy VPS.
#
# This box runs production, staging AND the CI runner on one Docker daemon, so
# every PR leaves build layers behind. Measured on 2026-09-06: 4.0 GB of build
# cache and 4.7 GB of unreferenced images, against 22 GB free — a slow leak that
# ends with a deploy failing to build at the worst possible moment.
#
# Install (see docs/runbooks/admin-control-plane.md § 10):
#   crontab -e   →   17 4 * * *  /home/ubuntu/torn/torn-dashboard/deploy/docker-prune.sh >> /home/ubuntu/torn/docker-prune.log 2>&1
set -euo pipefail

# ⚠️ **NEVER add `--volumes`, and never run `docker volume prune`.**
#
# Every faction's database and the backup archive live in NAMED VOLUMES. Docker
# calls a volume "unused" whenever no container is currently attached — which is
# true of any stack that happens to be stopped, mid-deploy or mid-restore. One
# prune at the wrong moment is every tenant's data, and the backups with it.
#
# ⚠️ **NEVER add `-a` to the image prune.** `docker image prune -a` removes
# every image not attached to a RUNNING container, base images included. Nothing
# breaks, but the next compose build re-pulls and re-builds from scratch: the CI
# job that takes four minutes takes fifteen, on every PR, until the cache warms
# again. The whole point of a permanent runner is that cache.
#
# What is left is genuinely safe: dangling (untagged, superseded) images, exited
# containers, unattached networks, and build cache older than a week.

echo "=== docker prune $(date -u +%FT%TZ) ==="
docker system df

echo "--- exited containers older than a day ---"
docker container prune -f --filter until=24h

echo "--- dangling images ---"
docker image prune -f

echo "--- networks no container is attached to ---"
docker network prune -f --filter until=24h

# The big one, and the safest of the four: build cache is pure derived data.
# A week keeps every layer a recent PR or deploy would reuse.
echo "--- build cache older than a week ---"
docker builder prune -f --filter until=168h

# ⚠️ Abandoned CI stacks, and why this sweep exists at all.
#
# The compose check tears itself down with `down -v --rmi local`, but that step
# does not always get to run: `cancel-in-progress` (added alongside this script)
# kills superseded runs mid-job, and a cancelled job's cleanup has only a grace
# period to finish. Each escapee leaves a whole project behind — containers, a
# network, volumes, and TAGGED images that a dangling-image prune will never
# touch.
#
# ⚠️ The pattern is anchored to `tnl-dashboard-ci-` on purpose. Production is
# `tnl-dashboard` and staging is `tnl-dashboard-dev`; a looser glob would match
# both, and this is the one place in the script that deletes volumes.
echo "--- abandoned CI stacks (tnl-dashboard-ci-*) older than a day ---"
CUTOFF=$(date -u -d '1 day ago' +%s)
docker compose ls --all --format json 2>/dev/null \
  | python3 -c '
import json,sys
try: data = json.load(sys.stdin)
except Exception: data = []
for p in data:
    n = p.get("Name","")
    if n.startswith("tnl-dashboard-ci-"):
        print(n)
' | while read -r project; do
  # Only if nothing in it has been running for a day — a live run must survive.
  running=$(docker ps -q --filter "label=com.docker.compose.project=$project" | wc -l)
  if [ "$running" -eq 0 ]; then
    echo "  removing $project"
    docker compose -p "$project" down -v --rmi local --remove-orphans 2>/dev/null || true
  fi
done

# Images from runs whose project record is already gone.
echo "--- orphaned CI images ---"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
  | awk -F'\t' '$1 ~ /^tnl-dashboard-ci-/ {print $1}' \
  | while read -r img; do
      created=$(docker image inspect "$img" --format '{{.Created}}' 2>/dev/null) || continue
      if [ "$(date -u -d "$created" +%s)" -lt "$CUTOFF" ]; then
        echo "  removing $img"
        docker rmi "$img" >/dev/null 2>&1 || true
      fi
    done

echo "--- after ---"
docker system df
df -h / | tail -1
