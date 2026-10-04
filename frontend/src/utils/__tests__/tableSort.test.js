// The shared table comparator (#834, epic #803).
//
// ⚠️ These tests are the point of the slice. The audit found the *affordances*
// missing on 22 tables, but the real defect was the comparators: a column with
// no explicit coercion fell through to a raw `<` / `>`, so nulls returned 0 and
// scattered, `"10" < "9"` sorted lexically, and `parseInt(x) || 0` collapsed a
// real zero into a missing value. Every case below is one of those.
import { describe, expect, it } from 'vitest'
import { compareValues, sortRows, nextDirection } from '../tableSort.js'

const COLS = [
  { key: 'name', kind: 'text' },
  { key: 'score', kind: 'number' },
  { key: 'when', kind: 'date' },
  { key: 'paid', kind: 'bool' },
]

const sort = (rows, col, dir, opts) =>
  sortRows(rows, COLS, col, dir, { tieBreak: 'name', ...opts })

describe('compareValues', () => {
  it('compares numbers numerically, including numeric strings', () => {
    // ⚠️ The headline bug, stated as a contrast so it cannot be read the wrong
    // way round: 10 is GREATER than 9, and a numeric compare says so for the
    // strings too. The lexical compare on the next line is what the old
    // fall-through did, and it disagrees.
    expect(compareValues('10', '9', 'number')).toBeGreaterThan(0)
    expect(compareValues(10, 9, 'number')).toBeGreaterThan(0)
    expect('10'.localeCompare('9')).toBeLessThan(0)  // the bug being fixed
  })

  it('does not collapse a real zero into a missing value', () => {
    // ⚠️ `parseInt(x) || 0` in the old MembersView comparator did exactly this.
    expect(compareValues(0, 5, 'number')).toBeLessThan(0)
    expect(compareValues(0, -5, 'number')).toBeGreaterThan(0)
  })

  it('handles negatives', () => {
    expect(compareValues(-5, 3, 'number')).toBeLessThan(0)
  })

  it('compares text case-insensitively', () => {
    expect(compareValues('alice', 'Bob', 'text')).toBeLessThan(0)
    expect(compareValues('Zoe', 'adam', 'text')).toBeGreaterThan(0)
  })

  it('compares dates through parseDbTime, not as strings', () => {
    // ⚠️ Postgres `+00`. `new Date` rejects it outright (#140), so a string
    // compare is the only thing that ever "worked" — and only by luck.
    const earlier = '2026-09-25T00:25:41.074+00'
    const later = '2026-09-26T00:25:41.074+00'
    expect(compareValues(earlier, later, 'date')).toBeLessThan(0)
    expect(compareValues(later, earlier, 'date')).toBeGreaterThan(0)
  })

  it('sorts dates correctly across formats that a string sort would get wrong', () => {
    // Same instant, two shapes. A lexical compare says these differ.
    const withOffset = '2026-09-25T12:00:00+00'
    const withZ = '2026-09-25T12:00:00Z'
    expect(compareValues(withOffset, withZ, 'date')).toBe(0)
  })

  it('treats an unparseable date as missing rather than as zero', () => {
    // ⚠️ Epoch 0 would sort it to 1970 and put it first; it belongs with the
    // other unknowns, at the end.
    expect(compareValues('not a date', '2026-01-01T00:00:00Z', 'date')).toBeGreaterThan(0)
  })

  it('orders booleans false before true, stated rather than accidental', () => {
    expect(compareValues(false, true, 'bool')).toBeLessThan(0)
    expect(compareValues(true, true, 'bool')).toBe(0)
  })
})

describe('nulls', () => {
  const rows = [
    { name: 'a', score: 5 },
    { name: 'b', score: null },
    { name: 'c', score: 10 },
    { name: 'd', score: undefined },
  ]

  it('puts them last ascending', () => {
    expect(sort(rows, 'score', 'asc').map(r => r.name)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('puts them last DESCENDING too', () => {
    // ⚠️ THE rule. Reversing a sort reverses the populated rows; it does not
    // drag the empty ones to the top. The audit found nulls returning 0 and
    // landing in arbitrary positions, which reads as a broken sort rather than
    // as missing data.
    expect(sort(rows, 'score', 'desc').map(r => r.name)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps nulls in a stable order among themselves', () => {
    // b and d are both empty, so the tie-break decides — not arrival order.
    expect(sort(rows, 'score', 'desc').slice(2).map(r => r.name)).toEqual(['b', 'd'])
  })

  it('treats an empty string as missing for text', () => {
    const r = [{ name: 'z' }, { name: '' }, { name: 'a' }]
    expect(sortRows(r, COLS, 'name', 'asc').map(x => x.name)).toEqual(['a', 'z', ''])
  })
})

describe('stability', () => {
  it('breaks ties on the tie-break column, in a FIXED direction', () => {
    // ⚠️ Lifted from RollCallResultsTable, where the comment explains why:
    // without it the order within a group depends on arrival order, so the
    // table reshuffles under a lead as responses come in. CompetitionsSection
    // has a real tie (two members on 15) that exposes this.
    const rows = [
      { name: 'carol', score: 15 },
      { name: 'alice', score: 15 },
      { name: 'bob', score: 20 },
    ]
    expect(sort(rows, 'score', 'desc').map(r => r.name)).toEqual(['bob', 'alice', 'carol'])
    // Reversing the primary must NOT reverse the tie-break.
    expect(sort(rows, 'score', 'asc').map(r => r.name)).toEqual(['alice', 'carol', 'bob'])
  })

  it('gives the same answer for the same input, twice', () => {
    const rows = [{ name: 'a', score: 1 }, { name: 'b', score: 1 }, { name: 'c', score: 1 }]
    const once = sort(rows, 'score', 'desc').map(r => r.name)
    const twice = sort(rows, 'score', 'desc').map(r => r.name)
    expect(once).toEqual(twice)
  })
})

describe('sortRows', () => {
  it('does not mutate the input', () => {
    // ⚠️ The hook must make the React footgun impossible, not merely avoided.
    const rows = [{ name: 'b', score: 2 }, { name: 'a', score: 1 }]
    const snapshot = [...rows]
    sort(rows, 'score', 'asc')
    expect(rows).toEqual(snapshot)
  })

  it('sorts on the accessor, never on the rendered cell', () => {
    // ⚠️ DashboardView renders Score as "42015 - 54904". Sorting that string is
    // a lexical sort on a composite — this is the mechanism that prevents it.
    const cols = [{ key: 'score', kind: 'number', accessor: r => r.our_score }]
    const rows = [
      { label: '7205 - 18167', our_score: 7205 },
      { label: '42015 - 54904', our_score: 42015 },
    ]
    expect(sortRows(rows, cols, 'score', 'desc')[0].our_score).toBe(42015)
  })

  it("honours a column's own comparator over its kind", () => {
    // ⚠️ RollCallResultsTable sorts availability by ORDER, not label text:
    // alphabetical buries "On time" between "6+ late" and "Will not be
    // available". A bespoke comparator must win.
    const order = ['on_time', 'late', 'never']
    const cols = [{ key: 'avail', compare: (a, b) => order.indexOf(a) - order.indexOf(b) }]
    const rows = [{ avail: 'never' }, { avail: 'on_time' }, { avail: 'late' }]
    expect(sortRows(rows, cols, 'avail', 'asc').map(r => r.avail))
      .toEqual(['on_time', 'late', 'never'])
  })

  it('falls back to the rows unchanged for an unknown column', () => {
    const rows = [{ name: 'b' }, { name: 'a' }]
    expect(sortRows(rows, COLS, 'nope', 'asc').map(r => r.name)).toEqual(['b', 'a'])
  })

  it('survives an empty list and a missing list', () => {
    expect(sortRows([], COLS, 'name', 'asc')).toEqual([])
    expect(sortRows(undefined, COLS, 'name', 'asc')).toEqual([])
  })
})

describe('nextDirection', () => {
  it('toggles when the same column is clicked', () => {
    expect(nextDirection('score', 'score', 'asc')).toBe('desc')
    expect(nextDirection('score', 'score', 'desc')).toBe('asc')
  })

  it('starts a new column ascending', () => {
    expect(nextDirection('name', 'score', 'desc')).toBe('asc')
  })
})

describe('tieBreak as a list', () => {
  // ⚠️ Shared positions make ties the NORM on a leaderboard, not an edge case:
  // a whole faction at level 100 sits at rank 1 together. A single-column
  // tie-break then orders the entire board alphabetically, which is what the
  // Hall of Fame shipped doing.
  const COLUMNS = [
    { key: 'factionRank', accessor: (r) => r.factionRank, kind: 'number' },
    { key: 'globalRank', accessor: (r) => r.globalRank ?? null, kind: 'number' },
    { key: 'name', accessor: (r) => r.name, kind: 'text' },
  ]
  const rows = [
    { name: 'Albatra', factionRank: 1, globalRank: 3089 },
    { name: 'AlleyCat', factionRank: 1, globalRank: 280 },
    { name: 'Goosey', factionRank: 1, globalRank: 1452 },
    { name: 'Zeta', factionRank: 2, globalRank: 9 },
  ]
  const names = (out) => out.map((r) => r.name)

  it('settles a tie on the first list entry that separates the rows', () => {
    const out = sortRows(rows, COLUMNS, 'factionRank', 'asc', {
      tieBreak: ['globalRank', 'name'],
    })
    expect(names(out)).toEqual(['AlleyCat', 'Goosey', 'Albatra', 'Zeta'])
  })

  it('still accepts a single key, as every existing caller passes', () => {
    const out = sortRows(rows, COLUMNS, 'factionRank', 'asc', { tieBreak: 'name' })
    expect(names(out)).toEqual(['Albatra', 'AlleyCat', 'Goosey', 'Zeta'])
  })

  it('⚠️ skips a tie column that is the sorted column and uses the next', () => {
    // Sorting BY global rank must still fall through to the name, not stop.
    const tied = [
      { name: 'Beta', factionRank: 3, globalRank: 50 },
      { name: 'Alpha', factionRank: 1, globalRank: 50 },
    ]
    const out = sortRows(tied, COLUMNS, 'globalRank', 'asc', {
      tieBreak: ['globalRank', 'name'],
    })
    expect(names(out)).toEqual(['Alpha', 'Beta'])
  })

  it('⚠️ sinks a member with no global rank within their tie group', () => {
    // #351: absent is not "worst placed", it is unplaced — and the name still
    // settles the unplaced among themselves rather than leaving them to arrive
    // in whatever order the data did.
    const withGaps = [
      { name: 'Zed', factionRank: 1, globalRank: null },
      { name: 'Ava', factionRank: 1, globalRank: null },
      { name: 'Mid', factionRank: 1, globalRank: 700 },
    ]
    const out = sortRows(withGaps, COLUMNS, 'factionRank', 'asc', {
      tieBreak: ['globalRank', 'name'],
    })
    expect(names(out)).toEqual(['Mid', 'Ava', 'Zed'])
  })

  it('is stable across repeated sorts, which is the point of a tie-break', () => {
    const once = sortRows(rows, COLUMNS, 'factionRank', 'asc', { tieBreak: ['globalRank', 'name'] })
    const twice = sortRows(once, COLUMNS, 'factionRank', 'asc', { tieBreak: ['globalRank', 'name'] })
    expect(names(twice)).toEqual(names(once))
  })
})
