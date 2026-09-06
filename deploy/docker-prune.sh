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

echo "--- after ---"
docker system df
df -h / | tail -1
