// Per-member Hall of Fame (#872).
//
// ⚠️ The use case is BRAGGING RIGHTS (Singularity, 2026-10-03), which is why
// nothing here produces a judgement. The tests are weighted towards the three
// ways a leaderboard can quietly lie: ranking somebody who has no reading,
// breaking a genuine tie, and surfacing a category Torn will not give us.
import { describe, expect, it } from 'vitest'
import { readMemberHof, buildBoard, HOF_CATEGORIES } from '../src/memberHof.js'

// The live shape: every category is { value, rank }, rank being the GLOBAL
// Torn position.
const payload = (over: any = {}) => ({
  hof: {
    working_stats: { value: 12_000_000, rank: 48_000 },
    networth: { value: 5_000_000_000, rank: 9_100 },
    revives: { value: 0, rank: 900_000 },
    // ⚠️ Null for anyone but the requester — straight from the spec.
    battle_stats: null,
    ...over,
  },
})

describe('readMemberHof', () => {
  it('reads value and global rank per category', () => {
    const hof = readMemberHof(payload())
    expect(hof.working_stats).toEqual({ value: 12_000_000, rank: 48_000 })
    expect(hof.networth).toEqual({ value: 5_000_000_000, rank: 9_100 })
  })

  it('⚠️ never surfaces battle_stats — it is null for other players', () => {
    // "This field is null when requesting data for other players." A
    // roster-wide battle-stats board cannot be built by anyone, so the category
    // is excluded rather than rendered as an empty column that reads as a
    // scrape failure.
    const hof = readMemberHof(payload({ battle_stats: { value: 9_000_000_000, rank: 1 } }))
    expect(hof).not.toHaveProperty('battle_stats')
    expect(HOF_CATEGORIES).not.toContain('battle_stats' as never)
  })

  it('⚠️ keeps a genuine zero, which is a real standing', () => {
    // Somebody genuinely has no revives. That is a different fact from "Torn
    // did not tell us", and conflating them puts a member at the bottom of a
    // board rather than absent from it.
    expect(readMemberHof(payload()).revives).toEqual({ value: 0, rank: 900_000 })
  })

  it('omits a category Torn did not report, rather than storing zero', () => {
    const hof = readMemberHof(payload({ networth: null }))
    expect(hof).not.toHaveProperty('networth')
    expect(hof).toHaveProperty('working_stats')
  })

  it('keeps a value whose rank is missing — the figure still ranks internally', () => {
    const hof = readMemberHof(payload({ attacks: { value: 500 } }))
    expect(hof.attacks).toEqual({ value: 500, rank: null })
  })

  it('tolerates a bare payload without the hof wrapper', () => {
    expect(readMemberHof({ working_stats: { value: 7, rank: 2 } }).working_stats)
      .toEqual({ value: 7, rank: 2 })
  })

  it('survives a null or broken payload without throwing', () => {
    for (const p of [null, undefined, {}, { hof: null }, { hof: 'nope' }]) {
      expect(readMemberHof(p as any)).toEqual({})
    }
  })

  it('leads with working_stats — the category that was actually asked for', () => {
    expect(HOF_CATEGORIES[0]).toBe('working_stats')
  })
})

const member = (id: string, name: string, value: number | null, rank: number | null = 1) => ({
  member_id: id,
  member_name: name,
  hof: value === null ? {} : { working_stats: { value, rank } },
})

describe('buildBoard', () => {
  it('ranks the faction by value, highest first', () => {
    const board = buildBoard(
      [member('1', 'Low', 10), member('2', 'High', 30), member('3', 'Mid', 20)],
      'working_stats'
    )
    expect(board.map((r) => r.memberName)).toEqual(['High', 'Mid', 'Low'])
    expect(board.map((r) => r.factionRank)).toEqual([1, 2, 3])
  })

  it('carries the global rank beside the faction one', () => {
    // Singularity's own phrasing for the pairing: "3rd in forge, 48,000th in Torn".
    const board = buildBoard([member('1', 'Solo', 10, 48_000)], 'working_stats')
    expect(board[0]).toMatchObject({ factionRank: 1, globalRank: 48_000 })
  })

  it('⚠️ leaves out members with no reading — absent is not "worst"', () => {
    // Ranking an unread member last is the same mistake as sorting an unspied
    // battle-stat total as zero (#351).
    const board = buildBoard(
      [member('1', 'Known', 10), member('2', 'Unread', null)],
      'working_stats'
    )
    expect(board.map((r) => r.memberName)).toEqual(['Known'])
  })

  it('⚠️ gives tied members the SAME position', () => {
    // On a bragging-rights board, telling two people with identical numbers
    // that one of them is ahead is a lie the data does not support.
    const board = buildBoard(
      [member('1', 'Alice', 20), member('2', 'Bob', 20), member('3', 'Carol', 10)],
      'working_stats'
    )
    expect(board.map((r) => r.factionRank)).toEqual([1, 1, 3])
  })

  it('orders tied members by name, so the board does not reshuffle', () => {
    const board = buildBoard(
      [member('2', 'Zed', 20), member('1', 'Alice', 20)],
      'working_stats'
    )
    expect(board.map((r) => r.memberName)).toEqual(['Alice', 'Zed'])
  })

  it('returns an empty board for a category nobody has', () => {
    expect(buildBoard([member('1', 'A', 10)], 'racing_wins')).toEqual([])
  })

  it('falls back to the id when a member has no name', () => {
    const board = buildBoard([{ member_id: '77', member_name: null, hof: { working_stats: { value: 1, rank: null } } }], 'working_stats')
    expect(board[0].memberName).toBe('77')
  })

  it('survives empty input', () => {
    expect(buildBoard([], 'working_stats')).toEqual([])
    expect(buildBoard(undefined as any, 'working_stats')).toEqual([])
  })
})
