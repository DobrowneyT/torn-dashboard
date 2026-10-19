// #774's activity sampler, against a real Postgres.
//
// ⚠️ **This test exists because the bug only appears on the THIRD run.** The
// job reads back the latest sample per member to decide the take-off edge, so
// a departure has to have been written before the faulty read path is even
// reached: run 1 records a member at home, run 2 latches their departure, and
// run 3 is the first one that reads a non-null `travel_departed_at`. A test
// that ran the job once — or twice — passed while production threw every five
// minutes for two days.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { activitySampleJob } from '../src/scraper/jobs/activitySample.js'

let stack: TestStack
const ENCRYPTION_KEY = 'd'.repeat(64)
const KEY = 'ACTIVITYKEY00001'

function deps() {
  return {
    db: stack.db,
    pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
    client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
    encryptionKey: ENCRYPTION_KEY,
  }
}

/** Serve a one-member roster in the given state. */
function roster(state: string, description: string) {
  stack.torn.setPath('/v2/faction/members', {
    members: [{
      id: 5001,
      last_action: { timestamp: 1_759_000_000 },
      status: { state, description, plane_image_type: state === 'Traveling' ? 'plane' : null },
    }],
  })
}

beforeAll(async () => {
  stack = await startTestStack()
  // The key pool has an FK to members, so the key's owner has to exist.
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ('5001', 'Traveller', true)`)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('5001', KEY, { consentVersion: 'v2' })
  stack.torn.addKey(KEY, { id: '5001', factionId: TEST_FACTION.tornFactionId })
})

afterAll(async () => { await stack?.close() })

describe('activity-sample', () => {
  it('keeps the whole roster for the OC board (#1019)', async () => {
    roster('Hospital', 'In hospital')
    await activitySampleJob(deps())
    const snap = await stack.db.query(`SELECT payload FROM torn_live_snapshots WHERE kind = 'faction_members'`)
    expect(snap.rows[0].payload[0]).toMatchObject({ id: 5001, status: { state: 'Hospital' } })
  })

  it('keeps sampling after it has latched a departure', async () => {
    // Run 1 — at home. Nothing to carry.
    roster('Okay', 'Okay')
    await activitySampleJob(deps())

    // Run 2 — just took off. The previous reading is seconds old, so the edge
    // is believed and a departure is written.
    roster('Traveling', 'Traveling from Torn to UAE')
    await activitySampleJob(deps())

    const latched = await stack.db.query(
      `SELECT travel_departed_at FROM member_activity_samples
        WHERE member_id = '5001' ORDER BY sampled_at DESC LIMIT 1`)
    expect(latched.rows[0].travel_departed_at).not.toBeNull()

    // ⚠️ Run 3 — still in the air, and now the job READS BACK the departure it
    // wrote. This is the call that threw `RangeError: Invalid time value` in
    // production, because the timestamptz arrives as `...+00` (a bare
    // two-digit offset) and `new Date()` rejects it.
    await expect(activitySampleJob(deps())).resolves.toBeTruthy()

    // And the departure is CARRIED FORWARD, not re-stamped. Re-stamping would
    // reset the ETA every five minutes and a lead would wait forever.
    const rows = await stack.db.query(
      `SELECT extract(epoch from travel_departed_at) * 1000 AS ms
         FROM member_activity_samples
        WHERE member_id = '5001' AND travel_departed_at IS NOT NULL
        ORDER BY sampled_at`)
    expect(rows.rows).toHaveLength(2)
    expect(Number(rows.rows[1].ms)).toBe(Number(rows.rows[0].ms))
  })

  it('clears the departure once they land', async () => {
    roster('Okay', 'Okay')
    await activitySampleJob(deps())
    const last = await stack.db.query(
      `SELECT travel_departed_at FROM member_activity_samples
        WHERE member_id = '5001' ORDER BY sampled_at DESC LIMIT 1`)
    expect(last.rows[0].travel_departed_at).toBeNull()
  })

  it('records every member in one insert, so one member cannot cost the rest', async () => {
    // ⚠️ The blast radius that made the timestamp bug expensive: all 94 members
    // go in a single statement, so a value that cannot be rendered does not
    // spoil one row — it throws and loses the whole roster's sample.
    stack.torn.setPath('/v2/faction/members', {
      members: [
        { id: 6001, last_action: { timestamp: 1 }, status: { state: 'Okay' } },
        { id: 6002, last_action: { timestamp: 2 }, status: { state: 'Traveling', description: 'Traveling from Torn to UAE' } },
        { id: 6003, last_action: { timestamp: 3 }, status: { state: 'Abroad', description: 'In Switzerland' } },
      ],
    })
    const result = await activitySampleJob(deps())
    expect(result.rows).toBe(3)
    const n = await stack.db.query(
      `SELECT count(*) AS c FROM member_activity_samples WHERE member_id IN ('6001','6002','6003')`)
    expect(Number(n.rows[0].c)).toBe(3)
  })
})
