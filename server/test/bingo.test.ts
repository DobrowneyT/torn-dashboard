// #965 — event bingo: the pure rules.
import { describe, expect, it } from 'vitest'
import {
  completedLines, checkCard, cleanParams, HALLOWEEN_TEMPLATE, AUTO_RULE_KEYS, MAOL_AND_MINIONS,
  REPEATING_CHAIN_HITS, type Tile,
} from '../src/events/bingo.js'
import { RULE_SQL } from '../src/scraper/jobs/eventBingo.js'

describe('completedLines', () => {
  it('counts rows, columns and both diagonals on a square card', () => {
    const row = new Set([0, 1, 2, 3, 4])
    expect(completedLines(5, 5, row)).toBe(1)
    const col = new Set([2, 7, 12, 17, 22])
    expect(completedLines(5, 5, col)).toBe(1)
    const diag = new Set([0, 6, 12, 18, 24])
    expect(completedLines(5, 5, diag)).toBe(1)
    const both = new Set([0, 6, 12, 18, 24, 4, 8, 16, 20])
    expect(completedLines(5, 5, both)).toBe(2)
  })

  it('has no diagonals on a card that is not square', () => {
    expect(completedLines(4, 5, new Set([0, 6, 12, 18]))).toBe(0)
    expect(completedLines(4, 5, new Set([0, 5, 10, 15]))).toBe(1)
  })
})

describe('checkCard', () => {
  const ok = { rows: 5, cols: 5, grid: { left: 0, top: 0, right: 100, bottom: 100 }, tiles: [] as Tile[] }

  it('accepts a sensible card', () => {
    expect(checkCard(ok)).toBeNull()
  })

  it('refuses a grid inside out, too many squares, or an automatic square with no rule', () => {
    expect(checkCard({ ...ok, grid: { left: 50, top: 0, right: 40, bottom: 100 } })).toMatch(/right and bottom/)
    expect(checkCard({ ...ok, rows: 1, cols: 1, tiles: [
      { idx: 0, label: 'a', kind: 'proof', rule: null }, { idx: 1, label: 'b', kind: 'proof', rule: null }] })).toBeTruthy()
    expect(checkCard({ ...ok, tiles: [{ idx: 0, label: 'a', kind: 'auto', rule: 'nope' }] })).toMatch(/no rule/)
  })
})

describe('the Halloween template', () => {
  it('fills its 5 × 5 grid, every automatic square has a valid rule and params, every square has a note', () => {
    const { rows, cols, tiles } = HALLOWEEN_TEMPLATE
    expect(tiles).toHaveLength(rows * cols)
    for (const t of tiles) expect(t.hint).toBeTruthy()
    for (const t of tiles.filter((x) => x.kind === 'auto')) {
      expect(AUTO_RULE_KEYS.has(t.rule!)).toBe(true)
      expect(RULE_SQL[t.rule!]).toBeTruthy()
      expect(typeof cleanParams(t.rule, t.params)).toBe('object')
    }
    expect(checkCard({ rows, cols, grid: { left: 0, top: 0, right: 100, bottom: 100 },
      tiles: tiles.map((t, idx) => ({ ...t, idx })) })).toBeNull()
  })

  it('M\'aol and his minions are the loot square\'s ids', () => {
    expect(HALLOWEEN_TEMPLATE.tiles.find((t) => t.rule === 'loot_from')!.params).toEqual({ ids: MAOL_AND_MINIONS })
  })

  it('every rule offered in Settings has SQL behind it', () => {
    for (const key of AUTO_RULE_KEYS) expect(RULE_SQL[key]).toBeTruthy()
  })
})

describe('params', () => {
  it('keeps only what the rule declares, as numbers', () => {
    expect(cleanParams('respect_at_least', { min: '15', extra: 9 })).toEqual({ min: 15 })
    expect(cleanParams('loot_from', { ids: '23, 100 101' })).toEqual({ ids: [23, 100, 101] })
    expect(cleanParams('respect_at_least', {})).toMatch(/must be a number/)
    expect(cleanParams('loot_from', { ids: '' })).toMatch(/at least one id/)
  })

  it('a card with a bad threshold is refused', () => {
    expect(checkCard({ rows: 1, cols: 1, grid: { left: 0, top: 0, right: 100, bottom: 100 },
      tiles: [{ idx: 0, label: 'x', kind: 'auto', rule: 'hit_over', params: {} }] })).toMatch(/Square 1/)
  })

  it('"and so on" runs the repeating chain hits past 999', () => {
    expect(REPEATING_CHAIN_HITS).toContain(1111)
    expect(REPEATING_CHAIN_HITS).toContain(99999)
    expect(REPEATING_CHAIN_HITS).not.toContain(1000)
  })
})
