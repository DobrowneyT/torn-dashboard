#!/bin/sh
# Backup sidecar loop (#76): dump all faction DBs now, then once daily at
# BACKUP_HOUR_UTC (default 04:00). Running on start makes a fresh stack
# immediately verifiable; retention prunes the extras. A failed run logs and
# the loop continues — a backup blip must not stop tomorrow's backup.
#
# ⚠️ The START-UP run stands down for any database already archived within
# BACKUP_FRESH_HOURS (#510). Every deploy restarts this sidecar, and update.sh
# has just taken a pre-deploy dump of all six databases minutes earlier — so
# without this the stack pays for two full sets per deploy. Measured: 95
# archives on a deploy day against a correct 6.
#
# The SCHEDULED runs deliberately pass no such flag. That is the actual daily
# backup, and "today already has one" is not a reason to skip it — a deploy
# archive is a snapshot of whenever the deploy happened, not of the day's end
# state. Nor does update.sh pass it: the pre-deploy backup is the rollback
# path and must always be a fresh dump.
set -eu

echo "[backup] sidecar started — retention ${BACKUP_RETENTION_DAYS:-14}d, remote ${RCLONE_REMOTE:-<local only>}, hour ${BACKUP_HOUR_UTC:-4} UTC"

node /app/db/backup.mjs --out /backups \
  --retention-days "${BACKUP_RETENTION_DAYS:-14}" \
  --skip-if-fresh-hours "${BACKUP_FRESH_HOURS:-20}" \
  || echo "[backup] start-up run failed"

while true; do
  secs=$(node -e "const h=+(process.env.BACKUP_HOUR_UTC||4);const n=new Date();const t=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate(),h));if(t<=n)t.setUTCDate(t.getUTCDate()+1);console.log(Math.max(60,Math.ceil((t-n)/1000)))")
  echo "[backup] next run in ${secs}s"
  sleep "$secs"
  node /app/db/backup.mjs --out /backups --retention-days "${BACKUP_RETENTION_DAYS:-14}" || echo "[backup] run failed"
done
