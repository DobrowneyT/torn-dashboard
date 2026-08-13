// #389 — observed OC occupancy. Seam: drive applyPoll against real templated
// Postgres and assert the stint transitions.
//
// The case this whole table exists for is a member MOVED between crimes before
// the first executes. Every previous attempt at time-spent inferred occupancy
// from Torn's joined_at plus a crime-level end time, and that case is where
// every inference has to be right simultaneously. It is tested first.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { applyPoll, observationsFrom } from '../src/scraper/jobs/crimeOccupancy.js'

let stack: TestStack

async function poll(crimes: unknown[], at: number) {
  const c = await stack.db.connect()
  try {
    return await applyPoll(c as any, crimes as any, at)
  } finally {
    c.release()
  }
}

async function stints(memberId: string) {
  const r = await stack.db.query(
    `SELECT crime_id, position_id, torn_joined_at, first_seen_at, last_seen_at, closed
       FROM crime_occupancy WHERE member_id = $1
      ORDER BY first_seen_at, crime_id`,
    [memberId]
  )
  return r.rows
}

/** A crime payload with the given occupants: [memberId, positionId, joinedAt]. */
const crime = (id: number, occupants: Array<[number, number, number | null]>) => ({
  id,
  slots: occupants.map(([user, position_id, joined_at]) => ({
    position_id,
    user: { id: user, joined_at },
  })),
})

beforeAll(async () => { stack = await startTestStack() }, 30000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  await stack.db.query('DELETE FROM crime_occupancy')
  await stack.db.query('DELETE FROM crime_occupancy_polls')
})

describe('the case this table exists for: moved between crimes (#389)', () => {
  it('credits both crimes, with no gap and no overlap', async () => {
    // Member 900 is in crime 1 from t=100, moved to crime 2 at t=300.
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(1, [[900, 11, 100]])], 200)
    // Both crimes visible; 900 has moved to crime 2, someone else took their seat.
    await poll([crime(1, [[901, 11, 300]]), crime(2, [[900, 21, 300]])], 300)
    await poll([crime(1, [[901, 11, 300]]), crime(2, [[900, 21, 300]])], 400)

    const rows = await stints('900')
    expect(rows).toHaveLength(2)

    // Crime 1: closed, last seen at 200 — the last poll that saw them there.
    expect(rows[0]).toMatchObject({
      crime_id: '1', first_seen_at: 100, last_seen_at: 200, closed: true,
    })
    // Crime 2: still open, running from 300.
    expect(rows[1]).toMatchObject({
      crime_id: '2', first_seen_at: 300, last_seen_at: 400, closed: false,
    })
  })

  it('keeps both stints when a member leaves a crime and rejoins the SAME one', async () => {
    // crime_participation_v2 cannot represent this: it is unique on
    // (crime_id, member_id), so the rejoin overwrites the first stint and the
    // earlier time is silently lost.
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(1, [])], 200)                    // gone
    await poll([crime(1, [[900, 11, 300]])], 300)      // back

    const rows = await stints('900')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ first_seen_at: 100, last_seen_at: 100, closed: true })
    expect(rows[1]).toMatchObject({ first_seen_at: 300, last_seen_at: 300, closed: false })
  })

  it('treats a move between slots in one crime as a new stint', async () => {
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(1, [[900, 22, 200]])], 200)

    const rows = await stints('900')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.position_id)).toEqual(['11', '22'])
    expect(rows[0].closed).toBe(true)
    expect(rows[1].closed).toBe(false)
  })
})

describe('a crime missing from the response is NOT a departure', () => {
  it('leaves stints open when the crime is simply absent', async () => {
    // The #330 mistake in its original form: confusing "we did not look" with
    // "nothing is there". Closing here would fabricate a departure and stamp
    // it with a time, which then reads as data rather than as a guess.
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(2, [[901, 21, 200]])], 200)   // crime 1 not in this page

    const rows = await stints('900')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ closed: false, last_seen_at: 100 })
  })

  it('closes only once the crime comes back WITHOUT the member', async () => {
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(2, [[901, 21, 200]])], 200)
    await poll([crime(1, [])], 300)

    const rows = await stints('900')
    expect(rows[0]).toMatchObject({ closed: true, last_seen_at: 100 })
  })

  it('does not close a crime that left `available` because it started executing', async () => {
    // The dominant real-world case now that the poll is cat=available: EVERY
    // crime drops out of the feed while still holding its occupants. If
    // absence closed stints, every member of every crime that ever runs would
    // get a fabricated departure at the moment the crime went to Planning ->
    // executing. Their stint must stay open, ending at the last real sighting.
    await poll([crime(1, [[900, 11, 100]]), crime(2, [[901, 21, 100]])], 100)
    await poll([crime(1, [[900, 11, 100]]), crime(2, [[901, 21, 100]])], 200)
    // Crime 2 executes and leaves the joinable set; crime 1 is still open.
    await poll([crime(1, [[900, 11, 100]])], 300)

    const stayed = await stints('901')
    expect(stayed).toHaveLength(1)
    expect(stayed[0]).toMatchObject({ closed: false, first_seen_at: 100, last_seen_at: 200 })
  })

  it('closes nothing at all on an empty response', async () => {
    await poll([crime(1, [[900, 11, 100]])], 100)
    const res = await poll([], 200)
    expect(res.closed).toBe(0)
    expect((await stints('900'))[0].closed).toBe(false)
  })
})

describe('stint bookkeeping', () => {
  it('extends rather than duplicating while the member stays put', async () => {
    for (const t of [100, 200, 300, 400]) await poll([crime(1, [[900, 11, 100]])], t)
    const rows = await stints('900')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ first_seen_at: 100, last_seen_at: 400, closed: false })
  })

  it("keeps Torn's joined_at as the authoritative start, and does not overwrite it", async () => {
    // joined_at is exact and free; first_seen_at is only as good as the poll
    // interval. Keeping both lets the payout use the exact start AND lets us
    // check the poller against Torn — MonChoon expects them within ~2 minutes.
    await poll([crime(1, [[900, 11, 95]])], 100)
    await poll([crime(1, [[900, 11, 999]])], 200)  // a later, wrong-looking value
    const rows = await stints('900')
    expect(rows[0].torn_joined_at).toBe(95)
  })

  it('fills in a joined_at that arrives late', async () => {
    await poll([crime(1, [[900, 11, null]])], 100)
    await poll([crime(1, [[900, 11, 95]])], 200)
    expect((await stints('900'))[0].torn_joined_at).toBe(95)
  })

  it('ignores empty slots', async () => {
    await poll([{ id: 1, slots: [{ position_id: 11, user: null }, { position_id: 12 }] }], 100)
    expect(await stints('900')).toHaveLength(0)
  })

  it('tracks several members in one crime independently', async () => {
    await poll([crime(1, [[900, 11, 100], [901, 12, 100]])], 100)
    await poll([crime(1, [[901, 12, 100]])], 200)   // 900 left, 901 stayed
    expect((await stints('900'))[0]).toMatchObject({ closed: true, last_seen_at: 100 })
    expect((await stints('901'))[0]).toMatchObject({ closed: false, last_seen_at: 200 })
  })
})

describe('poll heartbeat', () => {
  it('records every poll so a payout window can report its gaps', async () => {
    // Without this, an outage silently over-credits anyone who left during it.
    // The over-count is bounded by the gap and acceptable — but only if the
    // payout page can say the hole is there.
    await poll([crime(1, [[900, 11, 100]])], 100)
    await poll([crime(1, [])], 160)

    const r = await stack.db.query(
      'SELECT polled_at, crimes_seen, slots_seen, opened, closed FROM crime_occupancy_polls ORDER BY polled_at'
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0]).toMatchObject({ crimes_seen: 1, slots_seen: 1, opened: 1, closed: 0 })
    expect(r.rows[1]).toMatchObject({ crimes_seen: 1, slots_seen: 0, opened: 0, closed: 1 })
  })

  it('records a poll that saw nothing, so an empty page is distinguishable from an outage', async () => {
    await poll([], 100)
    const r = await stack.db.query('SELECT crimes_seen FROM crime_occupancy_polls')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].crimes_seen).toBe(0)
  })
})

describe('observationsFrom', () => {
  it('flattens crimes to occupied (crime, member, slot) triples', () => {
    expect(observationsFrom([crime(1, [[900, 11, 100]]), crime(2, [[901, 21, 200]])] as any)).toEqual([
      { crimeId: '1', memberId: '900', positionId: '11', tornJoinedAt: 100 },
      { crimeId: '2', memberId: '901', positionId: '21', tornJoinedAt: 200 },
    ])
  })

  it('tolerates a crime with no slots array', () => {
    expect(observationsFrom([{ id: 1 }] as any)).toEqual([])
  })
})
