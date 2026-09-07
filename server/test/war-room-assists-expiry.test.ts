// Assist-request auto-expiry (#523). Unlike war-room-dibs-expiry.test.ts this
// drives snapshotAssistedStatus/sweepAssistsExpiry directly against real
// templated Postgres rather than through the full ticker — the module has no
// dependency on the Torn fixture or the key pool, only on the two tables it
// reads and writes, so the lighter seam is the honest one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { snapshotAssistedStatus, sweepAssistsExpiry, ASSIST_EXPIRY_SECONDS } from '../src/warRoomAssistsExpiry.js'

let stack: TestStack
const TARGET = 90940
const REQUESTER = 1900

async function setTargetStatus(status: Record<string, unknown> | null) {
  await stack.db.query(
    `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
     VALUES ($1, 90941, 'Foe', 50, $2)
     ON CONFLICT (member_id) DO UPDATE SET state = EXCLUDED.state, deleted_at = NULL, updated_at = now()`,
    [TARGET, JSON.stringify({ status })]
  )
}

/**
 * Raise one request on TARGET.
 *
 * ⚠️ #617 moved the deadline off the row: there is no per-request
 * `auto_expire_at` any more, only a `*_raised_at` per kind that the sweep
 * measures against the configured window. So the old `autoExpireInSec`
 * argument becomes its mirror image — how long AGO the hand went up — and
 * "already lapsed" is expressed by backdating the raise rather than by
 * writing a deadline in the past.
 */
async function seedAssist(kind = 'smoke', raisedSecondsAgo = 0) {
  await stack.db.query(`DELETE FROM war_room_assist_counts_v2 WHERE target_id = ${TARGET}`)
  await stack.db.query(
    `INSERT INTO war_room_assist_counts_v2 (target_id, ${kind}_wanted, ${kind}_raised_at)
     VALUES ($1, 1, now() - make_interval(secs => $2::int))`,
    [TARGET, raisedSecondsAgo]
  )
}

/** What is still wanted on TARGET, across kinds. */
async function stillWanted(): Promise<number> {
  const r = await stack.db.query(
    `SELECT help_wanted + smoke_wanted + tear_wanted AS n
       FROM war_room_assist_counts_v2 WHERE target_id = ${TARGET}`
  )
  return Number(r.rows[0]?.n ?? 0)
}

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

// #591: the default was 120s, chosen on the reasoning recorded in
// warRoomAssistsExpiry.ts that "Torn fights are seconds, not minutes". Torn
// fights actually run to FIVE MINUTES, and a captured fight log shows a real
// one already 132 seconds old — twelve seconds past the point where the request
// had silently vanished. The hand goes down while the fight is still on.
describe('the expiry window (#591)', () => {
  it('⚠️ defaults to a full Torn fight, not two minutes — a max-length fight outlived its own request under the old 120s', () => {
    expect(ASSIST_EXPIRY_SECONDS).toBeGreaterThanOrEqual(300)
  })

  it('is configurable, and the caller\'s value wins over the default', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    // Armed 200s ago. Still live under a 300s window, expired under a 120s one.
    await seedAssist('smoke', -200 + 300)
    const prev = await snapshotAssistedStatus(stack.db)
    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
  })
})

// A target who is in jail, travelling or abroad is exactly as unattackable as
// one in hospital, so the request is exactly as meaningless — but only Hospital
// used to end it, leaving the rest to sit out the full window.
describe('a fight ends when the target stops being attackable (#591)', () => {
  for (const state of ['Hospital', 'Jail', 'Traveling', 'Abroad', 'Fallen']) {
    it(`drops the assist when the target goes to ${state}`, async () => {
      await setTargetStatus({ state: 'Okay', until: null })
      await seedAssist()
      const prev = await snapshotAssistedStatus(stack.db)
      await setTargetStatus({ state, until: 1_800_000_000 })
      const expired = await sweepAssistsExpiry(stack.db, prev)
      expect(expired.some((r: any) => Number(r.target_id) === TARGET), state).toBe(true)
    })
  }

  it('⚠️ does NOT drop one raised while the target was ALREADY unattackable — that is not a fight ENDING, and the request keeps its own timeout', async () => {
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })
    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
  })

  it('leaves it alone while the target is still Okay', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })
    expect(await sweepAssistsExpiry(stack.db, prev)).toHaveLength(0)
  })
})

describe('assist-request auto-expiry', () => {
  it('leaves a fresh assist alone: unexpired deadline, target still Okay', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })
    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
    expect(await stillWanted()).toBe(1)
  })

  it('drops the assist the instant the target goes into hospital — the fight ended', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired.some((r: any) => Number(r.target_id) === TARGET)).toBe(true)
    expect(await stillWanted()).toBe(0)
  })

  it('does not treat an assist raised while already hospitalised as a fresh fight-end', async () => {
    // Two consecutive ticks both see Hospital — no transition, so the
    // short-timeout backstop is what governs this row, not the fight-end rule.
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_000 })
    await seedAssist()
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Hospital', until: 1_800_000_100 })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
    expect(await stillWanted()).toBe(1)
  })

  it('drops the assist once the short timeout lapses, regardless of target status', async () => {
    await setTargetStatus({ state: 'Okay', until: null })
    await seedAssist('help', ASSIST_EXPIRY_SECONDS + 60) // raised long enough ago to have lapsed
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired.some((r: any) => Number(r.target_id) === TARGET && Number(r.help_wanted) === 0)).toBe(true)
  })

  it('⚠️ leaves a count with no raised_at alone on the timeout path', async () => {
    // Not hypothetical: 0059's backfill sums the old per-requester rows into a
    // count without inventing a raise time for it, so every row carried over
    // from #523 starts life in exactly this state. Expiring on a NULL
    // timestamp would wipe them all on the first tick after the migration.
    await setTargetStatus({ state: 'Okay', until: null })
    await stack.db.query(`DELETE FROM war_room_assist_counts_v2 WHERE target_id = ${TARGET}`)
    await stack.db.query(
      `INSERT INTO war_room_assist_counts_v2 (target_id, tear_wanted, tear_raised_at)
       VALUES (${TARGET}, 1, NULL)`
    )
    const prev = await snapshotAssistedStatus(stack.db)
    await setTargetStatus({ state: 'Okay', until: null })

    const expired = await sweepAssistsExpiry(stack.db, prev)
    expect(expired).toHaveLength(0)
    expect(await stillWanted()).toBe(1)
  })
})
