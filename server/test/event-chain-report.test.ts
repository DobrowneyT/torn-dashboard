import { describe, expect, it } from 'vitest'
import {
  normaliseReport, reportHash, belongsToEvent, chainReportEnded, cappedRespectByMember,
  nextDelayMs, shouldSnapshot, CHAIN_END_MARGIN_MS, MAX_BACKOFF_MS,
} from '../src/events/eventChainReport.js'

// The shape Torn returned for forge's last chain (probed 2026-10-17).
const body = (over: Record<string, unknown> = {}) => ({
  chainreport: {
    id: 71547246, faction_id: 10739, start: 1792071066, end: 1792071653,
    details: { chain: 10, respect: 21.9, members: 1, targets: 10 },
    bonuses: [{ attacker_id: 3629708, defender_id: 52, chain: 10, respect: 10 }],
    attackers: [{ id: 3629708, respect: { total: 21.9, average: 1.32, best: 1.97 }, attacks: { total: 10 } }],
    non_attackers: [330505],
    ...over,
  },
})

describe('normaliseReport', () => {
  it('reads Torn\'s shape, times as ms', () => {
    const r = normaliseReport(body())
    expect(r.chainId).toBe(71547246)
    expect(r.factionId).toBe(10739)
    expect(r.startMs).toBe(1792071066000)
    expect(r.endMs).toBe(1792071653000)
    expect(r.attackers).toHaveLength(1)
    expect(r.nonAttackers).toEqual([330505])
  })

  it('treats an end of 0 as no end', () => {
    expect(normaliseReport(body({ end: 0 })).endMs).toBeNull()
  })

  it('⚠️ refuses a body without a faction id — the faction check depends on it', () => {
    expect(() => normaliseReport(body({ faction_id: undefined }))).toThrow(/faction id/)
    expect(() => normaliseReport({ error: { code: 9 } })).toThrow(/missing/)
  })
})

describe('reportHash', () => {
  it('is stable for the same report and changes with any member figure', () => {
    const a = normaliseReport(body())
    expect(reportHash(a)).toBe(reportHash(normaliseReport(body())))
    const b = normaliseReport(body({ attackers: [{ id: 3629708, respect: { total: 23 }, attacks: { total: 11 } }] }))
    expect(reportHash(b)).not.toBe(reportHash(a))
  })
})

describe('belongsToEvent', () => {
  const start = 1792071066000 + 3_600_000
  it('⚠️ ignores the faction\'s last ordinary chain from before the event', () => {
    expect(belongsToEvent(normaliseReport(body()), start)).toBe(false)
  })
  it('takes a running chain, even one started a minute early', () => {
    expect(belongsToEvent(normaliseReport(body({ end: 0 })), start)).toBe(true)
  })
  it('takes a chain that ended after the event opened', () => {
    expect(belongsToEvent(normaliseReport(body({ end: start / 1000 + 60 })), start)).toBe(true)
  })
})

describe('chainReportEnded', () => {
  const end = 1_800_000_000_000
  it('is over once polls run a margin past a fixed end', () => {
    expect(chainReportEnded(end, end + CHAIN_END_MARGIN_MS)).toBe(true)
  })
  it('⚠️ is NOT over when the end tracks the poll time (an unobserved running-chain shape)', () => {
    expect(chainReportEnded(end, end + 5_000)).toBe(false)
  })
  it('is not over with no end, or a projected end in the future', () => {
    expect(chainReportEnded(null, end)).toBe(false)
    expect(chainReportEnded(end + 300_000, end)).toBe(false)
  })
})

describe('cappedRespectByMember (#967 rule)', () => {
  it('raw minus Σ(bonus respect − 10)', () => {
    const m = cappedRespectByMember(
      [{ id: 1, respect: { total: 1000 } }, { id: 2, respect: { total: 50 } }],
      [{ attacker_id: 1, respect: 320 }, { attacker_id: 1, respect: 40 }, { attacker_id: 2, respect: 10 }],
    )
    expect(m.get('1')).toEqual({ raw: 1000, capped: 660, deduction: 340 })
    // A 10-respect bonus costs nothing.
    expect(m.get('2')).toEqual({ raw: 50, capped: 50, deduction: 0 })
  })
})

describe('nextDelayMs', () => {
  it('polls at the cadence while healthy', () => {
    expect(nextDelayMs(5_000, 0)).toBe(5_000)
  })
  it('⚠️ backs off during an outage, capped at a minute', () => {
    expect(nextDelayMs(5_000, 1)).toBe(10_000)
    expect(nextDelayMs(5_000, 3)).toBe(40_000)
    expect(nextDelayMs(5_000, 50)).toBe(MAX_BACKOFF_MS)
  })
})

describe('shouldSnapshot', () => {
  const base = { lastSnapshotAtMs: 1_000_000, lastChainId: 7, chainId: 7, ended: false, nowMs: 1_060_000, intervalMs: 300_000 }
  it('waits out the interval', () => {
    expect(shouldSnapshot(base)).toBe(false)
    expect(shouldSnapshot({ ...base, nowMs: 1_300_000 })).toBe(true)
  })
  it('always keeps the first, a new chain, and the end', () => {
    expect(shouldSnapshot({ ...base, lastSnapshotAtMs: null })).toBe(true)
    expect(shouldSnapshot({ ...base, chainId: 8 })).toBe(true)
    expect(shouldSnapshot({ ...base, ended: true })).toBe(true)
  })
})
