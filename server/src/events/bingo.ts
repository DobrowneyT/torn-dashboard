// Event bingo (#965) — the pure parts: which squares the dashboard can tick by
// itself, the starter card, and how lines are counted.
//
// ⚠️ **An automatic square is only as good as the data behind it.** Every rule
// here reads something the dashboard ALREADY stores and has been seen carrying
// real values. Anything the API cannot see — gifts, races, friendships,
// surviving on 10% life — is a proof square, reviewed by leadership.

/** Chain counts that are bonus hits. Respect on these is not "earned" in the bingo sense. */
export const BONUS_CHAIN_HITS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]

/** 11, 22 … 99 and 111 … 999 — the card's "repeating-number chain target". */
export const REPEATING_CHAIN_HITS = [
  11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 222, 333, 444, 555, 666, 777, 888, 999,
]

export interface AutoRule {
  key: string
  label: string
  /** Where the answer comes from, said plainly in Settings. */
  source: string
}

export const AUTO_RULES: AutoRule[] = [
  { key: 'ranked_war_attack', label: 'Make a ranked war attack', source: 'attacks' },
  { key: 'respect_over_10', label: 'Over 10 respect from one attack (bonus hits excluded)', source: 'attacks' },
  { key: 'repeating_chain', label: 'Hit a repeating-number chain target (11 … 999)', source: 'attacks' },
  { key: 'hit_over_10000', label: 'Over 10,000 damage in a single hit', source: 'attack logs' },
  { key: 'hit_1310_1340', label: '1,310–1,340 damage in a single hit', source: 'attack logs' },
  { key: 'mugged_for_1', label: 'Get mugged for $1 (not by our own faction)', source: 'attack logs' },
  { key: 'bounties_over_50', label: 'Claim more than 50 bounties', source: 'attack logs' },
  { key: 'chain_watch', label: 'Take part in a faction chain watch', source: 'Chain Watch' },
  { key: 'travel', label: 'Travel to another country', source: 'activity samples' },
]

export const AUTO_RULE_KEYS = new Set(AUTO_RULES.map((r) => r.key))

export type TileKind = 'proof' | 'auto' | 'free'
export interface Tile { idx: number; label: string; kind: TileKind; rule: string | null }

/**
 * The Halloween card MonChoon shared (2026-10-18), row-major, 4 × 5 with the
 * free space in the middle. A starting point — every square is editable.
 */
export const HALLOWEEN_TEMPLATE: { rows: number; cols: number; tiles: Omit<Tile, 'idx'>[] } = {
  rows: 4,
  cols: 5,
  tiles: [
    { label: 'Make a ranked war attack', kind: 'auto', rule: 'ranked_war_attack' },
    { label: 'Earn over 10 faction respect from a single attack (bonus hits excluded)', kind: 'auto', rule: 'respect_over_10' },
    { label: 'Deal over 10,000 damage in a single hit', kind: 'auto', rule: 'hit_over_10000' },
    { label: 'Deal between 1,310 and 1,340 damage in a single hit', kind: 'auto', rule: 'hit_1310_1340' },
    { label: 'Win a 1v1 fight against a player with similar stats', kind: 'proof', rule: null },
    { label: 'Hit a repeating-number chain target (bonus hits excluded)', kind: 'auto', rule: 'repeating_chain' },
    { label: 'Send a gift to your faction mate', kind: 'proof', rule: null },
    { label: 'Participate in a faction-held race', kind: 'proof', rule: null },
    { label: 'Get mugged for $1 (mugs within the faction family don\'t count)', kind: 'auto', rule: 'mugged_for_1' },
    { label: 'Make a new friend in the faction (include chat logs as proof)', kind: 'proof', rule: null },
    { label: 'Survive a tough fight (with less than 10% of your life remaining)', kind: 'proof', rule: null },
    { label: 'Help a new player in the faction', kind: 'proof', rule: null },
    { label: 'Free space', kind: 'free', rule: null },
    { label: 'Claim more than 50 bounties', kind: 'auto', rule: 'bounties_over_50' },
    { label: 'Take part in a faction chain watching', kind: 'auto', rule: 'chain_watch' },
    { label: 'Win a fight against a player with at least twice your stats', kind: 'proof', rule: null },
    { label: 'Use a Halloween item (e.g. pumpkin, candy, Halloween gear)', kind: 'proof', rule: null },
    { label: 'Travel to another country', kind: 'auto', rule: 'travel' },
    { label: 'Complete a faction task', kind: 'proof', rule: null },
    { label: 'Win a race (regular race or faction race both count)', kind: 'proof', rule: null },
  ],
}

/** Where the grid sits on the image (percent) for the shared Halloween art. */
export const HALLOWEEN_GRID = { left: 3.8, top: 29.5, right: 96.3, bottom: 84.4 }

/**
 * How many complete lines a set of crossed squares makes.
 *
 * Rows, columns, and both diagonals when the card is square. The free square
 * counts as crossed — that is what it is for.
 */
export function completedLines(rows: number, cols: number, crossed: Set<number>): number {
  const has = (r: number, c: number) => crossed.has(r * cols + c)
  let lines = 0
  for (let r = 0; r < rows; r++) {
    let all = true
    for (let c = 0; c < cols; c++) if (!has(r, c)) { all = false; break }
    if (all) lines++
  }
  for (let c = 0; c < cols; c++) {
    let all = true
    for (let r = 0; r < rows; r++) if (!has(r, c)) { all = false; break }
    if (all) lines++
  }
  if (rows === cols) {
    let d1 = true
    let d2 = true
    for (let i = 0; i < rows; i++) {
      if (!has(i, i)) d1 = false
      if (!has(i, cols - 1 - i)) d2 = false
    }
    if (d1) lines++
    if (d2) lines++
  }
  return lines
}

/** Validate a Settings save. Returns an error message, or null. */
export function checkCard(b: {
  rows: number; cols: number
  grid: { left: number; top: number; right: number; bottom: number }
  tiles: Tile[]
}): string | null {
  const { rows, cols, grid, tiles } = b
  if (!Number.isInteger(rows) || rows < 1 || rows > 10) return 'Rows must be 1 to 10.'
  if (!Number.isInteger(cols) || cols < 1 || cols > 10) return 'Columns must be 1 to 10.'
  for (const k of ['left', 'top', 'right', 'bottom'] as const) {
    const v = grid[k]
    if (!Number.isFinite(v) || v < 0 || v > 100) return 'Grid edges must be between 0 and 100%.'
  }
  if (grid.right <= grid.left || grid.bottom <= grid.top) return 'The grid\'s right and bottom edges must be past its left and top.'
  if (tiles.length > rows * cols) return 'More squares than the grid holds.'
  for (const t of tiles) {
    if (!Number.isInteger(t.idx) || t.idx < 0 || t.idx >= rows * cols) return 'A square is outside the grid.'
    if (!['proof', 'auto', 'free'].includes(t.kind)) return 'Each square is proof, automatic or free.'
    if (t.kind === 'auto' && !AUTO_RULE_KEYS.has(t.rule ?? '')) return `Square ${t.idx + 1} is automatic but has no rule.`
    if ((t.label ?? '').length > 200) return 'Square text is limited to 200 characters.'
  }
  return null
}
