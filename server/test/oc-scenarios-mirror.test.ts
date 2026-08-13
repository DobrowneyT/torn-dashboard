// #390 — mirroring the OC probability model into our own tables.
//
// Driven against real templated Postgres with a stubbed HTTP layer whose
// responses are REAL captures from tornprobability (2026-08-13), including the
// Break the Bank probe sweep the ending mapping was derived from. The point is
// that the job stores a mapping that is right, and stores nothing at all where
// it cannot be sure.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestStack, type TestStack } from './harness.js'
import { ocScenariosMirrorJob } from '../src/scraper/jobs/ocScenariosMirror.js'

const here = dirname(fileURLToPath(import.meta.url))
const BTB = readFileSync(join(here, 'fixtures', 'break-the-bank.mmd'), 'utf8')
const MOB = readFileSync(join(here, 'fixtures', 'mob-mentality.mmd'), 'utf8')

let stack: TestStack

const good = (g1: number, g2: number, g3: number, g4: number, g5: number) => ({
  successChance: 0.9998,
  failureChance: 0.0002,
  goodEnding1: g1, goodEnding2: g2, goodEnding3: g3, goodEnding4: g4, goodEnding5: g5,
  badEnding1: 0, badEnding2: 0, badEnding3: 0, badEnding4: 0.0001, badEnding5: 0.0001,
})

// The live sweep: baseline, then one role dropped to CPR 1 at a time.
const BTB_PROBES: Record<string, ReturnType<typeof good>> = {
  '99,99,99,99,99,99': good(0.9700, 0.0098, 0.0197, 0.0002, 0.0001),
  '1,99,99,99,99,99':  good(0.1243, 0.1243, 0.0075, 0.7386, 0.0001),  // Robber
  '99,1,99,99,99,99':  good(0.2462, 0.0025, 0.7386, 0.0075, 0.0001),  // Muscle 1
  '99,99,1,99,99,99':  good(0.7275, 0.0073, 0.0148, 0.0001, 0.2475),  // Muscle 2
  '99,99,99,1,99,99':  good(0.3675, 0.3675, 0.0148, 0.0001, 0.2475),  // Thief 1
  '99,99,99,99,1,99':  good(0.4898, 0.0050, 0.0100, 0.0001, 0.0001),  // Muscle 3
  '99,99,99,99,99,1':  good(0.4899, 0.0050, 0.0100, 0.0001, 0.0000),  // Thief 2
}

const SCENARIOS_PAGE = `
<a class="card"><span class="card-name">Break the Bank</span>
<span class="card-meta">411 paths <span class="tag complete">Complete</span></span></a>
<a class="card"><span class="card-name">Mob Mentality</span>
<span class="card-meta">126 paths <span class="tag wip">In Progress</span></span></a>`

interface StubOptions {
  scenarios?: Array<{ name: string; parameters: number }>
  page?: string | null
  diagrams?: Record<string, string>
}

/** A fetch stub speaking the four shapes the real service speaks. */
function stubFetch(opts: StubOptions = {}) {
  const calls: string[] = []
  const scenarios = opts.scenarios ?? [
    { name: 'Break the Bank', parameters: 6 },
    { name: 'Mob Mentality', parameters: 4 },
  ]
  const diagrams = opts.diagrams ?? { 'Break the Bank': BTB, 'Mob Mentality': MOB }

  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

    if (url.includes('GetSupportedScenarios')) return json(scenarios)
    if (url.includes('GetRoleNames')) {
      return json({
        'Break the Bank': {
          P1: 'Robber', P2: 'Muscle 1', P3: 'Muscle 2',
          P4: 'Thief 1', P5: 'Muscle 3', P6: 'Thief 2',
        },
        'Mob Mentality': { P1: 'Looter 1', P2: 'Looter 2', P3: 'Looter 3', P4: 'Looter 4' },
      })
    }
    if (url.includes('GetRoleWeights')) {
      // Note the other spelling, exactly as the live service returns it.
      return json({
        BreakTheBank: { Robber: 20, Muscle1: 20, Muscle2: 15, Thief1: 20, Muscle3: 15, Thief2: 10 },
        MobMentality: { Looter1: 33.9, Looter2: 26.5, Looter3: 18.4, Looter4: 21.2 },
      })
    }
    if (url.includes('/scenarios')) {
      if (opts.page === null) return new Response('down', { status: 503 })
      return new Response(opts.page ?? SCENARIOS_PAGE, { status: 200 })
    }
    if (url.includes('/events/')) {
      const name = decodeURIComponent(new URL(url, 'https://x').searchParams.get('s') ?? '')
      const diagram = diagrams[name]
      if (!diagram) return new Response('event: nothing\ndata: e30=\n\n', { status: 200 })
      const b64 = Buffer.from(diagram, 'utf8').toString('base64')
      return new Response(`event: diagram\ndata: ${b64}\n\n`, { status: 200 })
    }
    if (url.includes('CalculateSuccess')) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const key = (body.parameters ?? []).join(',')
      if (body.scenario === 'Break the Bank' && BTB_PROBES[key]) return json(BTB_PROBES[key])
      // Any other scenario gets a flat, uninformative sweep — no role evidence.
      return json(good(0.97, 0.0098, 0.0098, 0.0002, 0.0002))
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch

  return { impl, calls }
}

const run = (opts: StubOptions = {}) => {
  const { impl, calls } = stubFetch(opts)
  return ocScenariosMirrorJob(
    { db: stack.db } as any,
    { fetchImpl: impl, baseUrl: 'https://stub', spacingMs: 0 }
  ).then((res) => ({ res, calls }))
}

beforeAll(async () => { stack = await startTestStack() }, 30000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM oc_scenario_endings')
  await stack.db.query('DELETE FROM oc_scenario_roles')
  await stack.db.query('DELETE FROM oc_scenarios')
})

describe('ocScenariosMirrorJob', () => {
  it('mirrors scenarios, roles and the derived ending map', async () => {
    const { res } = await run()
    expect(res.details!.mirrored).toBe(2)

    const scenarios = await stack.db.query('SELECT * FROM oc_scenarios ORDER BY name')
    expect(scenarios.rows.map((r) => r.name)).toEqual(['Break the Bank', 'Mob Mentality'])
    expect(scenarios.rows[0].parameter_count).toBe(6)
    expect(scenarios.rows[0].diagram).toContain('flowchart')
  })

  it('stores the DERIVED mapping, not declaration order', async () => {
    // ⚠️ The whole reason the mirror does probe sweeps at all. Declaration order
    // is _A8S_, _A8S2_, _A10S_, _A9S_, _B3S_ and the truth swaps positions 3
    // and 4 — two endings would carry each other's payouts, with every number
    // staying plausible.
    await run()
    const r = await stack.db.query(
      `SELECT ending_key, node_id FROM oc_scenario_endings
        WHERE scenario_name = 'Break the Bank' AND kind = 'good'
        ORDER BY ending_key`
    )
    expect(Object.fromEntries(r.rows.map((x) => [x.ending_key, x.node_id]))).toEqual({
      goodEnding1: '_A8S_',
      goodEnding2: '_A8S2_',
      goodEnding3: '_A9S_',
      goodEnding4: '_A10S_',
      goodEnding5: '_B3S_',
    })
  })

  it('joins role weights across the two spellings', async () => {
    // "Mob Mentality"/"Looter 1" in names vs "MobMentality"/"Looter1" in
    // weights. A raw join leaves every weight null.
    await run()
    const r = await stack.db.query(
      `SELECT position_id, role_name, weight FROM oc_scenario_roles
        WHERE scenario_name = 'Mob Mentality' ORDER BY position_id`
    )
    expect(r.rows.map((x) => x.role_name)).toEqual(['Looter 1', 'Looter 2', 'Looter 3', 'Looter 4'])
    expect(r.rows.every((x) => x.weight !== null)).toBe(true)
  })

  it('records completeness the API does not carry', async () => {
    await run()
    const r = await stack.db.query('SELECT name, is_complete, observed_paths FROM oc_scenarios ORDER BY name')
    expect(r.rows[0]).toMatchObject({ name: 'Break the Bank', is_complete: true, observed_paths: 411 })
    expect(r.rows[1]).toMatchObject({ name: 'Mob Mentality', is_complete: false, observed_paths: 126 })
  })

  it('leaves completeness NULL when the page cannot be read, rather than false', async () => {
    // ⚠️ "We do not know whether this model is finished" is not "it is
    // unfinished". Defaulting to false would put a warning on all 31 crimes and
    // teach everyone to ignore it; defaulting to true is worse.
    const { res } = await run({ page: null })
    const r = await stack.db.query('SELECT name, is_complete FROM oc_scenarios')
    expect(r.rows.every((x) => x.is_complete === null)).toBe(true)
    // And the run still succeeds — completeness is not worth losing a mirror over.
    expect(res.details!.mirrored).toBe(2)
    expect(res.details!.completeness_error).toBeTruthy()
  })

  it('still mirrors a scenario whose diagram has a dead end', async () => {
    // Mob Mentality's `_A4F_Cont_` stops without reaching an ending. It is off
    // every path to a terminal, so the mapping is unaffected and refusing the
    // whole crime would cost a real capability for no safety.
    await run()
    const r = await stack.db.query(
      `SELECT diagram_valid, diagram_problems FROM oc_scenarios WHERE name = 'Mob Mentality'`
    )
    expect(r.rows[0].diagram_valid).toBe(true)
    expect(JSON.stringify(r.rows[0].diagram_problems)).toContain('_A4F_Cont_')
  })

  it('records an unresolved ending rather than omitting it', async () => {
    // ⚠️ Mob Mentality's sweep here is flat, so no role evidence separates its
    // endings. Omitting them would make "we could not work this out" look
    // identical to "this ending does not exist", and the simulator would price
    // the crime on a subset of its outcomes.
    const { res } = await run()
    const r = await stack.db.query(
      `SELECT ending_key, node_id, resolved, problem FROM oc_scenario_endings
        WHERE scenario_name = 'Mob Mentality' AND kind = 'good'`
    )
    expect(r.rows.length).toBeGreaterThan(0)
    const unresolved = r.rows.filter((x) => !x.resolved)
    expect(unresolved.length).toBeGreaterThan(0)
    expect(unresolved.every((x) => x.node_id === null)).toBe(true)
    expect(unresolved.every((x) => typeof x.problem === 'string' && x.problem.length > 0)).toBe(true)
    // The run reports it rather than passing silently.
    expect(res.details!.mapped).toBe(1)
    expect((res.details!.problems as string[]).join(' ')).toContain('Mob Mentality')
  })

  it('refuses to map a scenario whose role count contradicts the crime', async () => {
    // A CPR vector of the wrong length produces numbers for a crime nobody is
    // running. Mirror what we know, map nothing.
    const { res } = await run({ scenarios: [{ name: 'Break the Bank', parameters: 5 }] })
    const endings = await stack.db.query(`SELECT * FROM oc_scenario_endings WHERE scenario_name = 'Break the Bank'`)
    expect(endings.rows).toEqual([])
    const scenario = await stack.db.query(`SELECT name FROM oc_scenarios WHERE name = 'Break the Bank'`)
    expect(scenario.rows).toHaveLength(1)
    expect((res.details!.problems as string[]).join(' ')).toMatch(/6 roles listed but the crime takes 5/)
  })

  it('carries on when one scenario fails entirely', async () => {
    // One unreachable diagram must not cost the other thirty.
    const { res } = await run({ diagrams: { 'Break the Bank': BTB } })
    expect(res.details!.mirrored).toBe(1)
    expect((res.details!.problems as string[]).join(' ')).toContain('Mob Mentality')
    const r = await stack.db.query(`SELECT name FROM oc_scenarios`)
    expect(r.rows.map((x) => x.name)).toEqual(['Break the Bank'])
  })

  it('is idempotent — a second run replaces rather than duplicates', async () => {
    await run()
    await run()
    const scenarios = await stack.db.query('SELECT count(*)::int AS n FROM oc_scenarios')
    const roles = await stack.db.query(`SELECT count(*)::int AS n FROM oc_scenario_roles WHERE scenario_name = 'Break the Bank'`)
    expect(scenarios.rows[0].n).toBe(2)
    expect(roles.rows[0].n).toBe(6)
  })

  it('probes with one role dropped at a time, from a high baseline', async () => {
    // The sweep the derivation reads role evidence from: 1 + N calls per
    // scenario. Worth asserting because a wrong baseline silently produces a
    // mapping that is merely plausible.
    const { calls } = await run({ scenarios: [{ name: 'Break the Bank', parameters: 6 }] })
    const probes = calls.filter((c) => c.includes('CalculateSuccess'))
    expect(probes).toHaveLength(7)
  })
})
