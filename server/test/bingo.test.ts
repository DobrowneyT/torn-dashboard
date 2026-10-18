// #965 — event bingo: the pure rules.
import { describe, expect, it } from 'vitest'
import {
  completedLines, checkCard, HALLOWEEN_TEMPLATE, AUTO_RULE_KEYS, type Tile,
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
  it('fills its grid, with one free square, and every automatic rule exists', () => {
    const { rows, cols, tiles } = HALLOWEEN_TEMPLATE
    expect(tiles).toHaveLength(rows * cols)
    expect(tiles.filter((t) => t.kind === 'free')).toHaveLength(1)
    for (const t of tiles.filter((x) => x.kind === 'auto')) {
      expect(AUTO_RULE_KEYS.has(t.rule!)).toBe(true)
      expect(RULE_SQL[t.rule!]).toBeTruthy()
    }
  })

  it('every rule offered in Settings has SQL behind it', () => {
    for (const key of AUTO_RULE_KEYS) expect(RULE_SQL[key]).toBeTruthy()
  })
})
