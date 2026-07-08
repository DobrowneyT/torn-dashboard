# Self-hosted stack

Skeleton from migration slice #59: shared Postgres + nginx, one API process per
faction. `dashboard-migration.md` is the roadmap of record.

## Quickstart

```bash
cp deploy/.env.example deploy/.env        # set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up --build -d

# create the first faction database (host-side, against the published port)
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=<same as .env> \
  node db/new-faction.mjs --slug forge --name "TNL Forge Dashboard" --faction-id <torn id>
```

- SPA: http://localhost:8088
- API health: http://localhost:8088/api/health

## Adding a faction

Run `db/new-faction.mjs` with the new slug — it creates the database from
`db/template.sql`, seeds it, writes the `faction_config` row, and prints the
`docker-compose.yml` service block and nginx routing line to paste in.

## Notes

- Docker build contexts exclude `.env` files (see `.dockerignore`); the SPA
  currently bakes Supabase config at build time only for local non-docker dev.
  Runtime config via `/api/bootstrap` arrives in a later slice.
- nginx routes everything to `api-forge` for now; per-subdomain host routing
  lands with slice #75.
