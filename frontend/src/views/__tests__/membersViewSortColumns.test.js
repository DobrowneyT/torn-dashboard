// Column configs for the four tables in MembersView (#837, epic #803).
//
// ⚠️ Three of these tables had NO sorting at all: the per-member crime
// history, the weekly payout history and the loaned-items list. They answer
// "when did this happen" and "how much", and neither could be reordered.
import { describe, expect, it } from 'vitest'
import {
  ROSTER_COLUMNS, MEMBER_CRIME_COLUMNS, MEMBER_PAYOUT_COLUMNS, LOANED_ITEM_COLUMNS,
} from '../MembersView.jsx'
import { sortRows } from '../../utils/tableSort.js'

const configs = {
  ROSTER_COLUMNS, MEMBER_CRIME_COLUMNS, MEMBER_PAYOUT_COLUMNS, LOANED_ITEM_COLUMNS,
}

describe('every config', () => {
  it('declares a kind and an accessor per column, with unique keys', () => {
    for (const [name, cols] of Object.entries(configs)) {
      for (const c of cols) {
        expect(c.kind, `${name}.${c.key}`).toBeTruthy()
        expect(typeof c.accessor, `${name}.${c.key}`).toBe('function')
      }
      const keys = cols.map(c => c.key)
      expect(new Set(keys).size, name).toBe(keys.length)
    }
  })
})

describe('the crime history', () => {
  const crime = (o = {}) => ({ name: 'Job', difficulty: 5, status: 'Successful',
    position: 'Muscle', cpr: 70, rewards_money: 1000, executed_at: 1_790_000_000, ...o })

  it('sorts executed_at as epoch seconds', () => {
    // ⚠️ Renders `new Date(executed_at * 1000)` — a number, not a Postgres
    // timestamp. `date` would hand parseDbTime a number and sort nothing.
    const rows = [crime({ name: 'old', executed_at: 1 }), crime({ name: 'new', executed_at: 2 })]
    expect(sortRows(rows, MEMBER_CRIME_COLUMNS, 'executed', 'desc')[0].name).toBe('new')
  })

  it('does not let a failed crime outrank a successful one on reward', () => {
    const rows = [
      crime({ name: 'failed', status: 'Failed', rewards_money: 9_999_999 }),
      crime({ name: 'won', status: 'Successful', rewards_money: 1000 }),
    ]
    expect(sortRows(rows, MEMBER_CRIME_COLUMNS, 'reward', 'desc')[0].name).toBe('won')
  })
})

describe('the payout history', () => {
  const pay = (o = {}) => ({ week_start: 1, tier: 1, crimes_count: 1, time_spent: 1,
    payout: 100, theoretical_payout: 100, ...o })

  it('sorts Week by week_start, not by the rendered date range', () => {
    // ⚠️ The cell renders a RANGE. Sorting it as text orders by the string.
    const rows = [pay({ week_start: 200 }), pay({ week_start: 100 })]
    expect(sortRows(rows, MEMBER_PAYOUT_COLUMNS, 'week', 'asc')[0].week_start).toBe(100)
  })

  it('keeps a negative Diff negative', () => {
    // ⚠️ `parseInt(x) || 0` is what collapses a real negative into zero. This
    // column exists to show somebody was paid LESS than theoretical.
    const c = MEMBER_PAYOUT_COLUMNS.find(c => c.key === 'diff')
    expect(c.accessor(pay({ payout: 50, theoretical_payout: 100 }))).toBe(-50)
    const rows = [pay({ payout: 50, theoretical_payout: 100 }), pay({ payout: 150, theoretical_payout: 100 })]
    expect(sortRows(rows, MEMBER_PAYOUT_COLUMNS, 'diff', 'asc')[0].payout).toBe(50)
  })
})

describe('the loaned items list', () => {
  const item = (o = {}) => ({ item_name: 'Thing', category: 'weapons', loaned_to_member: 1, market_value: 10, ...o })

  it('sorts Type by the category ORDER, not alphabetically', () => {
    // ⚠️ Armour before weapons before temporaries is how this list has always
    // read. Alphabetical would put caches first and scatter the gear.
    const rows = [item({ item_name: 'c', category: 'caches' }), item({ item_name: 'a', category: 'armor' })]
    expect(sortRows(rows, LOANED_ITEM_COLUMNS, 'type', 'asc')[0].item_name).toBe('a')
  })

  it('sorts an unknown category last', () => {
    const c = LOANED_ITEM_COLUMNS.find(c => c.key === 'type')
    expect(c.accessor(item({ category: 'mystery' }))).toBe(99)
  })

  it('computes Total Value rather than sorting the rendered currency', () => {
    const c = LOANED_ITEM_COLUMNS.find(c => c.key === 'total')
    expect(c.accessor(item({ market_value: 1000, loaned_to_member: 3 }))).toBe(3000)
  })

  it('treats a missing quantity as one, as the cell does', () => {
    const c = LOANED_ITEM_COLUMNS.find(c => c.key === 'qty')
    expect(c.accessor(item({ loaned_to_member: undefined }))).toBe(1)
  })
})
