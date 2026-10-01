// The RW payout modal's sortable columns (#836, epic #803).
//
// ⚠️ This file had NO tests before this slice, which is how "1 of 18 columns
// sorts" survived in a payout screen. These cover the column CONFIG — the part
// that is wrong silently — rather than the rendering.
import { describe, expect, it } from 'vitest'
import { buildMemberColumns, BREAKDOWN_KEYS } from '../RWPayoutsView.jsx'
import { sortRows } from '../../utils/tableSort.js'

const member = (over = {}) => ({
  member_name: 'Someone', war_hits: 0, assist_attacks: 0, losses: 0, mugs: 0,
  regular_hits: 0, score: 0, payout_amount: 0, is_eligible: true, ...over,
})

describe('the column config', () => {
  it('declares a kind for every column', () => {
    // ⚠️ A column with no kind falls back to a text compare, which is how a
    // money column starts ordering 900,000,000 before 1,000,000,000.
    for (const c of buildMemberColumns('pre')) {
      expect(c.kind, c.key).toBeTruthy()
    }
  })

  it('treats only the member name as text', () => {
    const text = buildMemberColumns('pre').filter(c => c.kind === 'text').map(c => c.key)
    expect(text).toEqual(['member_name'])
  })

  it('covers every breakdown key the header row renders', () => {
    // ⚠️ One definition drives both; two lists would drift and a header would
    // sort by the column beside it — the quietest possible bug on a money
    // screen.
    const keys = buildMemberColumns('pre').map(c => c.key)
    for (const [key] of BREAKDOWN_KEYS) expect(keys).toContain(`bd_${key}`)
  })

  it('reads the window it was built for', () => {
    const m = member({ race_breakdown: { pre: { mugs: 3 }, post: { mugs: 9 } } })
    const pre = buildMemberColumns('pre').find(c => c.key === 'bd_mugs')
    const post = buildMemberColumns('post').find(c => c.key === 'bd_mugs')
    expect(pre.accessor(m)).toBe(3)
    expect(post.accessor(m)).toBe(9)
  })

  it('reads a missing breakdown as zero rather than throwing', () => {
    // Older payouts have no race_breakdown at all.
    const c = buildMemberColumns('pre').find(c => c.key === 'bd_mugs')
    expect(c.accessor(member())).toBe(0)
  })
})

describe('sorting real payout shapes', () => {
  const cols = buildMemberColumns('pre')

  it('orders money numerically, not lexically', () => {
    // ⚠️ Live forge figures. 4,892,000,000 exceeds 2^32 — a lexical sort puts
    // "2416000000" above "4892000000" because '2' < '4' is false... and then
    // gets the next pair wrong. Numeric is the only correct answer.
    const rows = [
      member({ member_name: 'a', payout_amount: 2416000000 }),
      member({ member_name: 'b', payout_amount: 4892000000 }),
      member({ member_name: 'c', payout_amount: 982000000 }),
    ]
    expect(sortRows(rows, cols, 'payout_amount', 'desc').map(r => r.member_name))
      .toEqual(['b', 'a', 'c'])
  })

  it('does not truncate a payout above 2^32', () => {
    const big = member({ member_name: 'big', payout_amount: 4892000000 })
    const small = member({ member_name: 'small', payout_amount: 4294967296 })
    expect(sortRows([small, big], cols, 'payout_amount', 'desc')[0].member_name).toBe('big')
  })

  it('sinks an ineligible member with no payout to the end, both directions', () => {
    // ⚠️ The behaviour change this slice makes. The old comparator read
    // `?? 0`, so an ineligible member sorted among those who earned nothing —
    // and descending, that put them ABOVE anybody on a genuine zero.
    const rows = [
      member({ member_name: 'earned', payout_amount: 5000 }),
      member({ member_name: 'ineligible', payout_amount: null, is_eligible: false }),
      member({ member_name: 'zero', payout_amount: 0 }),
    ]
    expect(sortRows(rows, cols, 'payout_amount', 'desc').map(r => r.member_name))
      .toEqual(['earned', 'zero', 'ineligible'])
    expect(sortRows(rows, cols, 'payout_amount', 'asc').map(r => r.member_name))
      .toEqual(['zero', 'earned', 'ineligible'])
  })

  it('keeps equal rows stable on the member name', () => {
    // Most members have 0 mugs, so ties are the normal case here.
    const rows = [
      member({ member_name: 'carol', mugs: 0 }),
      member({ member_name: 'alice', mugs: 0 }),
      member({ member_name: 'bob', mugs: 2 }),
    ]
    const out = sortRows(rows, cols, 'mugs', 'desc', { tieBreak: 'member_name' })
    expect(out.map(r => r.member_name)).toEqual(['bob', 'alice', 'carol'])
  })
})
