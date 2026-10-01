// The RW History tables' columns (#838, epic #803).
import { describe, expect, it } from 'vitest'
import { WAR_LIST_COLUMNS, WAR_MEMBER_COLUMNS } from '../WarHistoryView.jsx'
import { sortRows } from '../../utils/tableSort.js'

const war = (o = {}) => ({ opponent_name: 'Damage Inc', our_score: 100,
  opponent_score: 90, start_at: 1_790_000_000, end_at: 1_790_100_000, is_termed: false, ...o })

describe('the war list', () => {
  it('distinguishes a genuine 0-0 from a war with no score', () => {
    // ⚠️ The scores were coerced with `|| 0`, so an ongoing war showing a real
    // 0 was indistinguishable from one with nothing recorded. An absent score
    // sinks; a zero is a number.
    const rows = [
      war({ opponent_name: 'ongoing', our_score: 0 }),
      war({ opponent_name: 'unknown', our_score: null }),
      war({ opponent_name: 'won', our_score: 500 }),
    ]
    expect(sortRows(rows, WAR_LIST_COLUMNS, 'our_score', 'asc').map(w => w.opponent_name))
      .toEqual(['ongoing', 'won', 'unknown'])
  })

  it('groups termed and real wars when sorted by Type', () => {
    // ⚠️ The only reason to sort that column. It had no sort at all before.
    const rows = [war({ opponent_name: 'a', is_termed: true }),
                  war({ opponent_name: 'b', is_termed: false }),
                  war({ opponent_name: 'c', is_termed: true })]
    const out = sortRows(rows, WAR_LIST_COLUMNS, 'is_termed', 'desc').map(w => w.is_termed)
    expect(out).toEqual([true, true, false])
  })

  it('sorts Result on the derived value, not a field', () => {
    // ⚠️ `result` is computed by getWarResult — it depends on whether the war
    // ended and who scored higher, and is not on the row.
    const c = WAR_LIST_COLUMNS.find(c => c.key === 'result')
    expect(typeof c.accessor(war())).toBe('string')
  })

  it('declares a kind for every column', () => {
    for (const c of [...WAR_LIST_COLUMNS, ...WAR_MEMBER_COLUMNS]) {
      expect(c.kind, c.key).toBeTruthy()
      expect(typeof c.accessor, c.key).toBe('function')
    }
  })
})

describe('the member contributions table', () => {
  const m = (o = {}) => ({ member_name: 'A', level: 50, score: '100', attacks: 1,
    assists: 2, losses: 0, ...o })

  it('sorts score numerically even though it arrives as a string', () => {
    // ⚠️ The NORMALISED score — the bracketed number — because that is what
    // payout shares are computed from.
    const rows = [m({ member_name: 'a', score: '9' }), m({ member_name: 'b', score: '10' })]
    expect(sortRows(rows, WAR_MEMBER_COLUMNS, 'score', 'desc')[0].member_name).toBe('b')
  })

  it('keeps a real zero on losses rather than sinking it', () => {
    // ⚠️ Nobody losing a single fight is a fact worth seeing at the top of an
    // ascending sort, not a blank.
    const rows = [m({ member_name: 'clean', losses: 0 }), m({ member_name: 'lost', losses: 5 })]
    expect(sortRows(rows, WAR_MEMBER_COLUMNS, 'losses', 'asc')[0].member_name).toBe('clean')
  })
})
