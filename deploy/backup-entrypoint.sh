#!/bin/sh
# Backup sidecar loop (#76): dump all faction DBs now, then once daily at
# BACKUP_HOUR_UTC (default 04:00). Running on start makes a fresh stack
# immediately verifiable; retention prunes the extras. A failed run logs and
# the loop continues — a backup blip must not stop tomorrow's backup.
set -eu

echo "[backup] sidecar started — retention ${BACKUP_RETENTION_DAYS:-14}d, remote ${RCLONE_REMOTE:-<local only>}, hour ${BACKUP_HOUR_UTC:-4} UTC"

while true; do
  node /app/db/backup.mjs --out /backups --retention-days "${BACKUP_RETENTION_DAYS:-14}" || echo "[backup] run failed"
  secs=$(node -e "const h=+(process.env.BACKUP_HOUR_UTC||4);const n=new Date();const t=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate(),h));if(t<=n)t.setUTCDate(t.getUTCDate()+1);console.log(Math.max(60,Math.ceil((t-n)/1000)))")
  echo "[backup] next run in ${secs}s"
  sleep "$secs"
done
