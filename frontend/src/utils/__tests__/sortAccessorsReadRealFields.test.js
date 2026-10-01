/**
 * Every sort accessor must read a field that actually exists.
 *
 * ⚠️ **This is the gap #840's guard does not cover.** That one asks whether a
 * table HAS sorting. It cannot tell whether an accessor reads a real field —
 * and reading a missing one is not an error, it is `undefined`.
 *
 * ⚠️ The failure is invisible in the worst way. Chain Watch's Bonus column read
 * `r.bonus` where the field is `r.bonusSlots`. Every value came back blank, so
 * the comparator put them all equal and the tie-break produced the SAME order
 * in both directions — a column that looks like it is sorting and is not. The
 * header arrow flipped; nothing moved. It reached dev and MonChoon found it.
 *
 * ⚠️ Rows here are built by the REAL producers, not hand-written. A fixture
 * written beside the accessor would carry the same typo and pass.
 */
import { describe, expect, it } from 'vitest'
import { payoutRows } from '../chainPayout.js'
import { CHAIN_PAYOUT_COLUMNS } from '../../components/chainWatch/PayoutPanel.jsx'
import { summariseWarPayoutRow } from '../warPayoutHistory.js'
import { PAYOUT_HISTORY_COLUMNS } from '../../components/WarPayoutHistory.jsx'

/**
 * Assert every column's accessor returns something other than `undefined`.
 *
 * ⚠️ `null` and `0` are fine — a member with no bonus genuinely has none.
 * `undefined` is the signature of a field that is not there at all.
 */
function everyAccessorReads(columns, row, label) {
  for (const c of columns) {
    expect(
      c.accessor(row),
      `${label}: column "${c.key}" reads a field that does not exist on a real row`,
    ).not.toBeUndefined()
  }
}

describe('Chain Watch payouts', () => {
  const EVENT = {
    id: 1, payout_per_slot: 1_500_000,
    bonus_hours: [5, 6], bonus_multiplier: 2, bonus_applies_to: 'both',
  }
  const H = Date.parse('2027-11-03T04:00:00Z')
  const slot = (id, name, over = {}) => ({
    member_id: id, member_name: name, hour_start: new Date(H).toISOString(),
    hour_ms: String(H), slot_index: 0, is_bonus: false, is_payable: true,
    flag: null, flag_reason: null, pay_decision: null, ...over,
  })

  const { rows } = payoutRows(EVENT, [
    slot('3015831', 'Warwinds'),
    slot('3015831', 'Warwinds', { is_bonus: true }),
    slot('873341', 'Goosey'),
  ])

  it('every column reads a real field', () => {
    everyAccessorReads(CHAIN_PAYOUT_COLUMNS, rows[0], 'CHAIN_PAYOUT_COLUMNS')
  })

  it('the Bonus column reads bonusSlots, and actually moves rows', () => {
    // ⚠️ The regression, pinned directly. `r.bonus` does not exist; the field
    // is `r.bonusSlots`, and reading the wrong one made the column inert.
    const bonus = CHAIN_PAYOUT_COLUMNS.find((c) => c.key === 'bonus')
    const withBonus = rows.find((r) => r.bonusSlots > 0)
    expect(withBonus, 'the fixture should produce a member with a bonus slot').toBeTruthy()
    expect(bonus.accessor(withBonus)).toBe(withBonus.bonusSlots)
    expect(bonus.accessor(withBonus)).toBeGreaterThan(0)
  })

  it('the Ticket range column reads firstTicket', () => {
    const range = CHAIN_PAYOUT_COLUMNS.find((c) => c.key === 'ticketRange')
    expect(range.accessor(rows[0])).toBe(rows[0].firstTicket)
  })
})

describe('saved war payouts', () => {
  it('every column reads a real field', () => {
    const row = summariseWarPayoutRow({
      id: 1, war_id: 49621, war_type: 'real', total_payout: 4_892_000_000,
      member_count: 94, faction_cut_percent: 20, created_by: '4411211',
      created_at: '2026-09-29T00:00:00+00', notes: null,
      ranked_wars: { opponent_name: 'Damage Inc', start_at: 1, end_at: 2 },
    })
    everyAccessorReads(PAYOUT_HISTORY_COLUMNS, row, 'PAYOUT_HISTORY_COLUMNS')
  })
})
