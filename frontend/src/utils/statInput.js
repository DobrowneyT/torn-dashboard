/**
 * Battle-stat number parsing and display, shared across every page that shows
 * them (#355).
 *
 * This lived twice already — once in WarRoomViewV2 and once in
 * MobileWarRoomView, the latter carrying a comment that it "mirrors" the
 * former. Member Overview would have been the third copy. Two pages that parse
 * `2.6b` differently is a bug nobody reports, because each page looks correct
 * on its own.
 */

/** k/m/b suffix multipliers. Torn stats are routinely quoted in these. */
const MULTIPLIERS = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }

/**
 * Parse a filter box entry into a number, or null when it isn't one.
 *
 * Accepts `3`, `3.5`, `0.8`, `.8` (leading-decimal shorthand), each optionally
 * followed by k/m/b. Rejects `3.` (trailing dot) and a bare `.`.
 *
 * Null means "no bound" rather than zero — an unparseable filter must not
 * silently become a filter that excludes everyone.
 */
export function parseStatInput(str) {
  if (!str?.trim()) return null
  const s = str.trim().toLowerCase()
  const m = s.match(/^(\d*\.?\d+)\s*([kmb]?)$/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (Number.isNaN(n)) return null
  return n * (MULTIPLIERS[m[2]] ?? 1)
}

/** Compact display for a stat total; `???` when there is no reading. */
export function formatStats(n) {
  if (n === null || n === undefined) return '???'
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + 'T'
  if (n >= 1_000_000_000)     return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000)         return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)             return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

/**
 * Does a total fall inside a min/max range typed into the filter boxes?
 *
 * A member with NO reading fails any bound. "Show me everyone over 3b" is a
 * question about known stats; an unknown one is not a small answer to it, it is
 * the absence of an answer — the same reasoning as the #351 sort rule. With no
 * bounds set, everyone passes, unknowns included.
 */
export function matchesStatRange(total, minInput, maxInput) {
  const min = parseStatInput(minInput)
  const max = parseStatInput(maxInput)
  if (min == null && max == null) return true
  if (total == null) return false
  if (min != null && total < min) return false
  if (max != null && total > max) return false
  return true
}
