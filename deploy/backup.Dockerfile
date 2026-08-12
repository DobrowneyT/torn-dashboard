# Backup sidecar (#76): a postgres:17 base (version-matched pg_dump/psql) with
# node + rclone to run db/backup.mjs on a nightly loop and drive the restore
# drill. Build context is the repo root (npm workspaces).
FROM postgres:17-alpine

RUN apk add --no-cache nodejs npm rclone

# rclone is driven entirely by RCLONE_* env vars (deploy/.env), so it has no
# config file — and it emitted `NOTICE: Config file ... not found - using
# defaults` on every single call. Harmless, but it looks like a misconfiguration
# in the backup logs, and during a B2 outage it sent us chasing the wrong cause.
# An empty file at the default path silences it without changing behaviour; an
# operator-supplied RCLONE_CONFIG still takes precedence.
RUN mkdir -p /root/.config/rclone && touch /root/.config/rclone/rclone.conf

WORKDIR /app
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY server/package.json server/
COPY frontend/package.json frontend/
# Only pg + dotenv are needed at runtime; --omit=dev skips embedded-postgres.
RUN npm ci --workspace @tnl/db --omit=dev

COPY db/ db/
COPY deploy/backup-entrypoint.sh /usr/local/bin/backup-loop
RUN chmod +x /usr/local/bin/backup-loop

# Override the postgres image's server entrypoint — this container runs backups.
ENTRYPOINT []
CMD ["/usr/local/bin/backup-loop"]
