// Overdose latch (#357).
//
// Detection used to be a threshold test against the CURRENT drug cooldown, but
// the sweep overwrites that column on every pass — so a real overdose lost its
// flag the moment it burned below 10h, with nine hours still to run. The sweep
// now records when the overdose ends, once, and never shortens it.
//
// Sound because nothing in the game reduces drug cooldown, so the first reading
// above the threshold already tells us when it ends; and because a member
// cannot dose again while on one, so the cooldown's duration IS the window in
// which they are stuck.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { sweepMemberStats, OVERDOSE_DRUG_CD_SEC } from '../src/warRoomMemberStats.js'

let stack: TestStack
const MEMBER = 6601

/** Torn's response for one sweep. */
let payload: any = {}

const client = { async fetch() { return payload } }
const keys = [{ member_id: String(MEMBER), key: 'KEY' }]

function bars(drugSec: number | null) {
  return {
    bars: { energy: { current: 100, maximum: 150 } },
    cooldowns: { drug: drugSec, medical: 0, booster: 0 },
  }
}

async function sweep(drugSec: number | null) {
  payload = bars(drugSec)
  return sweepMemberStats(stack.db, client as any, keys as any)
}

async function overdoseUntil(): Promise<string | null> {
  const res = await stack.db.query(
    'SELECT overdose_until FROM war_room_member_stats_v2 WHERE member_id = $1', [MEMBER]
  )
  return res.rows[0]?.overdose_until ?? null
}

/** Seconds from now until the latched expiry. */
function secondsOut(stamp: string | null): number {
  const iso = String(stamp).replace(/([+-]\d{2})$/, '$1:00')
  return (Date.parse(iso) - Date.now()) / 1000
}

beforeAll(async () => { stack = await startTestStack() })
afterAll(async () => { await stack?.close() })

async function reset() {
  await stack.db.query('DELETE FROM war_room_member_stats_v2 WHERE member_id = $1', [MEMBER])
}

describe('overdose latch (#357)', () => {
  it('leaves it null for a normal xanax cooldown', async () => {
    // 6-8h is an ordinary dose. Only past 10h can it be an overdose.
    await reset()
    await sweep(8 * 3600)
    expect(await overdoseUntil()).toBeNull()
  })

  it('latches an expiry the first time a reading crosses the threshold', async () => {
    await reset()
    await sweep(40_000)
    const until = await overdoseUntil()
    expect(until).not.toBeNull()
    // Anchored to the reading: 40000s out, give or take the test's own runtime.
    expect(secondsOut(until)).toBeGreaterThan(40_000 - 30)
    expect(secondsOut(until)).toBeLessThan(40_000 + 30)
  })

  it('latches on a first sighting, not only on an update', async () => {
    // A member whose very first successful fetch already shows an overdose has
    // to be caught by the INSERT path too, or the flag waits for their next
    // reading — 30s at best, and never if the sweep is turned off.
    await reset()
    await sweep(50_000)
    expect(await overdoseUntil()).not.toBeNull()
  })

  it('HOLDS the expiry as the cooldown burns below the threshold', async () => {
    // The whole bug. The stored cooldown falls every sweep; the latch must not.
    await reset()
    await sweep(40_000)
    const latched = await overdoseUntil()

    await sweep(30_000)   // now under 10h
    await sweep(5_000)    // well under
    expect(await overdoseUntil()).toBe(latched)
  })

  it('never shortens the window', async () => {
    // GREATEST, not assignment: a later, smaller reading describes the same
    // overdose winding down, not a new shorter one.
    await reset()
    await sweep(60_000)
    const latched = await overdoseUntil()
    await sweep(37_000)   // still over the threshold, but sooner
    expect(await overdoseUntil()).toBe(latched)
  })

  it('extends the window for a fresh overdose', async () => {
    await reset()
    await sweep(37_000)
    const first = await overdoseUntil()
    await sweep(80_000)
    expect(secondsOut(await overdoseUntil())).toBeGreaterThan(secondsOut(first))
  })

  it('does not clear the latch when the member key fails', async () => {
    // A failed fetch writes null cooldowns. "We could not ask" must never read
    // as "recovered" — that is the same class of error as rendering a missing
    // reading as zero.
    await reset()
    await sweep(40_000)
    const latched = await overdoseUntil()

    payload = {}
    const failing = { async fetch() { throw new Error('Incorrect key') } }
    await sweepMemberStats(stack.db, failing as any, keys as any)

    expect(await overdoseUntil()).toBe(latched)
  })

  it('does not clear the latch when the cooldown reaches zero', async () => {
    // Expiry is decided by comparing the timestamp to now, not by wiping it —
    // so nothing here has to guess when to reset.
    await reset()
    await sweep(40_000)
    const latched = await overdoseUntil()
    await sweep(0)
    expect(await overdoseUntil()).toBe(latched)
  })

  it('uses the shared threshold rather than a second copy in SQL', async () => {
    // One constant, so the server and the client fallback cannot drift.
    expect(OVERDOSE_DRUG_CD_SEC).toBe(36_000)
    await reset()
    await sweep(OVERDOSE_DRUG_CD_SEC)          // exactly at the line: not an overdose
    expect(await overdoseUntil()).toBeNull()
    await sweep(OVERDOSE_DRUG_CD_SEC + 1)      // one second past it
    expect(await overdoseUntil()).not.toBeNull()
  })

  it('returns the latch on the broadcast row', async () => {
    // The delta protocol ships whole rows; missing from RETURNING would mean
    // the board never sees it.
    await reset()
    const changed: any[] = await sweep(40_000)
    expect(changed[0].overdose_until).toBeTruthy()
  })
})
