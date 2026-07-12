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

## Notes

- Run `docker compose` from `deploy/` (or pass both `-f` files) so the
  override with the faction services is loaded.
- The default nginx server (any unmatched hostname, e.g. plain `localhost`)
  routes to `api-forge`.
- Existing DBs created before the current migrations should run
  `node db/migrate.mjs`.
- Docker build contexts exclude `.env` files (see `.dockerignore`); the SPA
  currently bakes Supabase config at build time only for local non-docker dev.
