// The #530 summary job, end to end against real Postgres.
//
// ⚠️ The pure rules are covered in `war-dibs-summary.test.ts`. This file exists
// for the parts only a database can get wrong: the bigint-vs-timestamptz split
// across `ranked_wars` and `war_room_dibs_v2`, the nullable client-supplied
// `war_id`, and the gate that must make a war WAIT rather than guess.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { dibsSummaryJob } from '../src/scraper/jobs/dibsSummary.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const THEM = 20747
const HOLDER = 1001
const MATE = 1002

const WAR_ID = 700
const WAR_START = 1_750_000_000
const WAR_END = WAR_START + 86_400

function deps() {
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  const client = createTornClient({ baseUrl: stack.tornBaseUrl })
  return { db: stack.db, pool, client } as any
}

async function reset() {
  await stack.db.query('DELETE FROM war_dibs_summary')
  await stack.db.query('DELETE FROM war_dibs_summary_state')
  await stack.db.query('DELETE FROM war_room_dibs_v2')
  await stack.db.query('DELETE FROM faction_attacks')
  await stack.db.query('DELETE FROM ranked_wars')
  await stack.db.query('DELETE FROM scraper_runs')
}

/** A finished war. ⚠️ bigint epoch SECONDS, not timestamptz. */
async function seedWar(endAt: number | null = WAR_END) {
  await stack.db.query(
    `INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name)
     VALUES ($1, $2, $3, $4, 'Foes')`,
    [WAR_ID, WAR_START, endAt, THEM]
  )
}

/** A claim. `claimed_at` / `deleted_at` ARE timestamptz. */
async function seedClaim(o: {
  target: number; by?: number; name?: string; at?: number; until?: number | null
  reason?: string | null; warId?: number | null
}) {
  await stack.db.query(
    `INSERT INTO war_room_dibs_v2
       (target_id, claimed_by, claimed_name, claimed_at, deleted_at, release_reason, war_id)
     VALUES ($1, $2, $3, to_timestamp($4), ${o.until == null ? 'NULL' : 'to_timestamp($5)'}, $6, $7)`,
    o.until == null
      ? [o.target, o.by ?? HOLDER, o.name ?? 'Holder', o.at ?? WAR_START + 100,
         o.reason ?? null, o.warId === undefined ? WAR_ID : o.warId]
      : [o.target, o.by ?? HOLDER, o.name ?? 'Holder', o.at ?? WAR_START + 100,
         o.until, o.reason ?? null, o.warId === undefined ? WAR_ID : o.warId]
  )
}

let nextAttackId = 1
async function seedAttack(o: {
  attacker?: number; attackerFaction?: number; name?: string
  defender: number; started: number; result?: string
}) {
  await stack.db.query(
    `INSERT INTO faction_attacks
       (attack_id, attacker_id, attacker_faction_id, attacker_name,
        defender_id, defender_faction_id, started, ended, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [nextAttackId++, o.attacker ?? HOLDER, o.attackerFaction ?? US, o.name ?? 'Holder',
     o.defender, THEM, o.started, o.started + 20, o.result ?? 'Hospitalized']
  )
}

const summaryFor = async (memberId: number) => {
  const r = await stack.db.query(
    'SELECT * FROM war_dibs_summary WHERE war_id = $1 AND member_id = $2',
    [WAR_ID, memberId]
  )
  return r.rows[0] ?? null
}

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('dibs-summary job', () => {
  it('does nothing when there are no finished wars', async () => {
    await reset()
    expect(await dibsSummaryJob(deps())).toMatchObject({ rows: 0 })
  })

  /**
   * ⚠️ The gate. A war summarised before its attacks land records real
   * conversions as "no swing" against named members — and once the raw claims
   * are pruned there is nothing left to correct it from. So it waits.
   */
  it('WAITS for a war whose attacks have not landed yet', async () => {
    await reset()
    await seedWar()
    await seedClaim({ target: 90100, until: WAR_START + 200, reason: 'spent' })
    // The newest stored attack predates the war's end, and no sync has run.
    await seedAttack({ defender: 90100, started: WAR_START + 150 })

    const res = await dibsSummaryJob(deps())
    expect(res.details).toMatchObject({ waiting: [WAR_ID], computed: [] })
    // ⚠️ No state row either: "not computed" must stay distinguishable from
    // "computed, nothing to show".
    const state = await stack.db.query('SELECT * FROM war_dibs_summary_state')
    expect(state.rows).toHaveLength(0)
  })

  it('computes once an attack newer than the war end exists', async () => {
    await reset()
    await seedWar()
    await seedClaim({ target: 90100, until: WAR_START + 200, reason: 'spent' })
    await seedAttack({ defender: 90100, started: WAR_START + 150 })
    // Coverage: something stored after the war ended.
    await seedAttack({ defender: 90999, started: WAR_END + 10 })

    const res = await dibsSummaryJob(deps())
    expect(res.details).toMatchObject({ computed: [WAR_ID] })
    expect(await summaryFor(HOLDER)).toMatchObject({ claims: 1, converted: 1, swung: 1 })
  })

  it('records the grace window and version that produced the numbers', async () => {
    const state = await stack.db.query('SELECT * FROM war_dibs_summary_state WHERE war_id = $1', [WAR_ID])
    // ⚠️ Stored WITH the numbers: if the grace window is ever retuned, two wars
    // computed under different values are not comparable, and a figure with no
    // record of its inputs cannot be defended to the member it describes.
    expect(state.rows[0]).toMatchObject({ claims_seen: 1, grace_seconds: 5, summary_version: 1 })
  })

  it('is idempotent — an already-summarised war is not looked at again', async () => {
    // ⚠️ The war does not reach the per-war loop at all: `warsNeedingSummary`
    // excludes it, so the job early-returns. That is the cheap path the hourly
    // cadence depends on — it reads one row and stops.
    const res = await dibsSummaryJob(deps())
    expect(res).toMatchObject({ rows: 0, details: { wars: 0 } })
    expect(await summaryFor(HOLDER)).toMatchObject({ claims: 1, converted: 1 })
  })

  /**
   * ⚠️ `war_id` on a claim is CLIENT-SUPPLIED and nullable — warRoomWrites
   * passes `body?.war_id ?? null`. A claim from a client that did not send it
   * would otherwise vanish from its own war's report.
   */
  it('picks up a claim with a NULL war_id by its timestamp', async () => {
    await reset()
    await seedWar()
    await seedClaim({ target: 90101, warId: null, at: WAR_START + 300, until: WAR_START + 400, reason: 'window' })
    await seedAttack({ defender: 90999, started: WAR_END + 10 })

    await dibsSummaryJob(deps())
    expect(await summaryFor(HOLDER)).toMatchObject({ claims: 1, no_swing: 1 })
  })

  it('ignores a NULL-war_id claim from outside the war window', async () => {
    await reset()
    await seedWar()
    await seedClaim({ target: 90102, warId: null, at: WAR_END + 5000, until: WAR_END + 5100, reason: 'window' })
    await seedAttack({ defender: 90999, started: WAR_END + 10 })

    await dibsSummaryJob(deps())
    expect(await summaryFor(HOLDER)).toBeNull()
  })

  it('tallies both sides of a steal, and gives the taker their own row', async () => {
    await reset()
    await seedWar()
    await seedClaim({ target: 90103, by: HOLDER, name: 'Holder', at: WAR_START + 100, until: WAR_START + 300, reason: 'spent' })
    await seedAttack({ attacker: MATE, name: 'Mate', defender: 90103, started: WAR_START + 200 })
    await seedAttack({ defender: 90999, started: WAR_END + 10 })

    await dibsSummaryJob(deps())
    expect(await summaryFor(HOLDER)).toMatchObject({ claims: 1, taken_from: 1, swung: 0 })
    // ⚠️ MATE claimed nothing, so without an explicit row for the taker the one
    // member the report exists to surface would be absent from it.
    expect(await summaryFor(MATE)).toMatchObject({ claims: 0, took_from_others: 1 })
  })

  it('a recompute REPLACES rather than merges', async () => {
    // Bump the stored version backwards so the job treats the war as stale.
    await stack.db.query('UPDATE war_dibs_summary_state SET summary_version = 0 WHERE war_id = $1', [WAR_ID])
    await dibsSummaryJob(deps())
    const rows = await stack.db.query('SELECT count(*)::int AS n FROM war_dibs_summary WHERE war_id = $1', [WAR_ID])
    // Two members, not four: a recompute under new rules must not leave rows
    // from the old pass behind.
    expect(rows.rows[0].n).toBe(2)
  })

  it('writes a state row for a war with no claims at all', async () => {
    await reset()
    await seedWar()
    await seedAttack({ defender: 90999, started: WAR_END + 10 })
    await dibsSummaryJob(deps())
    const state = await stack.db.query('SELECT * FROM war_dibs_summary_state WHERE war_id = $1', [WAR_ID])
    expect(state.rows[0]).toMatchObject({ claims_seen: 0 })
  })

  it('never summarises a war that has not ended', async () => {
    await reset()
    await seedWar(null)
    await seedClaim({ target: 90104, until: WAR_START + 200, reason: 'spent' })
    await seedAttack({ defender: 90999, started: WAR_END + 10 })
    const res = await dibsSummaryJob(deps())
    expect(res.details).toMatchObject({ wars: 0 })
  })
})
