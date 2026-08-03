#!/usr/bin/env bash
# On-server resource sampler for the #116 stress run. Samples container
# CPU/RSS and Postgres connection count every INTERVAL seconds for DURATION
# seconds, appending CSV to stdout. Run it on the VPS alongside the swarm:
#
#   ./deploy/stress/collect-stats.sh 180 > stress-stats.csv
#
# Columns: epoch,container,cpu_pct,mem_used,mem_pct,pg_connections
set -euo pipefail

DURATION="${1:-180}"
INTERVAL="${2:-5}"
COMPOSE=(docker compose -f "$(dirname "$0")/../docker-compose.yml")

echo "epoch,container,cpu_pct,mem_used,mem_pct,pg_connections"
END=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END" ]; do
  NOW=$(date +%s)
  PG_CONNS=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -tAc \
    'SELECT count(*) FROM pg_stat_activity' 2>/dev/null || echo 'NA')
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' \
    | while IFS=, read -r name cpu mem mempct; do
        printf '%s,%s,%s,%s,%s,%s\n' "$NOW" "$name" "${cpu%\%}" "${mem%% *}" "${mempct%\%}" "$PG_CONNS"
      done
  sleep "$INTERVAL"
done
