// Event bingo (#965) — the pure parts: which squares the dashboard can tick by
// itself, the starter card, and how lines are counted.
//
// ⚠️ **An automatic square is only as good as the data behind it.** Every rule
// here reads something the dashboard ALREADY stores and has been seen carrying
// real values. Anything the API cannot see — gifts, races, friendships,
// surviving on 10% life — is a proof square, reviewed by leadership.
//
// ⚠️ **Thresholds are the square's `params`, not the rule's name** (second
// card, 2026-10-19). "15 respect" and "13,000 damage" are numbers leadership
// can change in Settings; a rule only says WHAT is measured.

/** Chain counts that are bonus hits. Respect on these is not "earned" in the bingo sense. */
export const BONUS_CHAIN_HITS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]

/**
 * "11, 22 … 99, 111 … and so on": every repeating-digit number from 11 up to
 * 99,999 — further than any chain this faction will reach in an event.
 */
export const REPEATING_CHAIN_HITS: number[] = (() => {
  const out: number[] = []
  for (let len = 2; len <= 5; len++) for (let d = 1; d <= 9; d++) out.push(Number(String(d).repeat(len)))
  return out
})()

/**
 * Results that are WINS. MonChoon (2026-10-19): hit counts on the card count
 * wins only — losses, assists, stalemates, escapes and timeouts do not.
 */
export const WIN_RESULTS = ['Attacked', 'Hospitalized', 'Mugged', 'Arrested', 'Looted', 'Special']

export interface ParamSpec {
  key: string
  label: string
  /** number: one value; ids: a comma-separated list of Torn ids. */
  kind: 'number' | 'ids'
}

export interface AutoRule {
  key: string
  /** Settings label; `{min}`-style placeholders are filled from the square's params. */
  label: string
  /** Where the answer comes from, said plainly in Settings. */
  source: string
  params: ParamSpec[]
}

export const AUTO_RULES: AutoRule[] = [
  { key: 'ranked_war_attack', label: 'Make a ranked war attack', source: 'attacks', params: [] },
  { key: 'respect_at_least', label: 'At least {min} respect from one attack (bonus hits excluded)', source: 'attacks',
    params: [{ key: 'min', label: 'Respect', kind: 'number' }] },
  { key: 'repeating_chain', label: 'Hit a repeating-number chain target (11, 22 … 111 … 1111 …)', source: 'attacks', params: [] },
  { key: 'wins_over', label: 'More than {count} wins in the event', source: 'attacks',
    params: [{ key: 'count', label: 'Wins', kind: 'number' }] },
  { key: 'wins_in_window', label: '{count} wins within {seconds} seconds', source: 'attacks',
    params: [{ key: 'count', label: 'Wins', kind: 'number' }, { key: 'seconds', label: 'Seconds', kind: 'number' }] },
  { key: 'retal', label: 'Win a retaliation', source: 'attacks', params: [] },
  { key: 'overseas_hosp', label: 'Hospitalize someone abroad (Early Discharge not checked)', source: 'attacks', params: [] },
  { key: 'hit_over', label: 'A single hit over {min} damage', source: 'attack logs',
    params: [{ key: 'min', label: 'Damage', kind: 'number' }] },
  { key: 'hit_between', label: 'A single hit of {min}–{max} damage', source: 'attack logs',
    params: [{ key: 'min', label: 'From', kind: 'number' }, { key: 'max', label: 'To', kind: 'number' }] },
  { key: 'hit_exact', label: 'A single hit of exactly {value} damage', source: 'attack logs',
    params: [{ key: 'value', label: 'Damage', kind: 'number' }] },
  { key: 'mug_over', label: 'Mug someone for over ${min}', source: 'attack logs',
    params: [{ key: 'min', label: 'Dollars', kind: 'number' }] },
  { key: 'mugged_for_1', label: 'Get mugged for $1 (not by our own faction)', source: 'attack logs', params: [] },
  { key: 'bounties_at_least', label: 'Claim at least {count} bounties', source: 'attack logs',
    params: [{ key: 'count', label: 'Bounties', kind: 'number' }] },
  { key: 'avenge_bounty', label: 'Beat someone who claimed a bounty on a faction mate (both in the event)', source: 'attack logs', params: [] },
  { key: 'revitalize_streak', label: 'Revitalize procs on {count} attacks in a row', source: 'attack logs',
    params: [{ key: 'count', label: 'Attacks', kind: 'number' }] },
  { key: 'loot_from', label: 'Loot from any of: {ids}', source: 'attack logs',
    params: [{ key: 'ids', label: 'NPC ids', kind: 'ids' }] },
  { key: 'chain_watch', label: 'Take part in a faction chain watch', source: 'Chain Watch', params: [] },
  { key: 'travel', label: 'Travel to another country', source: 'activity samples', params: [] },
]

export const AUTO_RULE_KEYS = new Set(AUTO_RULES.map((r) => r.key))
const RULE_BY_KEY = new Map(AUTO_RULES.map((r) => [r.key, r]))

export type TileKind = 'proof' | 'auto' | 'free'
export type TileParams = Record<string, number | number[]>
export interface Tile {
  idx: number
  label: string
  kind: TileKind
  rule: string | null
  params?: TileParams
  /** What counts, and what proof to send. */
  hint?: string | null
}

/** M'aol and his minions (MonChoon, 2026-10-19; https://wiki.torn.com/wiki/M%27aol). */
export const MAOL_AND_MINIONS = [23, 100, 101, 102, 103, 104]

/**
 * The TNL Forge Halloweek card (2026-10-19), row-major, 5 × 5, no free space.
 * A starting point — every square is editable.
 */
export const HALLOWEEN_TEMPLATE: { rows: number; cols: number; tiles: Omit<Tile, 'idx'>[] } = {
  rows: 5,
  cols: 5,
  tiles: [
    { label: 'Make a ranked war attack', kind: 'auto', rule: 'ranked_war_attack',
      hint: 'Any attack in a ranked war. Crossed automatically.' },
    { label: 'Earn 15 respect from a single attack', kind: 'auto', rule: 'respect_at_least', params: { min: 15 },
      hint: 'One attack worth 15 or more respect. Bonus hits don\'t count.' },
    { label: 'Deal over 13,000 damage in a single hit', kind: 'auto', rule: 'hit_over', params: { min: 13000 },
      hint: 'One hit of more than 13,000 damage, read from your attack logs.' },
    { label: 'Make a new friend in faction (add them as a friend)', kind: 'proof', rule: null,
      hint: 'Add a faction mate as a friend. Send a screenshot of them on your friends list, or the chat where you got talking.' },
    { label: 'Defeat someone who claimed a bounty on a faction mate', kind: 'auto', rule: 'avenge_bounty',
      hint: 'Someone hospitalizes a faction mate and claims a bounty during the event — beat that person during the event.' },

    { label: 'Hit a repeating number in chain target (11, 22 … 99, 111 and so on)', kind: 'auto', rule: 'repeating_chain',
      hint: 'Land chain hit 11, 22 … 99, 111 … 999, 1111 and so on. Crossed automatically.' },
    { label: 'Send a gift to a faction mate', kind: 'proof', rule: null,
      hint: 'Send the event log line or a screenshot showing the gift going to a faction mate.' },
    { label: 'Participate in a faction-held race', kind: 'proof', rule: null,
      hint: 'A screenshot of the race results with you in it.' },
    { label: 'Defeat someone with 3x your stats', kind: 'proof', rule: null,
      hint: 'The attack log of the win, plus where their stats came from (a spy, TornStats). Leadership checks the estimate.' },
    { label: 'Help a sub-365-day player and send them a can', kind: 'proof', rule: null,
      hint: 'The player must be under 365 days old. Send the gift log line and a screenshot of their profile age.' },

    { label: 'Participate in the clothing comp', kind: 'proof', rule: null,
      hint: 'A screenshot of your entry.' },
    { label: 'Claim 50 bounties', kind: 'auto', rule: 'bounties_at_least', params: { count: 50 },
      hint: 'Fifty bounties claimed during the event, read from your attack logs.' },
    { label: 'Defeat someone abroad who doesn\'t have ED and hosp them', kind: 'proof', rule: null,
      hint: 'Hospitalize someone abroad who had no Early Discharge. Send the attack log link; leadership checks the ED part.' },
    { label: 'Make over 420 hits', kind: 'auto', rule: 'wins_over', params: { count: 420 },
      hint: 'More than 420 WINS during the event. Losses, assists and stalemates don\'t count.' },
    { label: 'Earn loot from M\'aol and minions', kind: 'auto', rule: 'loot_from', params: { ids: MAOL_AND_MINIONS },
      hint: 'Any loot from M\'aol or one of his minions, read from your attack logs.' },

    { label: 'Get above 1000 hits done', kind: 'auto', rule: 'wins_over', params: { count: 1000 },
      hint: 'More than 1,000 WINS during the event.' },
    { label: 'Make a retal', kind: 'auto', rule: 'retal',
      hint: 'Win an attack that earns the retaliation bonus.' },
    { label: 'Make 100 hits in less than 5 mins', kind: 'auto', rule: 'wins_in_window', params: { count: 100, seconds: 300 },
      hint: '100 WINS inside any 5-minute span.' },
    { label: 'Take part in chain watching', kind: 'auto', rule: 'chain_watch',
      hint: 'Sign up for a chain-watch hour and watch it. Crossed once your hour starts.' },
    { label: 'Mug someone for over 100M', kind: 'auto', rule: 'mug_over', params: { min: 100_000_000 },
      hint: 'One mug of more than $100,000,000, read from your attack logs.' },

    { label: 'Send a can to an active chain watcher', kind: 'proof', rule: null,
      hint: 'Send a can to someone during their chain-watch hour. Send the gift log line; leadership checks they were on watch.' },
    { label: 'Deal damage of 1337', kind: 'auto', rule: 'hit_exact', params: { value: 1337 },
      hint: 'One hit of exactly 1,337 damage, read from your attack logs.' },
    { label: 'Revitalize procs on 4 attacks in a row', kind: 'auto', rule: 'revitalize_streak', params: { count: 4 },
      hint: 'Revitalize can only proc once, at the end of a win. Get it on 4 of your attacks in a row.' },
    { label: 'Get mugged for $1', kind: 'auto', rule: 'mugged_for_1',
      hint: 'Mugged for exactly $1 by someone outside our faction.' },
    { label: 'Survive a fight with less than 10% life remaining', kind: 'proof', rule: null,
      hint: 'A screenshot of the end of the fight showing your life under 10%.' },
  ],
}

/** Where the grid sits on the Forge card art (percent), with the gap between squares. */
export const HALLOWEEN_GRID = { left: 2.5, top: 26, right: 97.5, bottom: 91, gap: 4 }

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

/** A square's params, kept to what its rule declares and coerced to numbers. */
export function cleanParams(rule: string | null, raw: unknown): TileParams | string {
  const spec = rule ? RULE_BY_KEY.get(rule) : null
  if (!spec) return {}
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: TileParams = {}
  for (const p of spec.params) {
    const v = src[p.key]
    if (p.kind === 'ids') {
      const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/))
        .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      if (list.length === 0) return `${p.label} needs at least one id.`
      out[p.key] = list
    } else {
      const n = Number(v)
      if (v === '' || v == null || !Number.isFinite(n) || n < 0) return `${p.label} must be a number.`
      out[p.key] = n
    }
  }
  return out
}

/** Validate a Settings save. Returns an error message, or null. */
export function checkCard(b: {
  rows: number; cols: number
  grid: { left: number; top: number; right: number; bottom: number; gap?: number }
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
  const gap = grid.gap ?? 0
  if (!Number.isFinite(gap) || gap < 0 || gap > 30) return 'The gap between squares must be 0 to 30%.'
  if (tiles.length > rows * cols) return 'More squares than the grid holds.'
  for (const t of tiles) {
    if (!Number.isInteger(t.idx) || t.idx < 0 || t.idx >= rows * cols) return 'A square is outside the grid.'
    if (!['proof', 'auto', 'free'].includes(t.kind)) return 'Each square is proof, automatic or free.'
    if (t.kind === 'auto' && !AUTO_RULE_KEYS.has(t.rule ?? '')) return `Square ${t.idx + 1} is automatic but has no rule.`
    if (t.kind === 'auto') {
      const p = cleanParams(t.rule, t.params)
      if (typeof p === 'string') return `Square ${t.idx + 1}: ${p}`
    }
    if ((t.label ?? '').length > 200) return 'Square text is limited to 200 characters.'
    if ((t.hint ?? '').length > 500) return 'A square\'s note is limited to 500 characters.'
  }
  return null
}
