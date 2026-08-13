// Payout time from observed occupancy (#389 part 2).
//
// These numbers become money, and the whole point of the poller is that the
// previous four attempts produced confident wrong answers. So the tests lean
// hard on the cases where being wrong is silent: partial coverage, open
// stints, and a member moved between crimes.
import { describe, it, expect } from 'vitest'
import {
  stintInterval,
  occupancySecondsByMember,
  pollCoverage,
  joinedAtDrift,
  POLL_INTERVAL_SECONDS,
  MAX_ACCEPTABLE_GAP_SECONDS,
} from '../occupancyTime'

const HOUR = 3600
const FROM = 1_000_000
const TO = FROM + 7 * 86400

const stint = (member_id, first_seen_at, last_seen_at, extra = {}) => ({
  member_id, first_seen_at, last_seen_at, closed: true, ...extra,
})

describe('stintInterval', () => {
  it("prefers Torn's exact joined_at over our first sighting", () => {
    // first_seen_at is only as good as the poll interval; joined_at is exact.
    expect(stintInterval(stint('1', 1050, 2000, { torn_joined_at: 1000 }))).toEqual([1000, 2000])
  })

  it('falls back to our first sighting when Torn gave none', () => {
    expect(stintInterval(stint('1', 1050, 2000, { torn_joined_at: null }))).toEqual([1050, 2000])
  })

  it('ends at the last sighting, never later', () => {
    // Torn has no departure field, so this is the only answer we have — and it
    // is a lower bound. Rounding an open stint up to "now" would invent time.
    expect(stintInterval({ ...stint('1', 1000, 2000), closed: false })).toEqual([1000, 2000])
  })

  it('ignores a joined_at that postdates the last sighting', () => {
    // Contradictory data. The observation is the one we can defend.
    expect(stintInterval(stint('1', 1000, 2000, { torn_joined_at: 5000 }))).toEqual([1000, 2000])
  })

  it('returns null rather than NaN on unusable rows', () => {
    expect(stintInterval({ member_id: '1', first_seen_at: null, last_seen_at: null })).toBeNull()
  })
})

describe('occupancySecondsByMember', () => {
  it('credits a member moved between crimes for both, with no gap or overlap', () => {
    // The case #389 exists for. Crime A for 2h, then crime B for 3h.
    const result = occupancySecondsByMember([
      stint('1', FROM, FROM + 2 * HOUR),
      stint('1', FROM + 2 * HOUR, FROM + 5 * HOUR),
    ], FROM, TO)
    expect(result['1'].seconds).toBe(5 * HOUR)
  })

  it('unions overlapping stints rather than summing them', () => {
    // #262's invariant. A member can only be in one OC at a time, so an
    // overlap is the same wall-clock time recorded twice — summing it is how
    // totals used to exceed the payout window.
    const result = occupancySecondsByMember([
      stint('1', FROM, FROM + 3 * HOUR),
      stint('1', FROM + HOUR, FROM + 2 * HOUR),
    ], FROM, TO)
    expect(result['1'].seconds).toBe(3 * HOUR)
  })

  it('clips to the window at both ends', () => {
    const result = occupancySecondsByMember(
      [stint('1', FROM - 5 * HOUR, TO + 5 * HOUR)], FROM, TO
    )
    expect(result['1'].seconds).toBe(TO - FROM)
  })

  it('can never exceed the window', () => {
    const result = occupancySecondsByMember([
      stint('1', FROM - 100 * HOUR, TO + 100 * HOUR),
      stint('1', FROM, TO),
      stint('1', FROM + HOUR, FROM + 2 * HOUR),
    ], FROM, TO)
    expect(result['1'].seconds).toBeLessThanOrEqual(TO - FROM)
  })

  it('drops stints entirely outside the window', () => {
    expect(occupancySecondsByMember([stint('1', FROM - 10 * HOUR, FROM - HOUR)], FROM, TO)).toEqual({})
  })

  it('keeps members separate', () => {
    const result = occupancySecondsByMember([
      stint('1', FROM, FROM + HOUR),
      stint('2', FROM, FROM + 2 * HOUR),
    ], FROM, TO)
    expect(result['1'].seconds).toBe(HOUR)
    expect(result['2'].seconds).toBe(2 * HOUR)
  })

  it('handles no stints at all', () => {
    expect(occupancySecondsByMember([], FROM, TO)).toEqual({})
    expect(occupancySecondsByMember(null, FROM, TO)).toEqual({})
  })
})

describe('pollCoverage', () => {
  const every = (from, to, step = POLL_INTERVAL_SECONDS) => {
    const out = []
    for (let t = from; t <= to; t += step) out.push({ polled_at: t })
    return out
  }

  it('reports a fully polled window as covered', () => {
    const short = FROM + 10 * POLL_INTERVAL_SECONDS
    expect(pollCoverage(every(FROM, short), FROM, short).covered).toBe(true)
  })

  it('is NOT covered when there are no polls at all', () => {
    // The state every window is in before the poller ships. It must read as
    // "unwatched", not as "nobody moved".
    const c = pollCoverage([], FROM, TO)
    expect(c.covered).toBe(false)
    expect(c.gaps).toEqual([[FROM, TO]])
    expect(c.missingSeconds).toBe(TO - FROM)
  })

  it('finds a hole in the middle and measures it', () => {
    const short = FROM + 20 * POLL_INTERVAL_SECONDS
    const polls = every(FROM, short).filter(
      (p) => p.polled_at < FROM + 5 * POLL_INTERVAL_SECONDS || p.polled_at > FROM + 12 * POLL_INTERVAL_SECONDS
    )
    const c = pollCoverage(polls, FROM, short)
    expect(c.covered).toBe(false)
    expect(c.gaps).toHaveLength(1)
    expect(c.missingSeconds).toBe(9 * POLL_INTERVAL_SECONDS)  // poll 4 → poll 13
  })

  it('counts a poller that started midway as an uncovered leading edge', () => {
    // Not a lesser problem than an outage: the first half was never watched.
    const short = FROM + 20 * POLL_INTERVAL_SECONDS
    const c = pollCoverage(every(FROM + 10 * POLL_INTERVAL_SECONDS, short), FROM, short)
    expect(c.covered).toBe(false)
    expect(c.gaps[0][0]).toBe(FROM)
  })

  it('counts a poller that stopped early as an uncovered trailing edge', () => {
    const short = FROM + 20 * POLL_INTERVAL_SECONDS
    const c = pollCoverage(every(FROM, FROM + 10 * POLL_INTERVAL_SECONDS), FROM, short)
    expect(c.covered).toBe(false)
    expect(c.gaps[c.gaps.length - 1][1]).toBe(short)
  })

  it('tolerates ordinary jitter rather than crying wolf', () => {
    // One late tick is load, not an outage. A warning that fires on every
    // window is one people learn to scroll past, which is worse than none.
    const short = FROM + 10 * POLL_INTERVAL_SECONDS
    const polls = every(FROM, short).filter((p) => p.polled_at !== FROM + 5 * POLL_INTERVAL_SECONDS)
    expect(pollCoverage(polls, FROM, short).covered).toBe(true)
    expect(MAX_ACCEPTABLE_GAP_SECONDS).toBe(3 * POLL_INTERVAL_SECONDS)
  })

  it('accepts bare timestamps as well as rows', () => {
    const short = FROM + 5 * POLL_INTERVAL_SECONDS
    const bare = every(FROM, short).map((p) => p.polled_at)
    expect(pollCoverage(bare, FROM, short).covered).toBe(true)
  })
})

describe('joinedAtDrift', () => {
  it('measures how far our first sighting lags Torn', () => {
    const d = joinedAtDrift([
      stint('1', 1030, 2000, { torn_joined_at: 1000 }),
      stint('2', 1045, 2000, { torn_joined_at: 1000 }),
      stint('3', 1060, 2000, { torn_joined_at: 1000 }),
    ])
    expect(d.count).toBe(3)
    expect(d.max).toBe(60)
    expect(d.withinTolerance).toBe(true)
  })

  it('fails tolerance when the poller is missing ticks', () => {
    // The signal that stints are ending too late — which is the failure mode
    // that quietly over-credits. Better to know before trusting it with money.
    const d = joinedAtDrift(
      Array.from({ length: 20 }, (_, i) => stint(String(i), 1000 + 600, 2000, { torn_joined_at: 1000 }))
    )
    expect(d.withinTolerance).toBe(false)
    expect(d.p95).toBe(600)
  })

  it('excludes stints that began before the poller existed', () => {
    // A stint already running at startup reports a meaningless delta; counting
    // it would make a healthy poller look broken forever after a restart.
    const d = joinedAtDrift([
      stint('1', 1_000_000, 1_100_000, { torn_joined_at: 1 }),
      stint('2', 1030, 2000, { torn_joined_at: 1000 }),
    ])
    expect(d.count).toBe(1)
    expect(d.max).toBe(30)
  })

  it('reports nothing rather than a perfect score when there is nothing to compare', () => {
    // Returning 0 drift for an empty set would read as "the poller is exact".
    const d = joinedAtDrift([stint('1', 1000, 2000, { torn_joined_at: null })])
    expect(d.count).toBe(0)
    expect(d.withinTolerance).toBeNull()
  })
})
