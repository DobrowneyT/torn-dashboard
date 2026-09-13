// #728 — the faction's own history as a check on tornprobability's model.
//
// ⚠️ The hazard this module exists to avoid is RESTRICTION OF RANGE. The
// correlation between a role's CPR and the crime's success measures where the
// faction has VARIED the crew, not which role matters. Forge holds Blast from
// the Past's Muscle at ~77 in every run, so Muscle shows a -0.36 "effect" — not
// because it does not matter, but because there is nothing to see. Reported
// naively, that ranks the highest-weighted role in the crime as useless.
import { describe, expect, it } from 'vitest'
import { summariseObserved, MIN_INFORMATIVE_SPREAD } from '../src/oc/observedSuccess.js'

/** One run: every role's CPR, plus whether the crime succeeded. */
const run = (id: string, ok: boolean, cprs: Record<string, number>) =>
  Object.entries(cprs).map(([position, cpr]) => ({ crimeId: id, ok, position, cpr }))

describe('summariseObserved', () => {
  it('returns absent rather than a summary below the run floor', () => {
    const rows = [...run('a', true, { R1: 70, R2: 70 }), ...run('b', false, { R1: 60, R2: 60 })]
    const out = summariseObserved(rows, { minRuns: 10 })
    expect(out.enough).toBe(false)
    expect(out.buckets).toEqual([])
    expect(out.runs).toBe(2)
  })

  it('measures success against the crew it was run with', () => {
    // 20 low-crew runs at 40% and 20 high-crew runs at 90%.
    const rows = []
    for (let i = 0; i < 20; i++) rows.push(...run(`lo${i}`, i < 8, { R1: 60, R2: 62 }))
    for (let i = 0; i < 20; i++) rows.push(...run(`hi${i}`, i < 18, { R1: 80, R2: 82 }))
    const out = summariseObserved(rows, { minRuns: 10, maxBuckets: 2 })
    expect(out.enough).toBe(true)
    expect(out.runs).toBe(40)
    expect(out.buckets).toHaveLength(2)
    expect(out.buckets[0].rate).toBeCloseTo(0.4, 2)
    expect(out.buckets[1].rate).toBeCloseTo(0.9, 2)
    expect(out.buckets[0].meanCpr).toBeLessThan(out.buckets[1].meanCpr)
  })

  it('⚠️ reports a narrow-spread role as uninformative, NOT as unimportant', () => {
    // R2 never moves. Whatever its true weight, these runs cannot speak to it.
    const rows = []
    for (let i = 0; i < 40; i++) {
      rows.push(...run(`r${i}`, i % 2 === 0, { R1: 50 + i, R2: 77 }))
    }
    const out = summariseObserved(rows, { minRuns: 10 })
    const r2 = out.roles.find((r) => r.position === 'R2')!
    expect(r2.informative).toBe(false)
    expect(r2.reason).toBe('narrow-range')
    // ⚠️ The number is WITHHELD, not reported as zero. A 0.0 in this column
    // reads as "measured, no effect" — the exact misreading that would rank a
    // crime's heaviest role as ignorable.
    expect(r2.delta).toBeNull()
    expect(r2.spread).toBeLessThan(MIN_INFORMATIVE_SPREAD)

    const r1 = out.roles.find((r) => r.position === 'R1')!
    expect(r1.informative).toBe(true)
    expect(r1.delta).not.toBeNull()
  })

  it('gives the sign of the effect for a role that does vary', () => {
    const rows = []
    for (let i = 0; i < 30; i++) rows.push(...run(`ok${i}`, true, { R1: 80, R2: 70 }))
    for (let i = 0; i < 30; i++) rows.push(...run(`no${i}`, false, { R1: 60, R2: 70 }))
    const out = summariseObserved(rows, { minRuns: 10 })
    const r1 = out.roles.find((r) => r.position === 'R1')!
    expect(r1.delta).toBeCloseTo(20, 5)      // +20 CPR when it succeeds
    expect(r1.informative).toBe(true)
  })

  it('⚠️ derives bucket edges from the data, never from a fixed CPR grid', () => {
    // A faction operating at 40-50 must get 40-50 buckets, not empty 55-80 ones.
    const rows = []
    for (let i = 0; i < 40; i++) rows.push(...run(`r${i}`, i % 3 !== 0, { R1: 40 + (i % 10) }))
    const out = summariseObserved(rows, { minRuns: 10 })
    expect(out.buckets.length).toBeGreaterThan(0)
    expect(out.buckets[0].lo).toBeGreaterThanOrEqual(40)
    expect(out.buckets[out.buckets.length - 1].hi).toBeLessThanOrEqual(50)
  })

  it('never emits a bucket too small to mean anything', () => {
    const rows = []
    for (let i = 0; i < 40; i++) rows.push(...run(`r${i}`, i % 2 === 0, { R1: 50 + i }))
    const out = summariseObserved(rows, { minRuns: 10, minBucketRuns: 8 })
    for (const b of out.buckets) expect(b.runs).toBeGreaterThanOrEqual(8)
  })

  it('ignores a slot with no CPR reading rather than scoring it zero', () => {
    // A missing reading is not a member with 0 CPR — that would drag every
    // crew mean down and invent a correlation.
    const rows = []
    for (let i = 0; i < 20; i++) {
      rows.push({ crimeId: `r${i}`, ok: true, position: 'R1', cpr: 75 })
      rows.push({ crimeId: `r${i}`, ok: true, position: 'R2', cpr: null as unknown as number })
    }
    const out = summariseObserved(rows, { minRuns: 10 })
    expect(out.buckets[0].meanCpr).toBeCloseTo(75, 5)
    expect(out.roles.find((r) => r.position === 'R2')).toBeUndefined()
  })

  it('counts runs, not slots', () => {
    const rows = []
    for (let i = 0; i < 12; i++) rows.push(...run(`r${i}`, true, { R1: 70, R2: 71, R3: 72 }))
    const out = summariseObserved(rows, { minRuns: 10 })
    expect(out.runs).toBe(12)             // not 36
    expect(out.successes).toBe(12)
  })
})
