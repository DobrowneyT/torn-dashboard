// #996 — the measurement job end to end against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { statMeasurementsJob, WATERMARK_SETTING } from '../src/scraper/jobs/statMeasurements.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const THEM = 20747
const HITTER = 3001
const GUESSED = 3002
const TARGET = 9001
const NOW = Math.floor(Date.now() / 1000)

function deps() {
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  const client = createTornClient({ baseUrl: stack.tornBaseUrl })
  return { db: stack.db, pool, client } as any
}

let attackId = 1
async function hit(o: { ff: number; at?: number; by?: number; respect?: number; target?: number }) {
  await stack.db.query(
    `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_faction_id,
       defender_id, defender_faction_id, result, respect_gain, fair_fight, is_incoming)
     VALUES ($1, $2, $3, $4, $5, $6, 'Hospitalized', $7, $8, false)`,
    [attackId++, o.at ?? NOW - 600, o.by ?? HITTER, US, o.target ?? TARGET, THEM,
     o.respect ?? 5, o.ff])
}

/** A roster row with a spy. Each stat (s) gives a score of 4√s. */
async function rosterRow(o: { each: number; source?: string; spiedAt?: number | null }) {
  await stack.db.query(
    `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, bsp_total, bsp_str, bsp_spd,
       bsp_def, bsp_dex, spy_source, ts_spy_at)
     VALUES ($1, $2, 'Target', $3, $4, $4, $4, $4, $5, ${o.spiedAt ? 'to_timestamp($6)' : 'NULL'})`,
    o.spiedAt
      ? [TARGET, THEM, o.each * 4, o.each, o.source ?? 'tornstats', o.spiedAt]
      : [TARGET, THEM, o.each * 4, o.each, o.source ?? 'bsp'])
}

const measurement = async () =>
  (await stack.db.query('SELECT * FROM target_stat_measurements WHERE target_id = $1', [TARGET])).rows[0]
const roster = async () =>
  (await stack.db.query('SELECT measured_score, measured_bound FROM war_room_state_v2 WHERE member_id = $1', [TARGET])).rows[0]

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

beforeEach(async () => {
  for (const t of ['faction_attacks', 'target_stat_measurements', 'war_room_state_v2', 'member_battle_stats']) {
    await stack.db.query(`DELETE FROM ${t}`)
  }
  await stack.db.query('DELETE FROM faction_settings WHERE key LIKE $1', ['stat_measure_%'])
  // Score 40,000 from the hitter's own key; a guessed-stats member beside them.
  await stack.db.query(
    `INSERT INTO member_battle_stats (member_id, strength, speed, defense, dexterity, total, source)
     VALUES ($1, 1e8, 1e8, 1e8, 1e8, 4e8, 'torn'), ($2, 1e8, 1e8, 1e8, 1e8, 4e8, 'bsp')`,
    [String(HITTER), String(GUESSED)])
})

describe('stat-measurements job', () => {
  it('measures a target from a hit and puts it on the War Room row', async () => {
    await rosterRow({ each: 1e7 }) // a BSP guess predicting ~1.84
    await hit({ ff: 2 })
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ stored: 1 })
    const m = await measurement()
    expect(Number(m.score)).toBeCloseTo(15_000)
    expect(m.bound).toBe('exact')
    expect(Number((await roster()).measured_score)).toBeCloseTo(15_000)
  })

  it('leaves the spy alone when the hit agrees within the deadband', async () => {
    // Each stat (14250/4)² predicts 1.95 for this hitter; Torn gave 2.00.
    await rosterRow({ each: Math.round((14_250 / 4) ** 2) })
    await hit({ ff: 2 })
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ stored: 0 })
    expect(await measurement()).toBeUndefined()
    expect((await roster()).measured_score).toBeNull()
  })

  it('a later agreeing hit only confirms, and does not move the value', async () => {
    await hit({ ff: 2, at: NOW - 3600 })
    await statMeasurementsJob(deps())
    await hit({ ff: 2.05, at: NOW - 60 })
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ stored: 0, confirmed: 1 })
    const m = await measurement()
    expect(Number(m.score)).toBeCloseTo(15_000)
    expect(m.confirmed_at).not.toBeNull()
  })

  it('ignores hitters whose stats are only an estimate, and hits that earned nothing', async () => {
    await hit({ ff: 2, by: GUESSED })
    await hit({ ff: 2, respect: 0 })
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ considered: 0 })
  })

  it('a newer TornStats spy beats the measurement on the roster', async () => {
    await rosterRow({ each: 1e7, spiedAt: NOW })
    await hit({ ff: 2, at: NOW - 3600 })
    await statMeasurementsJob(deps())
    expect(await measurement()).toBeDefined()
    expect((await roster()).measured_score).toBeNull()
  })

  it('does not reprocess hits behind the watermark', async () => {
    await hit({ ff: 2 })
    await statMeasurementsJob(deps())
    const wm = await stack.db.query('SELECT value FROM faction_settings WHERE key = $1', [WATERMARK_SETTING])
    expect(wm.rows[0]).toBeDefined()
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ considered: 0 })
  })

  it('drops a measurement past its expiry', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('stat_measure_max_age_days', '1'::jsonb)`)
    await stack.db.query(
      `INSERT INTO target_stat_measurements (target_id, score, bound, fair_fight, attacker_id,
         attacker_score, attack_id, measured_at)
       VALUES ($1, 15000, 'exact', 2, $2, 40000, 1, now() - interval '3 days')`, [TARGET, HITTER])
    const res = await statMeasurementsJob(deps())
    expect(res.details).toMatchObject({ expired: 1 })
  })
})
