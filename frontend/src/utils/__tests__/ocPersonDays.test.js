// #690 — what a crime is worth per person per day (part of #688).
//
// The metric the whole CPR algorithm optimises against, and the only honest way
// to compare crimes with different role counts: a bigger crime ties up more
// people for longer, so a raw E(X) comparison silently favours it.
import { describe, expect, it } from 'vitest'
import { personDays, perPersonPerDay, GAP_DEFAULT_DAYS, GAP_MAX_DAYS } from '../ocPersonDays'

/**
 * Independent reference: walk the actual join schedule and sum the locks.
 *
 * ⚠️ Deliberately NOT the closed form under test. A crime completes at
 * `24h × n` regardless of how slowly it filled — joiners arrive EARLY and idle,
 * the crime never slips — so each member is held from their join until that
 * fixed moment. Getting this wrong is exactly the mistake that produced a
 * cumulative slack term in review.
 */
const simulate = (n, gapDays) => {
  const completesAt = n                                  // days: 24h × n
  const joins = [0]
  for (let i = 2; i <= n; i += 1) joins.push((i - 1) - gapDays)   // arrives `gap` early
  return joins.reduce((sum, t) => sum + (completesAt - t), 0)
}

describe('personDays', () => {
  it('⚠️ matches a hand-walked join schedule at every gap', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      for (const gap of [0, 0.25, 0.5, 1]) {
        expect({ n, gap, d: personDays(n, gap) }).toEqual({ n, gap, d: simulate(n, gap) })
      }
    }
  })

  it('reproduces the documented figures', () => {
    expect(personDays(6, 0.5)).toBe(23.5)   // Blast from the Past, 12h gap
    expect(personDays(6, 0)).toBe(21)       // theoretical floor, instant fill
    expect(personDays(6, 1)).toBe(26)       // everyone piling in as early as possible
    expect(personDays(4, 0.5)).toBe(11.5)
  })

  it('⚠️ never exceeds everyone being locked for the whole crime', () => {
    // The absolute ceiling is n members × n days. A formula that can pass it is
    // charging for time nobody spent.
    for (const n of [2, 3, 4, 5, 6]) {
      expect(personDays(n, GAP_MAX_DAYS)).toBeLessThanOrEqual(n * n)
    }
  })

  it('rises with the gap, because slack is a real cost', () => {
    const series = [0, 0.25, 0.5, 0.75, 1].map((g) => personDays(6, g))
    expect(series).toEqual([...series].sort((a, b) => a - b))
    expect(new Set(series).size).toBe(series.length)
  })

  it('⚠️ clamps the gap to [0, 24h] rather than trusting a caller', () => {
    // A gap above 24h would mean a joiner arriving before the previous one did.
    expect(personDays(6, 5)).toBe(personDays(6, GAP_MAX_DAYS))
    expect(personDays(6, -3)).toBe(personDays(6, 0))
  })

  it('is absent, not zero, for a nonsense role count', () => {
    expect(personDays(0, 0.5)).toBeNull()
    expect(personDays(null, 0.5)).toBeNull()
  })
})

describe('perPersonPerDay', () => {
  const base = { expectedValue: 235_000_000, roleCount: 6, rosterSize: 92 }

  it('divides E(X) by the person-days a crime consumes', () => {
    const out = perPersonPerDay({ ...base, crews: 1 })
    expect(out.personDays).toBe(23.5)
    expect(out.perParticipant).toBe(10_000_000)   // 235M / 23.5
  })

  it('⚠️ counts idle members against the faction-wide figure', () => {
    // The distinction the whole algorithm turns on. One crew of six out of 92
    // members earns the faction far less per head than the participants make.
    const out = perPersonPerDay({ ...base, crews: 1 })
    // k × E(X) / (n days × roster) = 1 × 235M / (6 × 92)
    expect(out.perFactionMember).toBeCloseTo(425_724.6, 1)
    expect(out.perParticipant).toBeGreaterThan(out.perFactionMember)
  })

  it('⚠️ the two converge when the roster is fully committed', () => {
    // At full utilisation nobody is idle, so the faction-wide rate IS the
    // participant rate. A formula where they disagree here is wrong.
    const roleCount = 6
    const gap = 0.5
    const rosterSize = 920
    const crews = (rosterSize * roleCount) / personDays(roleCount, gap)
    const out = perPersonPerDay({ expectedValue: 235_000_000, roleCount, rosterSize, crews, gap })
    expect(out.perFactionMember).toBeCloseTo(out.perParticipant, 6)
    expect(out.utilisation).toBeCloseTo(1, 6)
  })

  it('reports utilisation as the share of the roster actually working', () => {
    const out = perPersonPerDay({ ...base, crews: 2 })
    // 2 crews × 23.5 person-days, spread over the 6-day crime, against 92 members
    expect(out.utilisation).toBeCloseTo((2 * 23.5) / (6 * 92), 6)
  })

  it('⚠️ says it assumed one crew rather than pretending it knew', () => {
    const out = perPersonPerDay({ ...base })
    expect(out.crews).toBe(1)
    expect(out.assumedCrews).toBe(true)
    const known = perPersonPerDay({ ...base, crews: 3 })
    expect(known.assumedCrews).toBe(false)
  })

  it('⚠️ reports absent, never zero, when E(X) is unknown', () => {
    // A crime with no reward coverage has no value we can state. Absent beats
    // confidently wrong (#441/#473/#351) — a zero here reads as "worthless".
    const out = perPersonPerDay({ ...base, expectedValue: null })
    expect(out.perParticipant).toBeNull()
    expect(out.perFactionMember).toBeNull()
    expect(out.missing).toContain('expectedValue')
    // The part we CAN compute still comes back.
    expect(out.personDays).toBe(23.5)
  })

  it('⚠️ a missing roster size costs only the faction-wide figure', () => {
    const out = perPersonPerDay({ ...base, rosterSize: null, crews: 1 })
    expect(out.perParticipant).toBe(10_000_000)
    expect(out.perFactionMember).toBeNull()
    expect(out.missing).toEqual(['rosterSize'])
  })

  it('reports nothing computable for a crime with no roles', () => {
    const out = perPersonPerDay({ ...base, roleCount: 0 })
    expect(out.personDays).toBeNull()
    expect(out.perParticipant).toBeNull()
    expect(out.missing).toContain('roleCount')
  })

  it('defaults the gap to 12h and says so', () => {
    expect(GAP_DEFAULT_DAYS).toBe(0.5)
    const out = perPersonPerDay({ ...base, crews: 1 })
    expect(out.gap).toBe(0.5)
    expect(out.gapIsAssumed).toBe(true)
    expect(perPersonPerDay({ ...base, crews: 1, gap: 0.25 }).gapIsAssumed).toBe(false)
  })

  it('⚠️ the gap assumption moves the answer by ~22% across its range', () => {
    // Why #687 exists: `g` is faction behaviour, not a game rule, and every
    // threshold the algorithm produces inherits it.
    const floor = perPersonPerDay({ ...base, crews: 1, gap: 0 }).perParticipant
    const ceiling = perPersonPerDay({ ...base, crews: 1, gap: 1 }).perParticipant
    expect(floor / ceiling).toBeCloseTo(26 / 21, 6)
    expect(floor / ceiling).toBeGreaterThan(1.2)
  })
})
