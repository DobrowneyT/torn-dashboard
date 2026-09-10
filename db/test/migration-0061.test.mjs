// Migration 0061 (#632) — the index that makes the fleet-metrics endpoint
// answerable at all.
//
// ⚠️ Reproduced against every live tenant on 2026-09-10: /api/internal/fleet-metrics
// rejected an unauthenticated caller in milliseconds and then returned NOTHING
// after 25 seconds with a valid token. The consecutive-failure query was a
// correlated subquery re-evaluated per row over the whole of `scraper_runs`,
// which is append-only and has never been pruned. The rewritten query is two
// indexed lookups per job — and stays that way only while this index exists.
//
// The assertion that matters most is the last one: a tenant created from
// template.sql and a tenant migrated to 0061 must end up with the SAME indexes.
// They are two files, edited by hand, and nothing else checks they agree.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0061-scraper-runs-status-index.sql'), 'utf8')
const TEMPLATE = readFileSync(join(here, '..', 'template.sql'), 'utf8')

// The shape a tenant has before 0061: the #67 table with only its original
// (job_name, started_at DESC) index.
const OLD_SCHEMA = `
CREATE TABLE public.scraper_runs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  job_name text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  status text DEFAULT 'running' NOT NULL,
  rows_written integer DEFAULT 0 NOT NULL,
  error text,
  details jsonb
);
ALTER TABLE public.scraper_runs ADD CONSTRAINT scraper_runs_pkey PRIMARY KEY (id);
CREATE INDEX idx_scraper_runs_job_started ON public.scraper_runs USING btree (job_name, started_at DESC);
`

let embedded
let dataDir
let db
/** A second database on the same cluster, built from db/template.sql. */
let fresh
let port

const indexesOn = async (client, table) => {
  const r = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [table]
  )
  return r.rows.map((x) => x.indexname)
}

beforeAll(async () => {
  port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'migration-0061-'))
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false,
  })
  await embedded.initialise()
  await embedded.start()
  await embedded.createDatabase('m0061')
  db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'm0061' })
  await db.connect()
}, 120_000)

afterAll(async () => {
  await fresh?.end().catch(() => {})
  await db?.end().catch(() => {})
  await embedded?.stop().catch(() => {})
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('migration 0061', () => {
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
    await db.query(OLD_SCHEMA)
  })

  it('adds the index, and applies again without error', async () => {
    expect(await indexesOn(db, 'scraper_runs')).not.toContain('idx_scraper_runs_job_status_started')
    await db.query(MIGRATION)
    expect(await indexesOn(db, 'scraper_runs')).toContain('idx_scraper_runs_job_status_started')
    // ⚠️ Re-running every migration is the deploy path, not an edge case:
    // db/migrate.mjs replays the whole directory.
    await db.query(MIGRATION)
    expect(await indexesOn(db, 'scraper_runs')).toContain('idx_scraper_runs_job_status_started')
  })

  it('⚠️ keeps the original index — the streak query is not its only reader', async () => {
    expect(await indexesOn(db, 'scraper_runs')).toContain('idx_scraper_runs_job_started')
  })

  it('indexes the columns the query filters on, in the order it filters them', async () => {
    const r = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_scraper_runs_job_status_started'`
    )
    // job_name and status are equality predicates and must come first;
    // started_at is the range scan that yields the streak.
    expect(r.rows[0].indexdef).toMatch(/\(job_name, status, started_at DESC\)/)
  })

  it('⚠️ does NOT add a bare (started_at) index', async () => {
    // Deliberate, and measured. It takes the 24-hour window count from 55ms to
    // 4ms — and the planner then prefers it for the per-job "newest success"
    // probe, walking the whole index filtering by job_name, which puts the
    // query that matters back from 14ms to 370ms.
    const bare = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'scraper_runs'
          AND indexdef ~ '\\(started_at[ ,)]'`
    )
    expect(bare.rows).toEqual([])
    // Exactly the primary key plus the two deliberate indexes — a fourth
    // appearing here is a decision somebody needs to have measured.
    expect(await indexesOn(db, 'scraper_runs')).toEqual([
      'idx_scraper_runs_job_started',
      'idx_scraper_runs_job_status_started',
      'scraper_runs_pkey',
    ])
  })

  it('⚠️ leaves a migrated tenant with the SAME indexes as a fresh one', async () => {
    // Two hand-edited files. Nothing else checks that db/template.sql and this
    // migration agree, and a new faction provisioned from the template would
    // silently be the slow one.
    const migrated = await indexesOn(db, 'scraper_runs')

    // ⚠️ A separate DATABASE, not a schema. template.sql carries `public.`
    // qualified references (`nextval('crime_required_items_id_seq'::regclass)`
    // and friends), so applying it under a different search_path fails on the
    // first sequence — which looks like a broken test rather than what it is.
    await embedded.createDatabase('fresh_template')
    fresh = new pg.Client({
      host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'fresh_template',
    })
    await fresh.connect()
    await fresh.query(TEMPLATE)
    expect((await indexesOn(fresh, 'scraper_runs')).sort()).toEqual([...migrated].sort())
  })
})
