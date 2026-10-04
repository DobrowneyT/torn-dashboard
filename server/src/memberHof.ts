/**
 * Hall of Fame standings per member (#872).
 *
 * Requested by Singularity [2573844] (forge), 2026-10-03, and the use case
 * settles the design: *"no it was more so to promote competition within the
 * faction, bit of bragging rights"*.
 *
 * ⚠️ **Bragging rights, not analytics.** Screening applicants and spotting
 * members whose numbers look off were both offered and both declined. So
 * nothing here produces a judgement: no thresholds, no compliance states, no
 * amber "inconclusive". The Member Overview already does assessment, and a
 * leaderboard that implies it stops being fun and starts being a performance
 * review.
 *
 * Shapes verified against the live v2 spec (`/swagger/openapi.json`, 234
 * paths, fetched 2026-10-03). `GET /user/{id}/hof` returns, per category,
 * `{ value, rank }` — `rank` being the GLOBAL Torn position.
 */

/** A member's standing in one category. */
export interface HofEntry {
  /** The raw figure. Drives the faction-internal ordering. */
  value: number
  /** Global Torn position, or null when Torn did not give one. */
  rank: number | null
}

/**
 * The categories we surface, in the order the picker offers them.
 *
 * ⚠️ `battle_stats` is deliberately ABSENT and must stay absent. From the
 * schema:
 *
 *   "battle_stats": { "oneOf": [
 *      { "$ref": "HofValue", "description": "This field is null when
 *        requesting data for other players." },
 *      { "type": "null" } ] }
 *
 * A roster-wide battle-stats board cannot be built — not by us, not by anyone.
 * Excluding the category is the honest outcome; rendering it as an empty
 * column would read as a scrape failure and be reported as a bug.
 *
 * ⚠️ `working_stats` leads. Singularity maintains a workstat-finder script, so
 * it is the likeliest target of the request, and unlike battle stats it IS
 * available for other players.
 */
export const HOF_CATEGORIES = [
  'working_stats',
  'networth',
  'attacks',
  'defends',
  'busts',
  'revives',
  'offences',
  'level',
  'rank',
  'awards',
  'racing_skill',
  'racing_points',
  'racing_wins',
  'travel_time',
] as const

export type HofCategory = (typeof HOF_CATEGORIES)[number]

/** Never surfaced, whatever Torn sends. See the note on HOF_CATEGORIES. */
export const SELF_ONLY_CATEGORIES = new Set(['battle_stats'])

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Read one `/user/{id}/hof` payload into `{ category: {value, rank} }`.
 *
 * ⚠️ A category with no usable `value` is OMITTED rather than stored as zero.
 * Zero is a real standing — somebody genuinely has no revives — and it is a
 * different fact from "Torn did not tell us", which is what a missing or
 * unparseable field means. Conflating them puts a member at the bottom of a
 * board they are simply absent from.
 */
export function readMemberHof(payload: any): Record<string, HofEntry> {
  const src = payload?.hof ?? payload ?? {}
  const out: Record<string, HofEntry> = {}
  for (const cat of HOF_CATEGORIES) {
    if (SELF_ONLY_CATEGORIES.has(cat)) continue
    const raw = src?.[cat]
    const value = num(raw?.value)
    if (value === null) continue
    out[cat] = { value, rank: num(raw?.rank) }
  }
  return out
}

export interface BoardRow {
  memberId: string
  memberName: string
  value: number
  /** Global Torn position. */
  globalRank: number | null
  /** Position inside this faction, 1-based. */
  factionRank: number
}

/**
 * Rank the faction for one category.
 *
 * ⚠️ Faction position is computed HERE, on read, and never stored: it depends
 * on everybody else's value, so a stored copy goes stale the moment a
 * different member trains.
 *
 * ⚠️ Members with no reading for the category are left OUT, not ranked last.
 * Absent is not "worst" — the same rule the roster sort follows for unspied
 * battle stats (#351).
 *
 * ⚠️ Ties share a position (1, 2, 2, 4) rather than being broken arbitrarily.
 * On a bragging-rights board, telling two people with identical numbers that
 * one of them is ahead is a lie the data does not support.
 */
export function buildBoard(
  rows: Array<{ member_id: string; member_name?: string | null; hof: Record<string, HofEntry> | null }>,
  category: string
): BoardRow[] {
  const present = (rows ?? [])
    .map((r) => ({ r, e: r?.hof?.[category] }))
    .filter((x): x is { r: (typeof rows)[number]; e: HofEntry } => x.e != null && Number.isFinite(x.e.value))

  present.sort((a, b) =>
    b.e.value - a.e.value ||
    String(a.r.member_name ?? a.r.member_id).localeCompare(String(b.r.member_name ?? b.r.member_id), undefined, { sensitivity: 'base' })
  )

  const out: BoardRow[] = []
  let lastValue: number | null = null
  let lastRank = 0
  present.forEach((x, i) => {
    const rank = lastValue !== null && x.e.value === lastValue ? lastRank : i + 1
    lastValue = x.e.value
    lastRank = rank
    out.push({
      memberId: String(x.r.member_id),
      memberName: x.r.member_name ?? String(x.r.member_id),
      value: x.e.value,
      globalRank: x.e.rank,
      factionRank: rank,
    })
  })
  return out
}
