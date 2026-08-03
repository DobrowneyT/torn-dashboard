# Backup sidecar (#76): a postgres:17 base (version-matched pg_dump/psql) with
# node + rclone to run db/backup.mjs on a nightly loop and drive the restore
# drill. Build context is the repo root (npm workspaces).
FROM postgres:17-alpine

RUN apk add --no-cache nodejs npm rclone

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
