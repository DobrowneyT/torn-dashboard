// Column kinds for the OC tables converted in #837.
//
// ⚠️ A wrong `kind` against a right key is the failure mode this slice keeps
// producing: no type error, no render failure, just a column comparing the
// wrong way. These assert the kinds match what the cells actually hold.
import { describe, expect, it } from 'vitest'
import { OC_HISTORY_COLUMNS } from '../../views/CrimesView.jsx'
import { INVENTORY_COLUMNS } from '../../components/InventoryManagement.jsx'
import { RANKING_COLUMNS, sortRanking } from '../ocRanking.js'
import { sortRows } from '../tableSort.js'

describe('OC history', () => {
  it('sorts executed_at as epoch seconds, not as a date', () => {
    // ⚠️ The cell renders `new Date(timestamp * 1000)`. `date` would hand
    // parseDbTime a number and the column would sort nothing.
    const c = OC_HISTORY_COLUMNS.find(c => c.key === 'executed_at')
    expect(c.kind).toBe('number')
    const rows = [{ name: 'old', executed_at: 1 }, { name: 'new', executed_at: 2 }]
    expect(sortRows(rows, OC_HISTORY_COLUMNS, 'executed_at', 'desc')[0].name).toBe('new')
  })

  it('compares crime names case-insensitively', () => {
    // ⚠️ The old comparator had no coercion at all, so every lower-case crime
    // sorted after every upper-case one.
    const rows = [{ name: 'zebra' }, { name: 'Apple' }]
    expect(sortRows(rows, OC_HISTORY_COLUMNS, 'name', 'asc')[0].name).toBe('Apple')
  })
})

describe('inventory', () => {
  it('survives an item with no name', () => {
    // ⚠️ The old comparator called `aVal.toLowerCase()` with no guard — one
    // null name would throw and blank the whole table.
    const rows = [{ id: 1, name: null }, { id: 2, name: 'Xanax' }]
    expect(() => sortRows(rows, INVENTORY_COLUMNS, 'name', 'asc')).not.toThrow()
    expect(sortRows(rows, INVENTORY_COLUMNS, 'name', 'asc')[0].name).toBe('Xanax')
  })

  it('does not collapse item id zero into a missing id', () => {
    // ⚠️ `parseInt(id) || 0` did exactly that.
    const rows = [{ id: 0, name: 'a' }, { id: 5, name: 'b' }]
    expect(sortRows(rows, INVENTORY_COLUMNS, 'id', 'asc')[0].id).toBe(0)
  })
})

describe('crime ranking', () => {
  it('declares a kind for every column the table renders', () => {
    for (const c of RANKING_COLUMNS) expect(c.kind, c.key).toBeTruthy()
  })

  it('still sorts a key outside the declared set', () => {
    // ⚠️ `sortRanking` is key-agnostic and must stay so: `sortRows` returns
    // rows UNCHANGED for a column it does not know, so narrowing it would mean
    // a caller passing another field silently gets no sort.
    const rows = [{ name: 'Z', custom: 1 }, { name: 'A', custom: 9 }]
    expect(sortRanking(rows, 'custom', 'desc').map(r => r.name)).toEqual(['A', 'Z'])
  })
})
