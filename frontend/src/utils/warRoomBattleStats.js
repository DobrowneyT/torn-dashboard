/**
 * Our own members' battle stats in the War Room Stats column (#353).
 *
 * #348 collects these daily into `member_battle_stats` from three sources, best
 * first: the member's OWN key (exact), a TornStats faction spy, then a BSP
 * estimate. They arrive over the lead-gated REST endpoint rather than the war
 * room's delta channel — that protocol carries per-second state, and these
 * change once a day.
 *
 * The rows are PROJECTED onto the `bsp_*` field names the enemy side already
 * uses. BspCell, the Stats column sort, the farm sort and the min/max filter
 * all read those names off the member row, so projecting means none of them
 * needs a second code path for our own faction. The alternative — threading a
 * parallel source through five call sites — is the same feature with five more
 * places to get it wrong.
 */

/** Index the endpoint's rows by member id, as strings — roster ids are numbers. */
export function indexBattleStats(rows = []) {
  const byId = {}
  for (const row of rows ?? []) {
    if (row?.member_id == null) continue
    byId[String(row.member_id)] = row
  }
  return byId
}

/**
 * Which source a figure came from, as the short label the tooltip shows.
 *
 * The distinction matters: a member's own key returns their REAL stats, while
 * TornStats and BSP are estimates of varying age. Presenting an exact figure as
 * "BSP" understates it, and presenting a prediction as exact would have a lead
 * size up a target against a number that was never measured.
 *
 * "API" rather than "OWN" (MonChoon, 2026-09-19): three short tokens that read
 * alike is the whole explanation, and it stops the panel widening to carry a
 * sentence saying the same thing.
 *
 * Unknown sources fall back to the weakest claim rather than the strongest —
 * enemy rows carry no `source` at all, and under-claiming is the safe error.
 */
const SOURCE_LABEL = { torn: 'API', tornstats: 'TS', bsp: 'BSP' }

export function statsSourceLabel(source) {
  return SOURCE_LABEL[source] ?? 'BSP'
}

/** Is this an exact reading rather than an estimate? */
export function isExactStatsSource(source) {
  return source === 'torn'
}

/**
 * Merge battle stats into roster rows under the `bsp_*` names.
 *
 * Returns new objects — the input is the socket's own array, and writing
 * through it would leak our figures onto the enemy-side board on the way back.
 * Members with no stats row get an explicit null total, which renders as "???"
 * exactly like an un-spied enemy.
 */
export function withBattleStats(members = [], byId = {}) {
  const stats = byId ?? {}
  return (members ?? []).map((m) => {
    const s = stats[String(m?.member_id)]
    return {
      ...m,
      bsp_total: s?.total ?? null,
      bsp_str: s?.strength ?? null,
      bsp_def: s?.defense ?? null,
      bsp_spd: s?.speed ?? null,
      bsp_dex: s?.dexterity ?? null,
      spy_source: s?.source ?? null,
      // `spy_at` is when the spy was actually taken; `fetched_at` is when we
      // wrote the row. BspCell prefers the former for TornStats and falls back
      // to the latter, which is right for own-key and BSP readings.
      ts_spy_at: s?.spy_at ?? null,
      bsp_fetched_at: s?.fetched_at ?? null,
    }
  })
}

/**
 * Sort value for a battle-stats total: the number, or null when unread (#355).
 *
 * Null rather than 0, and the callers' comparators must sink nulls in BOTH
 * directions — the #351 rule. Sorting ascending asks "who is weakest"; a member
 * whose stats we have never read is not an answer to that, they are the absence
 * of one, and folding them in as zero buries the members the sort was meant to
 * surface. Sorting descending, the same members would pile up at the far end
 * and push the real answers off the first screen.
 */
export function battleStatsSortValue(row) {
  const total = row?.bsp_total
  return total == null ? null : Number(total)
}

/**
 * Does a member match a source filter? `'any'` passes everything.
 *
 * The useful query here is "show me everyone we only have a BSP guess for" —
 * that list is the set of members to chase for a key, which is the whole reason
 * the source is worth filtering on rather than merely displaying.
 */
export function matchesStatsSource(row, filter) {
  if (!filter || filter === 'any') return true
  if (filter === 'none') return row?.bsp_total == null
  // A member with no reading has no source, so they cannot match a real one.
  if (row?.bsp_total == null) return false
  return (row?.spy_source ?? 'bsp') === filter
}
