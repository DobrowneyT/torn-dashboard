import { describe, it, expect } from 'vitest'
import { payoutShare, countEqualParticipants, isEqualParticipant } from '../payoutCalculations'

/**
 * The OC pot IS a pot (MonChoon, 2026-10-02): excluding a member must push
 * their money onto everybody else, in every mode.
 *
 * ⚠️ Contrast with Chain Watch, which is a FLAT RATE PER SLOT and must not
 * redistribute — see chainPayout tests. Same screen family, opposite policy;
 * conflating them is the mistake these two suites exist to prevent.
 *
 * This suite pins `payoutShare` because that arithmetic used to exist in four
 * copies that disagreed with each other.
 */

const m = (userId, over = {}) => ({
  userId, ticketTimeSpent: 3600, timeSpent: 3600,
  baseTickets: 10, adjustedTickets: 10, isEligible: true, ...over,
})

const split = (members, mode, pot) => {
  const totalAdjustedTickets = members.reduce((s, x) => s + (x.adjustedTickets || 0), 0)
  const equalParticipants = countEqualParticipants(members)
  return members.map(x => ({
    userId: x.userId,
    ...payoutShare(x, { mode, pot, totalAdjustedTickets, equalParticipants }),
  }))
}

describe('equal mode redistributes when somebody is excluded', () => {
  it('pays an even quarter of the pot to four eligible members', () => {
    const out = split([m(1), m(2), m(3), m(4)], 'equal', 4_000_000)
    expect(out.map(r => r.payout)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000])
  })

  it('MonChoon 2026-10-02: excluding one of four pays the other three a THIRD, not a quarter', () => {
    // The reported symptom was the remaining three "staying at the same fixed
    // value rate" — 1,000,000 each, with 1,000,000 vanishing from the sheet.
    const members = [m(1), m(2), m(3), m(4, { adjustedTickets: 0, isEligible: false })]
    const out = split(members, 'equal', 4_000_000)
    expect(out.find(r => r.userId === 4).payout).toBe(0)
    for (const id of [1, 2, 3]) {
      expect(out.find(r => r.userId === id).payout).toBe(1_333_333)
      expect(out.find(r => r.userId === id).sharePercent).toBeCloseTo(1 / 3)
    }
    // ⚠️ The pot is spent (bar integer floor), not partly stranded.
    expect(4_000_000 - out.reduce((s, r) => s + r.payout, 0)).toBeLessThan(4)
  })

  it('excluding everybody pays nobody rather than dividing by zero', () => {
    const out = split([m(1, { isEligible: false }), m(2, { isEligible: false })], 'equal', 4_000_000)
    expect(out.map(r => r.payout)).toEqual([0, 0])
    expect(out.map(r => r.sharePercent)).toEqual([0, 0])
  })

  it('reads ticketTimeSpent, not timeSpent (#389)', () => {
    // Banked-time-only member: real time in the window, no ticket time.
    const members = [m(1), m(2), m(3, { ticketTimeSpent: 0, timeSpent: 7200 })]
    expect(countEqualParticipants(members)).toBe(2)
    const out = split(members, 'equal', 2_000_000)
    expect(out.find(r => r.userId === 3).payout).toBe(0)
    expect(out.find(r => r.userId === 1).payout).toBe(1_000_000)
  })

  it('treats a member with no isEligible field as eligible', () => {
    // Weeks saved before migration 0065 carry no flag at all.
    const legacy = { userId: 7, ticketTimeSpent: 3600, adjustedTickets: 10 }
    expect(isEqualParticipant(legacy)).toBe(true)
  })
})

describe('ticket modes redistribute too', () => {
  for (const mode of ['tiered', 'flat-weighted']) {
    it(`${mode}: an excluded member's zeroed tickets leave the pot to the rest`, () => {
      const members = [m(1), m(2), m(3, { adjustedTickets: 0, isEligible: false })]
      const out = split(members, mode, 2_000_000)
      expect(out.find(r => r.userId === 3).payout).toBe(0)
      expect(out.find(r => r.userId === 1).payout).toBe(1_000_000)
    })
  }

  it('pays nobody when every ticket is gone', () => {
    const out = split([m(1, { adjustedTickets: 0 })], 'tiered', 2_000_000)
    expect(out[0]).toMatchObject({ sharePercent: 0, payout: 0 })
  })

  it('weights by adjusted tickets, not headcount', () => {
    const out = split([m(1, { adjustedTickets: 30 }), m(2, { adjustedTickets: 10 })], 'tiered', 4_000_000)
    expect(out.map(r => r.payout)).toEqual([3_000_000, 1_000_000])
  })
})

describe('an equal week stays an equal week', () => {
  it('does not fall back to ticket weighting when tickets are uneven', () => {
    // ⚠️ The manual-price-edit path had no equal branch and re-split by
    // tickets, because totalAdjustedTickets is non-zero on an equal week too.
    const members = [m(1, { adjustedTickets: 30 }), m(2, { adjustedTickets: 10 })]
    const out = split(members, 'equal', 4_000_000)
    expect(out.map(r => r.payout)).toEqual([2_000_000, 2_000_000])
  })
})
