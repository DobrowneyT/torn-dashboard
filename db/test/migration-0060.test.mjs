// Migration 0060 (#606 slice 3) against the real pre-migration shape.
//
// This one DROPS four tables holding live data, which is the most destructive
// thing in the repo's migration history. The risk is not that the drop fails —
// it is that it succeeds while quietly taking something with it that nothing
// carried across, and the loss is invisible: an empty stats map renders exactly
// like a node nobody has run.
//
// So the assertions below are mostly about what SURVIVES.
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
const MIGRATION = readFileSync(join(here, '..', 'migrations', '0060-drop-oc-scenario-mirror.sql'), 'utf8')

// The pre-#606 shape, including the ON DELETE CASCADE foreign keys that make
// the parent undroppable without them — omit those and the test would pass
// against a schema the production database does not have.
const OLD_SCHEMA = `
CREATE TABLE public.scraper_jobs (job_name text PRIMARY KEY, enabled boolean DEFAULT true);
CREATE TABLE public.scraper_runs (
  id bigserial PRIMARY KEY, job_name text NOT NULL, status text, started_at timestamptz DEFAULT now()
);
CREATE TABLE public.oc_scenarios (
  name text PRIMARY KEY,
  parameter_count int NOT NULL,
  is_complete boolean,
  observed_paths int,
  diagram text,
  diagram_valid boolean,
  diagram_problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  ending_map_residual numeric,
  ending_map_confident boolean,
  ending_map_money_residual numeric,
  ending_map_money_confident boolean,
  role_fidelity_error numeric,
  role_fidelity_roles jsonb
);
CREATE TABLE public.oc_scenario_roles (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  position_id text NOT NULL, role_name text, weight numeric,
  PRIMARY KEY (scenario_name, position_id)
);
CREATE TABLE public.oc_scenario_endings (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  ending_key text NOT NULL, node_id text, kind text, resolved boolean,
  problem text, starved boolean DEFAULT false,
  PRIMARY KEY (scenario_name, ending_key)
);
CREATE INDEX oc_scenario_endings_node_idx ON public.oc_scenario_endings (scenario_name, node_id);
CREATE TABLE public.oc_scenario_node_stats (
  scenario_name text NOT NULL REFERENCES public.oc_scenarios(name) ON DELETE CASCADE,
  node_id text NOT NULL, n integer NOT NULL DEFAULT 0,
  money_min bigint, money_max bigint, money_avg bigint,
  respect_min numeric, respect_max numeric, respect_avg numeric,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_name, node_id)
);
`

let server, dataDir, client

beforeAll(async () => {
  const port = await freePort()
  dataDir = mkdtempSync(join(tmpdir(), 'tnl-migration-0060-test-'))
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false })
  await server.initialise()
  await server.start()
  await server.createDatabase('faction_migration_0060_test')
  client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'faction_migration_0060_test' })
  await client.connect()
  await client.query(OLD_SCHEMA)

  await client.query(`
    INSERT INTO oc_scenarios
      (name, parameter_count, is_complete, observed_paths, diagram_valid,
       ending_map_residual, ending_map_confident,
       ending_map_money_residual, ending_map_money_confident) VALUES
      -- Measured by our probe sweep: must survive.
      ('Break the Bank', 6, true, 411, true, 0.0123, true, 0.0456, true),
      -- Never probed: must NOT be carried across as a row of nulls.
      ('Lock Stock', 5, false, 126, true, NULL, NULL, NULL, NULL)
  `)
  await client.query(`
    INSERT INTO oc_scenario_roles (scenario_name, position_id, role_name, weight)
    VALUES ('Break the Bank', 'P1', 'Robber', 20)
  `)
  await client.query(`
    INSERT INTO oc_scenario_endings (scenario_name, ending_key, node_id, kind, resolved)
    VALUES ('Break the Bank', 'goodEnding1', '_A8S_', 'good', true)
  `)
  await client.query(`
    INSERT INTO oc_scenario_node_stats (scenario_name, node_id, n, money_avg, respect_avg)
    VALUES ('Break the Bank', '_A8S_', 20129, 419643211, 663)
  `)
  await client.query(`INSERT INTO scraper_jobs (job_name) VALUES ('oc-scenarios-mirror'), ('members-sync')`)
  await client.query(`
    INSERT INTO scraper_runs (job_name, status) VALUES
      ('oc-scenarios-mirror', 'success'), ('members-sync', 'success')
  `)
}, 60000)

afterAll(async () => {
  await client?.end()
  await server?.stop()
  rmSync(dataDir, { recursive: true, force: true })
})

const tableExists = async (name) => (await client.query(
  `SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = $1`, [name]
)).rows[0].n === 1

describe('migration 0060 drops the OC mirror', () => {
  it('applies, and applies again', async () => {
    await expect(client.query(MIGRATION)).resolves.toBeDefined()
    // update.sh re-runs migrations on every deploy, so a second application
    // must be a no-op rather than an error on the already-dropped tables.
    await expect(client.query(MIGRATION)).resolves.toBeDefined()
  })

  it('⚠️ CARRIES OUR OWN ending-map measurements into oc_scenario_quality', async () => {
    // The one thing in those four tables that was ours. It is derived by the
    // maintainer probe sweep (#471/#473) against a tenant's own data, so it
    // cannot be recovered from the image if lost here.
    const row = (await client.query(
      `SELECT * FROM oc_scenario_quality WHERE scenario_name = 'Break the Bank'`
    )).rows[0]
    expect(Number(row.ending_map_residual)).toBeCloseTo(0.0123)
    expect(row.ending_map_confident).toBe(true)
    expect(Number(row.ending_map_money_residual)).toBeCloseTo(0.0456)
    expect(row.ending_map_money_confident).toBe(true)
  })

  it('⚠️ does NOT carry across a scenario that was never probed', async () => {
    // A row of nulls would assert "measured, and the answer was nothing"
    // where the truth is "never measured". Absent, never zero (#351/#441).
    const n = (await client.query(
      `SELECT count(*)::int AS n FROM oc_scenario_quality WHERE scenario_name = 'Lock Stock'`
    )).rows[0].n
    expect(n).toBe(0)
  })

  it('drops all four mirror tables, cascade and all', async () => {
    for (const t of ['oc_scenarios', 'oc_scenario_roles', 'oc_scenario_endings', 'oc_scenario_node_stats']) {
      expect(await tableExists(t), t).toBe(false)
    }
  })

  it('removes the job’s own scheduling rows, and only its own', async () => {
    // Left behind, it would keep appearing on the Global Admin scraper page as
    // a job that no longer exists.
    const jobs = (await client.query(`SELECT job_name FROM scraper_jobs ORDER BY job_name`)).rows
    expect(jobs.map((r) => r.job_name)).toEqual(['members-sync'])
    const runs = (await client.query(`SELECT job_name FROM scraper_runs ORDER BY job_name`)).rows
    expect(runs.map((r) => r.job_name)).toEqual(['members-sync'])
  })

  it('\u26a0\ufe0f applies cleanly to a database that never had the mirror at all', async () => {
    // A tenant provisioned from the post-slice-3 template has no `oc_scenarios`
    // for the backfill to read, and the backfill is guarded for exactly that.
    // Without the guard this migration would fail on every newly provisioned
    // faction — the case least likely to be noticed, because it surfaces only
    // the next time somebody adds one.
    //
    // The mirror tables are already gone by this point, so dropping the
    // quality table too reproduces a genuinely fresh database.
    await client.query(`DROP TABLE public.oc_scenario_quality`)
    expect(await tableExists('oc_scenario_quality')).toBe(false)

    await expect(client.query(MIGRATION)).resolves.toBeDefined()
    expect(await tableExists('oc_scenario_quality')).toBe(true)
    // Created empty, not populated with invented rows.
    const n = (await client.query(`SELECT count(*)::int AS n FROM oc_scenario_quality`)).rows[0].n
    expect(n).toBe(0)
  })
})
