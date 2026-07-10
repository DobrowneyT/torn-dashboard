# Self-hosted stack

Skeleton from migration slice #59: shared Postgres + nginx, one API process per
faction. `dashboard-migration.md` is the roadmap of record.

## Quickstart

```bash
cp deploy/.env.example deploy/.env        # set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up --build -d

# create the first faction database (reads deploy/.env for credentials)
node db/new-faction.mjs --slug forge --name "TNL Forge Dashboard" --faction-id <torn id>
```

To target a different Postgres, set the standard `PG*` env vars — remember to
`export` them (or prefix them on the same line as the command); they override
`deploy/.env`.

- SPA: http://localhost:8088
- API health: http://localhost:8088/api/health

## Adding a faction (slice #75 runbook — no code edits)

```bash
node db/new-faction.mjs --slug mayhem --name "TNL Mayhem Dashboard" --faction-id <torn id>
cd deploy && docker compose up -d --build api-mayhem nginx
curl -H "Host: mayhem.localhost" localhost:8088/api/health   # {"faction":"mayhem"}
```

The script provisions everything:

- the database from `db/template.sql` + seeds + the `faction_config` row
- a **scoped credential** `app_<slug>` that can only reach its own database
  (password appended to `deploy/.env` as `DB_PASSWORD_<SLUG>`)
- `deploy/docker-compose.override.yml` — the `api-<slug>` service
  (auto-loaded by `docker compose`; run compose from `deploy/`)
- `deploy/nginx/factions/<slug>.conf` — the `<slug>.*` vhost (baked into the
  nginx image on its next build; the variable `proxy_pass` means one
  faction's API being down never stops nginx or the other tenants)

Then grant the faction leader their first role (`role_assignments`) and they
self-serve the rest through the Settings page. Their first login also breaks
the fresh-faction bootstrap cycle: it stubs their roster row and enrolls
their key into the pool, so `members-sync` (or its Global Admin "Run now")
can fill the roster.

Scrapers are **per-faction opt-in**: each generated service reads
`SCRAPERS_ENABLED_<SLUG>` (default `false`), so a new tenant never starts
scraping because the shared flag happens to be on. Individual jobs are
toggled per faction in that faction's Global Admin page (`scraper_jobs`).

## Notes

- The default nginx server (any unmatched hostname, e.g. plain `localhost`)
  still routes to `api-forge`.
- Existing DBs created before slice #75 should run `node db/migrate.mjs` to
  pick up the tenant-isolation REVOKE (0002).
- Docker build contexts exclude `.env` files (see `.dockerignore`); the SPA
  currently bakes Supabase config at build time only for local non-docker dev.
