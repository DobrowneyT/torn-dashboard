import { describe, it, expect } from 'vitest'
import {
  buildMemberRow, classifyRow, summarizeCompliance, pickOldestInWindow,
} from '../memberMetrics.js'

const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400_000))
const NOW_S = Math.floor(Date.now() / 1000)

// A member's snapshots are newest-first. Minimal shape the util reads.
const snap = (dateIso, xanax, extra = {}) => ({
  snapshot_date: dateIso,
  personalstats: xanax == null ? {} : { drugs: { xanax } },
  is_donator: true,
  property_name: 'Private Island',
  last_action_timestamp: NOW_S,
  ...extra,
})

const member = { member_id: '1', member_name: 'A', tier: 3 }

describe('buildMemberRow', () => {
  it('computes the per-day rate over the days actually covered', () => {
    const snaps = [snap(daysAgo(0), 130, { gym_energy: 7000 }), snap(daysAgo(7), 100, { gym_energy: 0 })]
    const row = buildMemberRow(member, snaps, 7)
    expect(row.days_covered).toBe(7)
    expect(row.xantaken_delta).toBe(30)
    expect(row.xantaken_perday).toBeCloseTo(30 / 7, 5)
    expect(row.gym_energy_delta).toBe(7000)
    expect(row.gym_energy_perday).toBeCloseTo(1000, 5)
    expect(row.data_complete).toBe(true)
  })

  it('divides by covered days (not the window) and flags partial coverage', () => {
    // Only 7 days of data available inside a 30-day window.
    const snaps = [snap(daysAgo(0), 130), snap(daysAgo(7), 100)]
    const row = buildMemberRow(member, snaps, 30)
    expect(row.days_covered).toBe(7)
    expect(row.xantaken_perday).toBeCloseTo(30 / 7, 5) // rate over 7d, not /30
    expect(row.data_partial).toBe(true)
    expect(row.data_complete).toBe(false)
  })

  it('marks a single snapshot as missing-data (no delta) and no snapshots as no_data', () => {
    const one = buildMemberRow(member, [snap(daysAgo(0), 130)], 30)
    expect(one.data_missing).toBe(true)
    expect(one.no_data).toBe(false)
    expect(one.xantaken_perday).toBeNull()

    const none = buildMemberRow(member, [], 30)
    expect(none.no_data).toBe(true)
    expect(none.data_missing).toBe(true)
  })
})

describe('pickOldestInWindow', () => {
  it('returns the very oldest snapshot for the All window (days = null)', () => {
    const snaps = [snap(daysAgo(0), 5), snap(daysAgo(100), 3), snap(daysAgo(300), 1)]
    expect(pickOldestInWindow(snaps, null)).toBe(snaps[2])
  })
})

describe('classifyRow — inconclusive is never a silent pass', () => {
  const opts = { nowMs: Date.now() }

  it('flags a stat that is present and below threshold (red)', () => {
    const row = buildMemberRow(member, [snap(daysAgo(0), 130), snap(daysAgo(7), 100)], 7)
    const c = classifyRow(row, { xantaken: 5 }, opts) // 30/7 ≈ 4.28 < 5
    expect(c.threshold_failures).toEqual(new Set(['xantaken']))
    expect(c.compliance_status).toBe('flagged')
  })

  it('marks a thresholded stat with no data as inconclusive, not passing', () => {
    // rankedwarhits has no values in the snapshots → per-day is null.
    const row = buildMemberRow(member, [snap(daysAgo(0), 130), snap(daysAgo(7), 100)], 7)
    const c = classifyRow(row, { rankedwarhits: 1 }, opts)
    expect(c.threshold_failures).toBeNull()
    expect(c.threshold_inconclusive).toEqual(new Set(['rankedwarhits']))
    expect(c.compliance_status).toBe('inconclusive')
  })

  it('treats a member with no snapshots at all as inconclusive even without thresholds', () => {
    const row = buildMemberRow(member, [], 30)
    expect(classifyRow(row, null, opts).compliance_status).toBe('inconclusive')
  })

  it('passes cleanly when the stat has data and meets the bar', () => {
    const row = buildMemberRow(member, [snap(daysAgo(0), 130), snap(daysAgo(7), 100)], 7)
    expect(classifyRow(row, { xantaken: 3 }, opts).compliance_status).toBe('ok') // 4.28 ≥ 3
  })

  it('lets a confirmed problem (non-donator) win over inconclusive', () => {
    const snaps = [snap(daysAgo(0), 130, { is_donator: false }), snap(daysAgo(7), 100)]
    const row = buildMemberRow(member, snaps, 7)
    const c = classifyRow(row, { rankedwarhits: 1 }, opts) // would be inconclusive alone
    expect(c.compliance_status).toBe('flagged')
  })
})

describe('summarizeCompliance — flagged and inconclusive are separate buckets', () => {
  it('counts confirmed problems apart from cannot-assess', () => {
    const ok = buildMemberRow(member, [snap(daysAgo(0), 130), snap(daysAgo(7), 100)], 7)
    const noData = buildMemberRow({ ...member, member_id: '2' }, [], 30)
    const bad = buildMemberRow(
      { ...member, member_id: '3' },
      [snap(daysAgo(0), 130, { is_donator: false }), snap(daysAgo(7), 100)], 7
    )
    const opts = { nowMs: Date.now() }
    const rows = [ok, noData, bad].map((r) => ({ ...r, ...classifyRow(r, { xantaken: 3 }, opts) }))
    const s = summarizeCompliance(rows, opts)
    expect(s).toMatchObject({ total: 3, flagged: 1, inconclusive: 1, nonDonator: 1 })
  })
})
