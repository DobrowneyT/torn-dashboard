// The OC payout screen's sortable columns (#836, epic #803).
//
// ⚠️ Column CONFIG, not rendering. A wrong accessor or a wrong `kind` is
// invisible — no type error, no render failure, just a column that sorts by
// something else or not at all. That is the failure mode this slice keeps
// hitting, so each config gets a guard.
import { describe, expect, it } from 'vitest'
import {
  WEEK_MEMBER_COLUMNS, CRIME_DETAIL_COLUMNS, CRIME_LABELS, COMPARE_COLUMNS,
} from '../PayoutsView.jsx'
import { sortRows } from '../../utils/tableSort.js'

const allConfigs = {
  WEEK_MEMBER_COLUMNS, CRIME_DETAIL_COLUMNS, COMPARE_COLUMNS,
}

describe('every config', () => {
  it('declares a kind and an accessor for each column', () => {
    for (const [name, cols] of Object.entries(allConfigs)) {
      for (const c of cols) {
        expect(c.kind, `${name}.${c.key} has no kind`).toBeTruthy()
        expect(typeof c.accessor, `${name}.${c.key} has no accessor`).toBe('function')
      }
    }
  })

  it('has no duplicate keys', () => {
    // ⚠️ Two columns sharing a key means one of them sorts by the other.
    for (const [name, cols] of Object.entries(allConfigs)) {
      const keys = cols.map(c => c.key)
      expect(new Set(keys).size, name).toBe(keys.length)
    }
  })

  it('labels every crime column it renders a header for', () => {
    for (const c of CRIME_DETAIL_COLUMNS) {
      expect(CRIME_LABELS[c.key], c.key).toBeTruthy()
    }
  })
})

describe('the crime detail table', () => {
  const crime = (over = {}) => ({
    name: 'Bank job', difficulty: 5, status: 'Successful', member_position: 'Muscle',
    member_cpr: 70, rewards_money: 1000, executed_at: 1_790_000_000, ...over,
  })

  it('sorts executed_at as epoch SECONDS, not as a date string', () => {
    // ⚠️ This table renders `new Date(executed_at * 1000)` — the value is a
    // number. Declaring it `date` would hand parseDbTime a number, which it
    // rejects, and the column would silently sort nothing.
    const rows = [crime({ name: 'old', executed_at: 1 }), crime({ name: 'new', executed_at: 2 })]
    expect(sortRows(rows, CRIME_DETAIL_COLUMNS, 'executed', 'desc')[0].name).toBe('new')
  })

  it('sorts reward by what the cell SHOWS, so a failed crime cannot outrank a successful one', () => {
    // ⚠️ A failed crime renders "-" but may still carry rewards_money.
    const rows = [
      crime({ name: 'failed', status: 'Failed', rewards_money: 9_999_999 }),
      crime({ name: 'won', status: 'Successful', rewards_money: 1000 }),
    ]
    expect(sortRows(rows, CRIME_DETAIL_COLUMNS, 'reward', 'desc')[0].name).toBe('won')
  })

  it('sorts CPR numerically', () => {
    const rows = [crime({ name: 'a', member_cpr: 9 }), crime({ name: 'b', member_cpr: 10 })]
    expect(sortRows(rows, CRIME_DETAIL_COLUMNS, 'cpr', 'desc')[0].name).toBe('b')
  })
})

describe('the week comparison table', () => {
  const row = (name, a, b) => ({ name, a, b })

  it('sinks a member who was only in one week, rather than scoring them zero', () => {
    // ⚠️ "Earned nothing" and "was not here" are different answers. The old
    // table had no sort at all, so this is new behaviour being chosen, not
    // preserved.
    const rows = [
      row('both', { payout: 100 }, { payout: 200 }),
      row('joined', null, { payout: 50 }),
      row('zero', { payout: 0 }, { payout: 0 }),
    ]
    expect(sortRows(rows, COMPARE_COLUMNS, 'payoutA', 'desc').map(r => r.name))
      .toEqual(['both', 'zero', 'joined'])
  })

  it('leaves change undefined when a member is missing a week', () => {
    const c = COMPARE_COLUMNS.find(c => c.key === 'change')
    expect(c.accessor(row('x', null, { payout: 5 }))).toBeNull()
    expect(c.accessor(row('y', { payout: 2 }, { payout: 5 }))).toBe(3)
  })

  it('keeps the old default order available as a column', () => {
    // ⚠️ The table opened "biggest of the two weeks first" before it was
    // sortable. Keeping `peak` as a real column means that default is
    // reachable again after sorting by something else.
    const rows = [row('small', { payout: 1 }, { payout: 2 }), row('big', { payout: 99 }, null)]
    expect(sortRows(rows, COMPARE_COLUMNS, 'peak', 'desc')[0].name).toBe('big')
  })
})
