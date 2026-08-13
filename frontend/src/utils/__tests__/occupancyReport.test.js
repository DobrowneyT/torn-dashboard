// #389 — the judgement layer between raw occupancy diagnostics and the page.
//
// These tests are mostly about what the module REFUSES to say. The observation
// period this panel serves is the evidence MonChoon will decide on, so a panel
// that flatters the data is worse than no panel.
import { describe, expect, it } from 'vitest'
import {
  coverageVerdict,
  driftVerdict,
  memberDivergences,
  occupancySummary,
  formatDuration,
  formatDelta,
  DIVERGENCE_FLOOR_SECONDS,
} from '../occupancyReport'

const WEEK_START = 1_754_000_000
const WEEK_END = WEEK_START + 7 * 86400

describe('coverageVerdict', () => {
  it('separates "no coverage data" from "coverage says we never polled"', () => {
    // The #330 distinction, and the reason this returns a state rather than a
    // boolean. A saved payout from before the poller existed makes no claim
    // about occupancy; a live window with zero polls makes a very specific one.
    expect(coverageVerdict(null, WEEK_START, WEEK_END).state).toBe('unavailable')

    const never = coverageVerdict(
      { covered: false, gaps: [[WEEK_START, WEEK_END]], pollCount: 0, missingSeconds: 7 * 86400 },
      WEEK_START,
      WEEK_END
    )
    expect(never.state).toBe('unwatched')
    expect(never.missingFraction).toBe(1)
  })

  it('reads a continuously polled window as watched', () => {
    const v = coverageVerdict(
      { covered: true, gaps: [], pollCount: 10080, missingSeconds: 0 },
      WEEK_START,
      WEEK_END
    )
    expect(v.state).toBe('watched')
    expect(v.expectedPolls).toBe(10080)
  })

  it('calls a real outage degraded, and reports how much was missed', () => {
    const gap = [WEEK_START + 86400, WEEK_START + 86400 + 4 * 3600]
    const v = coverageVerdict(
      { covered: false, gaps: [gap], pollCount: 9800, missingSeconds: 4 * 3600 },
      WEEK_START,
      WEEK_END
    )
    expect(v.state).toBe('degraded')
    expect(v.missingSeconds).toBe(4 * 3600)
    expect(v.gaps).toEqual([gap])
  })

  it('does not cry outage over a couple of late ticks', () => {
    // `covered` goes false on any gap over the 3-poll tolerance, including a
    // single 4-minute hiccup. Escalating that to the same warning as a
    // four-hour hole would train the reader to scroll past both.
    const v = coverageVerdict(
      { covered: false, gaps: [[WEEK_START + 100, WEEK_START + 340]], pollCount: 10070, missingSeconds: 240 },
      WEEK_START,
      WEEK_END
    )
    expect(v.state).toBe('watched')
    expect(v.missingSeconds).toBe(240)
    // Still admitted, just not escalated.
    expect(v.minorGaps).toBe(1)
  })

  it('escalates one long gap even when it is a tiny share of the window', () => {
    // 20 minutes is 0.2% of a week — under the fraction test, and still ample
    // for a member to join a crime, leave, and have the whole stint credited to
    // the resume. The per-gap test is what catches it.
    const v = coverageVerdict(
      { covered: false, gaps: [[WEEK_START, WEEK_START + 20 * 60]], pollCount: 10060, missingSeconds: 20 * 60 },
      WEEK_START,
      WEEK_END
    )
    expect(v.state).toBe('degraded')
    expect(v.longestGap).toBe(20 * 60)
  })

  it('escalates death by a thousand cuts', () => {
    // Twelve separate 10-minute gaps: none individually significant, together
    // two hours of the week unwatched. The fraction test is what catches this
    // one, which is why both tests exist.
    const gaps = Array.from({ length: 12 }, (_, i) => [
      WEEK_START + i * 3600,
      WEEK_START + i * 3600 + 600,
    ])
    const v = coverageVerdict(
      { covered: false, gaps, pollCount: 9960, missingSeconds: 12 * 600 },
      WEEK_START,
      WEEK_END
    )
    expect(v.state).toBe('degraded')
    expect(v.longestGap).toBeLessThan(15 * 60)
  })

  it('survives a zero-length window without dividing by it', () => {
    const v = coverageVerdict({ covered: true, gaps: [], pollCount: 1, missingSeconds: 0 }, WEEK_START, WEEK_START)
    expect(Number.isFinite(v.missingFraction)).toBe(true)
    expect(v.expectedPolls).toBe(0)
  })
})

describe('driftVerdict', () => {
  it('reports "no evidence" rather than passing a poller nothing has tested', () => {
    // A freshly started poller has witnessed no joins. Reporting that as ok
    // would put a green tick on a claim nothing has checked.
    expect(driftVerdict({ count: 0, median: null, p95: null, max: null, withinTolerance: null }).state)
      .toBe('no-evidence')
    expect(driftVerdict(undefined).state).toBe('no-evidence')
  })

  it('passes a poller agreeing with Torn inside two minutes', () => {
    const v = driftVerdict({ count: 340, median: 28, p95: 61, max: 190, withinTolerance: true })
    expect(v.state).toBe('ok')
    expect(v.p95).toBe(61)
  })

  it('fails one that is falling behind', () => {
    expect(driftVerdict({ count: 340, median: 90, p95: 400, max: 900, withinTolerance: false }).state)
      .toBe('drifting')
  })
})

describe('memberDivergences', () => {
  const members = [
    { userId: 1, name: 'Over',   timeSpent: 604800, observedSeconds: 21600 },
    { userId: 2, name: 'Close',  timeSpent: 100000, observedSeconds: 100600 },
    { userId: 3, name: 'Under',  timeSpent: 3600,   observedSeconds: 90000 },
  ]

  it('ranks by size of disagreement and names its direction', () => {
    const rows = memberDivergences(members)
    expect(rows.map((r) => r.userId)).toEqual([1, 3])
    expect(rows[0].direction).toBe('over-inferred')
    expect(rows[1].direction).toBe('under-observed')
  })

  it('stays quiet about members who agree within the poll error bar', () => {
    // Member 2 differs by 10 minutes over a week. Listing them would bury the
    // 28x disagreement this list exists to surface.
    expect(memberDivergences(members).some((r) => r.userId === 2)).toBe(false)
    expect(DIVERGENCE_FLOOR_SECONDS).toBeGreaterThan(600)
  })

  it('skips members with no observation rather than scoring them as zero', () => {
    // ⚠️ The trap. A saved payout's members have no observedSeconds at all.
    // Number(undefined) is NaN but `?? 0` would make it a 0, and every member
    // of every historical payout would show a total divergence.
    const saved = [{ userId: 9, name: 'Saved', timeSpent: 400000 }]
    expect(memberDivergences(saved)).toEqual([])
    expect(memberDivergences([{ userId: 9, timeSpent: 400000, observedSeconds: null }])).toEqual([])
  })

  it('does report a genuine observed zero', () => {
    // Distinct from the case above: this member WAS watched, all window, and
    // never appeared in a crime. That is a real finding, not missing data.
    const rows = memberDivergences([{ userId: 4, name: 'Absent', timeSpent: 200000, observedSeconds: 0 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].direction).toBe('over-inferred')
  })

  it('handles an empty or missing member list', () => {
    expect(memberDivergences([])).toEqual([])
    expect(memberDivergences(undefined)).toEqual([])
  })
})

describe('occupancySummary', () => {
  it('totals only the members that can actually be compared', () => {
    const s = occupancySummary([
      { timeSpent: 100, observedSeconds: 50 },
      { timeSpent: 900 },                       // saved week, no observation
      { timeSpent: 300, observedSeconds: 250 },
    ])
    expect(s.memberCount).toBe(2)
    expect(s.inferred).toBe(400)
    expect(s.observed).toBe(300)
    expect(s.delta).toBe(-100)
    expect(s.ratio).toBeCloseTo(0.75)
  })

  it('returns null when nothing is comparable, not a zeroed summary', () => {
    // A zeroed summary renders as "0h vs 0h — perfect agreement", which is the
    // single most misleading thing this panel could say.
    expect(occupancySummary([{ timeSpent: 900 }])).toBeNull()
    expect(occupancySummary([])).toBeNull()
  })

  it('leaves the ratio null when nothing was inferred', () => {
    const s = occupancySummary([{ timeSpent: 0, observedSeconds: 500 }])
    expect(s.ratio).toBeNull()
    expect(s.delta).toBe(500)
  })
})

describe('formatting', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(600)).toBe('10m')
    expect(formatDuration(4 * 3600)).toBe('4h')
    expect(formatDuration(4 * 3600 + 720)).toBe('4h 12m')
    expect(formatDuration(2 * 86400)).toBe('2d')
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2d 3h')
  })

  it('never renders a negative duration', () => {
    expect(formatDuration(-500)).toBe('0s')
    expect(formatDuration(null)).toBe('0s')
  })

  it('signs a delta so the direction survives the formatting', () => {
    expect(formatDelta(3600)).toBe('+1.0h')
    expect(formatDelta(-3600)).toBe('−1.0h')
    expect(formatDelta(0)).toBe('0h')
  })
})
