// Chain Watch payout and raffle (#773).
//
// The reference case is the real one: the October 2025 sheet paid 379 slots
// across 26 members at 1.5m each — 568,500,000 — and handed out 438 raffle
// tickets. If this file agrees with that, it is doing the spreadsheet's job.
import { describe, it, expect } from 'vitest'
import { payoutRows, payLink, isPaid, raffleRuns, unpayableNote } from '../chainPayout'

const EVENT = {
  id: 1,
  payout_per_slot: 1_500_000,
  bonus_hours: [5, 6],
  bonus_multiplier: 2,
  bonus_applies_to: 'tickets',
}
/** A served, payable slot. */
const slot = (id, name, over = {}) => ({
  member_id: id, member_name: name, is_bonus: false, is_payable: true,
  flag: null, pay_decision: null, ...over,
})
const many = (n, id, name, over = {}) => Array.from({ length: n }, () => slot(id, name, over))

describe('the 2025 run, reproduced', () => {
  // 379 slots and 59 bonus slots, as counted off the workbook.
  //
  // ⚠️ The sheet's `Slots` column ALREADY includes the bonus ones — `Green
  // Slots` is a subset, counted a second time only for tickets. So a member
  // with 73 slots and 10 green has 73 slots here, ten of them flagged bonus,
  // and 83 tickets. Reading green as a separate pile inflates everything.
  const signups = [
    ...many(63, '3538517', 'THARAGINCAJIN'), ...many(10, '3538517', 'THARAGINCAJIN', { is_bonus: true }),
    ...many(52, '3228747', '-Jesse-'), ...many(14, '3228747', '-Jesse-', { is_bonus: true }),
    ...many(29, '3136837', 'Sanityloss'), ...many(9, '3136837', 'Sanityloss', { is_bonus: true }),
    ...many(27, '3383262', 'Zyuunii'), ...many(5, '3383262', 'Zyuunii', { is_bonus: true }),
    ...many(26, '873341', 'Goosey'), ...many(4, '873341', 'Goosey', { is_bonus: true }),
    // 379 total less the 239 above; 59 bonus less the 42 above.
    ...many(123, '2327020', 'Everyone else'), ...many(17, '2327020', 'Everyone else', { is_bonus: true }),
  ]

  it('pays per slot, at the event’s rate', () => {
    const { totals } = payoutRows(EVENT, signups)
    expect(totals.slots).toBe(379)
    expect(totals.bonusSlots).toBe(59)
    expect(totals.payout).toBe(568_500_000)
  })

  it('gives a bonus slot a second ticket, matching the sheet’s 438', () => {
    expect(payoutRows(EVENT, signups).totals.tickets).toBe(438)
  })

  it('⚠️ covers 1..total exactly once, with no gap and no overlap', () => {
    // A raffle with a hole in the numbering has a losing ticket nobody holds.
    const { rows, totals } = payoutRows(EVENT, signups)
    const covered = []
    for (const r of rows) for (let t = r.firstTicket; t <= r.lastTicket; t++) covered.push(t)
    expect(covered).toHaveLength(totals.tickets)
    expect(new Set(covered).size).toBe(totals.tickets)
    expect(Math.min(...covered)).toBe(1)
    expect(Math.max(...covered)).toBe(totals.tickets)
  })

  it('⚠️ totals from the rows, never from a separate sum', () => {
    // The sheet's totals row reads 189.5 bonus slots — exactly half the slot
    // count, a stray /2 — where its own member rows sum to 59.
    const { rows, totals } = payoutRows(EVENT, signups)
    expect(rows.reduce((n, r) => n + r.slots, 0)).toBe(totals.slots)
    expect(rows.reduce((n, r) => n + r.bonusSlots, 0)).toBe(totals.bonusSlots)
    expect(rows.reduce((n, r) => n + r.payout, 0)).toBe(totals.payout)
  })

  it('⚠️ numbers the raffle the same way twice', () => {
    // A raffle whose numbering moves between renders is not a raffle.
    const a = payoutRows(EVENT, signups)
    const b = payoutRows(EVENT, [...signups].reverse())
    expect(b.rows.map((r) => [r.member_id, r.firstTicket, r.lastTicket]))
      .toEqual(a.rows.map((r) => [r.member_id, r.firstTicket, r.lastTicket]))
  })
})

describe('what the bonus multiplies', () => {
  const signups = [...many(4, '1', 'A'), ...many(2, '1', 'A', { is_bonus: true })]

  it('tickets only, by default', () => {
    const { rows } = payoutRows(EVENT, signups)
    expect(rows[0].tickets).toBe(8)                 // 6 slots + 2 extra
    expect(rows[0].payout).toBe(6 * 1_500_000)      // money untouched
  })

  it('⚠️ payout only moves the money and leaves the tickets alone', () => {
    const { rows } = payoutRows({ ...EVENT, bonus_applies_to: 'payout' }, signups)
    expect(rows[0].tickets).toBe(6)
    expect(rows[0].payout).toBe(8 * 1_500_000)
  })

  it('both moves both', () => {
    const { rows } = payoutRows({ ...EVENT, bonus_applies_to: 'both' }, signups)
    expect(rows[0].tickets).toBe(8)
    expect(rows[0].payout).toBe(8 * 1_500_000)
  })

  it('⚠️ re-derives when leadership changes the multiplier mid-event', () => {
    // Nothing is stamped onto a row at claim time — that is what let the sheet
    // pay 59 bonuses where 31 were marked.
    const { rows } = payoutRows({ ...EVENT, bonus_multiplier: 3 }, signups)
    expect(rows[0].tickets).toBe(10)                // 6 + 2×(3−1)
  })
})

describe('flags, and who decides', () => {
  it('⚠️ still pays an absent slot until a leader says otherwise', () => {
    // A flag asks a question; it does not withhold money on its own.
    expect(isPaid(slot('1', 'A', { flag: 'absent' }))).toBe(true)
    const { rows } = payoutRows(EVENT, [slot('1', 'A', { flag: 'absent' })])
    expect(rows[0].slots).toBe(1)
    expect(rows[0].awaiting).toBe(1)
  })

  it('⚠️ never pays an abroad slot, because that is not a judgment call', () => {
    expect(isPaid(slot('1', 'A', { flag: 'abroad', is_payable: false }))).toBe(false)
    const { rows } = payoutRows(EVENT, [slot('1', 'A', { flag: 'abroad', is_payable: false })])
    expect(rows[0].slots).toBe(0)
    expect(rows[0].unpaidSlots).toBe(1)
  })

  it('honours a leader marking a flagged slot unpaid, and paid', () => {
    expect(isPaid(slot('1', 'A', { flag: 'absent-at-risk', pay_decision: 'unpaid' }))).toBe(false)
    // ⚠️ And a leader can overrule even an abroad slot — the app records, it
    // does not adjudicate.
    expect(isPaid(slot('1', 'A', { flag: 'abroad', is_payable: false, pay_decision: 'paid' }))).toBe(true)
  })

  it('counts a decided flag as no longer awaiting anyone', () => {
    const { totals } = payoutRows(EVENT, [
      slot('1', 'A', { flag: 'absent' }),
      slot('1', 'A', { flag: 'absent', pay_decision: 'paid' }),
    ])
    expect(totals.awaiting).toBe(1)
  })
})

describe('hours that never happened', () => {
  it('⚠️ says so rather than quietly dropping them', () => {
    // Silently shrinking the count looks identical to a bug in the counting.
    const signups = [...many(3, '1', 'A'), ...many(2, '1', 'A', { is_payable: false })]
    const note = unpayableNote(EVENT, signups,
      { state: 'ended', endedAt: Date.parse('2027-11-05T14:00:00Z'), dropped: true })
    expect(note).toMatch(/2 sign-ups/)
    expect(note).toMatch(/2027-11-05 14:00 TCT/)
    expect(payoutRows(EVENT, signups).totals.slots).toBe(3)
  })

  it('says nothing when every hour counted', () => {
    expect(unpayableNote(EVENT, many(3, '1', 'A'), { state: 'running' })).toBeNull()
  })
})

describe('the raffle', () => {
  it('⚠️ does not run when the chain dropped', () => {
    expect(raffleRuns({ state: 'ended', dropped: true })).toBe(false)
  })

  it('runs when the chain was banked, or is still going', () => {
    expect(raffleRuns({ state: 'ended', dropped: false })).toBe(true)
    expect(raffleRuns({ state: 'running', dropped: false })).toBe(true)
    expect(raffleRuns(null)).toBe(true)
  })
})

describe('the payment link', () => {
  it('⚠️ carries exactly the number on the row', () => {
    // The sheet showed Warwinds 35,000,000 beside a link paying 34,500,000.
    const { rows } = payoutRows(EVENT, many(23, '3015831', 'Warwinds'))
    expect(rows[0].payout).toBe(34_500_000)
    expect(payLink(rows[0].member_id, rows[0].payout)).toContain('money=34500000')
    expect(payLink(rows[0].member_id, rows[0].payout)).toContain('addMoneyTo=3015831')
  })
})
