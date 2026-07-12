# Self-hosted stack

Shared Postgres + nginx; **every faction is a module** — one API process per
faction, provisioned by `db/new-faction.mjs`, no code edits. The base
compose file holds only the shared services; each faction's `api-<slug>`
service lives in `deploy/docker-compose.override.yml` (auto-loaded when you
run compose from `deploy/`). `dashboard-migration.md` is the roadmap of
record.

## Quickstart

```bash
cp deploy/.env.example deploy/.env        # set POSTGRES_PASSWORD + JWT_SECRET
                                          # (+ KEY_ENCRYPTION_KEY: openssl rand -hex 32)
cd deploy && docker compose up -d --wait postgres nginx && cd ..

node db/new-faction.mjs --slug forge --name "TNL Forge Dashboard" --faction-id <torn id>
cd deploy && docker compose up -d --build api-forge nginx
```

- SPA: http://localhost:8088 (the default server routes unmatched hostnames
  to `api-forge`) — or any faction at `http://<slug>.localhost:8088`
- API health: `curl -H "Host: <slug>.localhost" localhost:8088/api/health`

To target a different Postgres, set the standard `PG*` env vars — remember to
`export` them (or prefix them on the same line as the command); they override
`deploy/.env`.

## Adding a faction

```bash
node db/new-faction.mjs --slug mayhem --name "TNL Mayhem Dashboard" --faction-id <torn id> \
  --leader-id <their leader's torn id> --admin-id <your torn id>
cd deploy && docker compose up -d --build api-mayhem nginx
curl -H "Host: mayhem.localhost" localhost:8088/api/health   # {"faction":"mayhem"}
```

The script provisions everything:

- the database from `db/template.sql` + seeds + the `faction_config` row
- a **scoped credential** `app_<slug>` that can only reach its own database
  (password appended to `deploy/.env` as `DB_PASSWORD_<SLUG>`; PUBLIC
  connect revoked, so cross-tenant access is denied at connect time)
- `deploy/docker-compose.override.yml` — the `api-<slug>` service
- `deploy/nginx/factions/<slug>.conf` — the `<slug>.*` vhost (baked into the
  nginx image on its next build; the variable `proxy_pass` + docker resolver
  means one faction's API being down never stops nginx or the other tenants)

### Faction bring-up (the leader's first steps)

1. `--leader-id`/`--admin-id` already seeded the first roles at provisioning
   (leadership for the faction's leader, admin for you the operator) —
   everything after is self-serve in the dashboard. For a faction created
   without the flags, grant via SQL: `INSERT INTO role_assignments
   (torn_user_id, role) VALUES (<id>, 'leadership')`.
2. The leader logs in at `http://<slug>.localhost:8088` (or their subdomain).
   The first login stubs their roster row and enrolls their key into the
   faction's pool, breaking the fresh-faction bootstrap cycle.
3. **Scrapers start disabled — all of them.** In Leadership → Global Admin,
   run `members-sync` once to fill the roster, then enable the jobs the
   faction wants and tune their cadences. There is no env switch: per-job
   `enabled` + `cron_schedule` in the faction's own database is the whole
   configuration (the scheduler is armed whenever `KEY_ENCRYPTION_KEY` is
   set, and disabled jobs cost zero Torn calls).

## Adopting an existing database as a module

For a database that predates multi-tenancy (or a production dump restored
into a new stack):

```bash
node db/new-faction.mjs --slug forge --adopt
cd deploy && docker compose up -d --build api-forge nginx
```

Adoption provisions the scoped credential and deploy artifacts but touches
no schema, seeds, or `faction_config`. Run `node db/migrate.mjs` too if the
DB predates the latest migrations.

## Removing a faction

Everything a faction owns is listed below; removal is complete and
irreversible (dump the DB first if in doubt):

```bash
cd deploy
docker compose rm -sf api-<slug>          # stop + remove its API container
docker exec tnl-dashboard-postgres-1 psql -U postgres \
  -c 'DROP DATABASE faction_<slug>' -c 'DROP ROLE app_<slug>'
```

Then delete its `api-<slug>` block from `deploy/docker-compose.override.yml`,
its `deploy/nginx/factions/<slug>.conf`, and the `DB_PASSWORD_<SLUG>` line
from `deploy/.env`, and rebuild nginx: `docker compose up -d --build nginx`.

## Backups, restore, and monitoring (slice #76)

### Nightly backups

The `backup` sidecar dumps **every** `faction_*` database (`pg_dump` → gzip →
`/backups`), then once daily at `BACKUP_HOUR_UTC` (default 04:00). It's opt-in,
like the scrapers — bring it up once:

```bash
cd deploy
docker compose --profile backup up -d --build backup
docker compose logs -f backup     # watch a run
```

Local dumps live in the `backups` volume and are pruned past
`BACKUP_RETENTION_DAYS` (default 14). Run one on demand any time:

```bash
docker compose run --rm backup node db/backup.mjs --out /backups
```

**Ship to object storage (Backblaze B2).** The upload + remote-prune are gated
on `RCLONE_REMOTE`; until it's set the sidecar keeps local dumps only. Wire B2
by adding to `deploy/.env` (passed through via `env_file`), no config file
needed:

```env
RCLONE_REMOTE=b2:tnl-dashboard-backups
RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=<your B2 keyID>
RCLONE_CONFIG_B2_KEY=<your B2 applicationKey>
```

Recreate the sidecar (`docker compose --profile backup up -d backup`); each run
now copies to B2 and `rclone delete --min-age 14d` enforces retention there too.

### Restore drill

Prove a backup is good by restoring it to a **scratch** DB and booting against
it. Run periodically (the roadmap calls for it once in staging):

```bash
cd deploy
# newest Forge archive → a throwaway DB (created fresh with --create)
docker compose run --rm backup sh -c \
  'node db/restore.mjs --create --db faction_forge_restore \
     --archive $(ls -1t /backups/faction_forge_*.sql.gz | head -1)'
```

It restores with `ON_ERROR_STOP` and prints a smoke summary (table count +
`faction_config`). To boot the stack against the restored copy, point a
throwaway `api-*` service's `DATABASE_URL` at `faction_forge_restore` and hit
`/api/health/ready`. Drop the scratch DB when done:
`docker exec tnl-dashboard-postgres-1 psql -U postgres -c 'DROP DATABASE faction_forge_restore'`.

### Healthchecks & uptime monitoring

- **Liveness** — `GET /api/health` → `200 {status:ok}` whenever the process is
  up. The generated `api-<slug>` container HEALTHCHECK hits this, so
  `docker ps` shows health; `restart: unless-stopped` on every service means a
  killed container comes back on its own.
- **Readiness** — `GET /api/health/ready` reports live DB connectivity plus
  whether the scheduler and war-room ticker are armed, and returns **503** when
  the DB is unreachable. Point **UptimeRobot** (free tier) at
  `https://<slug>.<domain>/api/health/ready` per faction with a keyword/HTTP
  check so a DB outage or a down tenant pages you.

## Notes

- Run `docker compose` from `deploy/` (or pass both `-f` files) so the
  override with the faction services is loaded.
- The default nginx server (any unmatched hostname, e.g. plain `localhost`)
  routes to `api-forge`.
- Existing DBs created before the current migrations should run
  `node db/migrate.mjs`.
- Docker build contexts exclude `.env` files (see `.dockerignore`); the SPA
  currently bakes Supabase config at build time only for local non-docker dev.
