// Our members' battle stats in the War Room Stats column (#353).
import { describe, it, expect } from 'vitest'
import {
  indexBattleStats, withBattleStats, statsSourceLabel, isExactStatsSource,
  battleStatsSortValue, matchesStatsSource,
} from '../warRoomBattleStats'

const row = (over = {}) => ({
  member_id: 1700,
  member_name: 'Ours',
  strength: 1_000_000,
  defense: 2_000_000,
  speed: 3_000_000,
  dexterity: 4_000_000,
  total: 10_000_000,
  source: 'torn',
  fetched_at: '2026-08-08T02:45:00+00',
  spy_at: null,
  ...over,
})

describe('indexBattleStats', () => {
  it('indexes by member id as a string', () => {
    // The API serves member_id from a text column but roster rows carry it as
    // a number; every lookup in the view stringifies.
    expect(indexBattleStats([row()])['1700'].total).toBe(10_000_000)
  })

  it('tolerates an absent or junk payload', () => {
    expect(indexBattleStats()).toEqual({})
    expect(indexBattleStats([])).toEqual({})
    expect(indexBattleStats([null, { total: 5 }])).toEqual({})
  })
})

describe('withBattleStats', () => {
  const members = [{ member_id: 1700, member_name: 'Ours' }, { member_id: 1701, member_name: 'Other' }]

  it('projects onto the field names the Stats cell already reads', () => {
    // The whole point of the projection: BspCell, the Stats sort, the farm
    // sort and the min/max filter all read bsp_* off the member row. Mapping
    // into those names means none of them need a second code path.
    const [first] = withBattleStats(members, indexBattleStats([row()]))
    expect(first).toMatchObject({
      bsp_total: 10_000_000,
      bsp_str: 1_000_000,
      bsp_def: 2_000_000,
      bsp_spd: 3_000_000,
      bsp_dex: 4_000_000,
      spy_source: 'torn',
      bsp_fetched_at: '2026-08-08T02:45:00+00',
    })
  })

  it('leaves a member with no stats row showing as unknown', () => {
    const [, second] = withBattleStats(members, indexBattleStats([row()]))
    expect(second.bsp_total).toBeNull()
  })

  it('keeps every original roster field', () => {
    // The projected rows go straight into the table — losing status or
    // last_action here would blank most of the row.
    const rich = [{ member_id: 1700, member_name: 'Ours', status_state: 'Okay', level: 60 }]
    expect(withBattleStats(rich, indexBattleStats([row()]))[0])
      .toMatchObject({ status_state: 'Okay', level: 60, member_name: 'Ours' })
  })

  it('does not mutate the rows it was given', () => {
    // They are the socket's own array; writing through them would corrupt the
    // enemy-side board on the way back.
    const original = { member_id: 1700, member_name: 'Ours' }
    withBattleStats([original], indexBattleStats([row()]))
    expect(original.bsp_total).toBeUndefined()
  })

  it('maps a TornStats spy timestamp so the age reads from the spy, not the poll', () => {
    const ts = row({ source: 'tornstats', spy_at: '2026-08-01T10:00:00+00' })
    expect(withBattleStats(members, indexBattleStats([ts]))[0])
      .toMatchObject({ spy_source: 'tornstats', ts_spy_at: '2026-08-01T10:00:00+00' })
  })

  it('returns the rows untouched when there are no stats at all', () => {
    // Before the first daily run, or for a viewer whose fetch failed.
    expect(withBattleStats(members, {})[0].bsp_total).toBeNull()
    expect(withBattleStats(members)[0].bsp_total).toBeNull()
  })

  it('survives an empty roster', () => {
    expect(withBattleStats([], indexBattleStats([row()]))).toEqual([])
    expect(withBattleStats()).toEqual([])
  })
})

describe('statsSourceLabel', () => {
  it('distinguishes an exact figure from the two estimates', () => {
    // The load-bearing one. A member's own key returns their real stats;
    // labelling that "BSP" would present fact as a guess, and the reverse
    // would be worse — a lead sizing a target off a prediction they believe
    // is exact.
    expect(statsSourceLabel('torn')).toBe('API')
    expect(statsSourceLabel('tornstats')).toBe('TS')
    expect(statsSourceLabel('bsp')).toBe('BSP')
  })

  it('falls back to the weakest claim for an unknown source', () => {
    // Enemy rows carry no source at all and are BSP or TS; defaulting to the
    // estimate label never overstates what we know.
    expect(statsSourceLabel(null)).toBe('BSP')
    expect(statsSourceLabel(undefined)).toBe('BSP')
    expect(statsSourceLabel('mystery')).toBe('BSP')
  })
})

describe('isExactStatsSource', () => {
  it('is true only for the member own-key reading', () => {
    expect(isExactStatsSource('torn')).toBe(true)
    expect(isExactStatsSource('tornstats')).toBe(false)
    expect(isExactStatsSource('bsp')).toBe(false)
    expect(isExactStatsSource(null)).toBe(false)
  })
})

describe('battleStatsSortValue (#355)', () => {
  it('returns the total as a number', () => {
    expect(battleStatsSortValue({ bsp_total: 2_600_000_000 })).toBe(2_600_000_000)
    expect(battleStatsSortValue({ bsp_total: '5000' })).toBe(5000)
  })

  it('returns null — not 0 — when there is no reading', () => {
    // The #351 rule. Callers sink nulls in BOTH directions: "who is weakest"
    // is not answered by a member we have never read, and folding them in as
    // zero buries the members the sort was meant to surface.
    expect(battleStatsSortValue({ bsp_total: null })).toBeNull()
    expect(battleStatsSortValue({})).toBeNull()
    expect(battleStatsSortValue(undefined)).toBeNull()
    // A genuine zero is a reading and must survive as one.
    expect(battleStatsSortValue({ bsp_total: 0 })).toBe(0)
  })

  it('sinks unread members at both ends under the page sort', () => {
    // Mirrors MemberOverview's comparator: the null branches are deliberately
    // NOT multiplied by direction.
    const cmp = (dir) => (a, b) => {
      const va = battleStatsSortValue(a)
      const vb = battleStatsSortValue(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return dir * ((va > vb) - (va < vb))
    }
    const rows = [
      { id: 'mid', bsp_total: 5 },
      { id: 'none', bsp_total: null },
      { id: 'big', bsp_total: 9 },
    ]
    expect([...rows].sort(cmp(1)).map(r => r.id)).toEqual(['mid', 'big', 'none'])
    expect([...rows].sort(cmp(-1)).map(r => r.id)).toEqual(['big', 'mid', 'none'])
  })
})

describe('matchesStatsSource (#355)', () => {
  const own = { bsp_total: 1, spy_source: 'torn' }
  const ts = { bsp_total: 1, spy_source: 'tornstats' }
  const bsp = { bsp_total: 1, spy_source: 'bsp' }
  const unread = { bsp_total: null, spy_source: null }

  it('passes everything on "any"', () => {
    for (const r of [own, ts, bsp, unread]) {
      expect(matchesStatsSource(r, 'any')).toBe(true)
      expect(matchesStatsSource(r, undefined)).toBe(true)
    }
  })

  it('isolates each source', () => {
    expect(matchesStatsSource(own, 'torn')).toBe(true)
    expect(matchesStatsSource(ts, 'torn')).toBe(false)
    expect(matchesStatsSource(bsp, 'bsp')).toBe(true)
  })

  it('finds the members we only have a guess for — the chase-for-a-key list', () => {
    expect(matchesStatsSource(bsp, 'bsp')).toBe(true)
    expect(matchesStatsSource(own, 'bsp')).toBe(false)
  })

  it('separates "no reading" from "BSP estimate"', () => {
    // An unread member is not a BSP row. Conflating them would put people we
    // have never measured on the list of people whose estimate we distrust.
    expect(matchesStatsSource(unread, 'none')).toBe(true)
    expect(matchesStatsSource(unread, 'bsp')).toBe(false)
    expect(matchesStatsSource(bsp, 'none')).toBe(false)
  })

  it('treats a missing source on a read member as BSP, matching the label', () => {
    // statsSourceLabel falls back to BSP for unknown sources; the filter has to
    // agree or the column and the filter would disagree about the same row.
    expect(matchesStatsSource({ bsp_total: 1, spy_source: null }, 'bsp')).toBe(true)
  })
})
