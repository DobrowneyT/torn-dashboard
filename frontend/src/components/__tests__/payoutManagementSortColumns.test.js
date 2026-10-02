// Column configs for the two payout MANAGEMENT sheets (#836, epic #803).
//
// ⚠️ Both files had the defect this epic was filed about: a comparator that
// coerced one column and let the rest fall through to a raw `<` / `>`, or a
// 28-case switch whose `default` sorted by payout. These guard the configs
// that replaced them — the part that goes wrong silently.
import { describe, expect, it } from 'vitest'
import { OC_PAYOUT_COLUMNS } from '../PayoutManagement.jsx'
import { buildWarMemberColumns } from '../WarPayoutManagement.jsx'
import { sortRows } from '../../utils/tableSort.js'

describe('the OC payout sheet', () => {
  it('declares a kind and accessor for every column', () => {
    for (const c of OC_PAYOUT_COLUMNS) {
      expect(c.kind, c.key).toBeTruthy()
      expect(typeof c.accessor, c.key).toBe('function')
    }
  })

  it('treats only the name as text', () => {
    expect(OC_PAYOUT_COLUMNS.filter(c => c.kind === 'text').map(c => c.key)).toEqual(['name'])
  })

  it('sorts a numeric user id numerically, not lexically', () => {
    // ⚠️ The clearest casualty of the old comparator: userId arrives as a
    // string, so "1712182" sorted before "873341". These are real forge ids.
    const rows = [
      { name: 'a', userId: '1712182' },
      { name: 'b', userId: '873341' },
      { name: 'c', userId: '2214797' },
    ]
    expect(sortRows(rows, OC_PAYOUT_COLUMNS, 'userId', 'asc').map(r => r.name))
      .toEqual(['b', 'a', 'c'])
  })

  it('sorts payouts numerically above 2^32', () => {
    const rows = [{ name: 'a', payout: 4294967296 }, { name: 'b', payout: 4892000000 }]
    expect(sortRows(rows, OC_PAYOUT_COLUMNS, 'payout', 'desc')[0].name).toBe('b')
  })
})

describe('the war payout sheet', () => {
  const cols = buildWarMemberColumns()
  const key = (k) => cols.find(c => c.key === k)

  it('declares a kind and accessor for every column', () => {
    for (const c of cols) {
      expect(c.kind, c.key).toBeTruthy()
      expect(typeof c.accessor, c.key).toBe('function')
    }
  })

  it('generates BOTH race windows regardless of the data', () => {
    // ⚠️ Deriving these from the rows looked tidier and was wrong: before the
    // payout loads, or for a member with no `pre` block, the column would not
    // exist and a sort held on it would silently do nothing — where the switch
    // this replaces handled any dotted key regardless.
    expect(key('pre.warHits')).toBeTruthy()
    expect(key('post.warHits')).toBeTruthy()
  })

  it('reads the raw key inside a window block, as the old switch did', () => {
    // ⚠️ `pre.partScore` is `m.pre.partScore` — NOT the `participationScore`
    // that the flat `partScore` column maps to. The two differ on purpose.
    const m = { pre: { partScore: 7 }, participationScore: 99 }
    expect(key('pre.partScore').accessor(m)).toBe(7)
    expect(key('partScore').accessor(m)).toBe(99)
  })

  it('preserves the respect fallback for older payouts', () => {
    // ⚠️ Older payouts carry `score` where newer ones carry `respectGained`.
    expect(key('respect').accessor({ score: 5 })).toBe(5)
    expect(key('respect').accessor({ respectGained: 9, score: 5 })).toBe(9)
  })

  it('has no duplicate keys across flat and windowed columns', () => {
    const keys = cols.map(c => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('does not throw on a member with no race blocks', () => {
    expect(key('pre.mugs').accessor({})).toBeUndefined()
    expect(() => sortRows([{}, {}], cols, 'pre.mugs', 'desc')).not.toThrow()
  })
})
