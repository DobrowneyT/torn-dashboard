// Farm-mode two-tier target ordering (#108), shared by the desktop and mobile
// war rooms. Each view adapts its own row shape onto a normalized farm target
// before comparing:
//   { isGreen, okay, until, bsp, okayAt }
//     isGreen — mirrors the green attack button (target Online AND Okay)
//     okay    — out of hospital/jail (attackable)
//     until   — timer release, unix seconds (null when none)
//     bsp     — battle-stats total (null when un-spied)
//     okayAt  — ms-since-epoch first observed leaving hospital this session
//               (-1 if never), so fresh kills float up the red Okay sub-tier.
//
// Ordering:
//   Tier 0 — green (online+okay): always on top, by battle stats desc.
//   Tier 1 — everyone else (red button): today's ordering preserved —
//            freshly-released Okay first, then soonest-out timers, then rest.

/**
 * The green attack button: the target is online AND out of hospital/jail, so
 * they can be hit right now.
 *
 * Exported and shared (#366) because two places have to agree on it exactly.
 * The farm sort puts these on top; the stats filter must never remove them.
 * Two copies of this predicate would eventually disagree, and the failure mode
 * is a member who sorts into the top tier and is then filtered off the board.
 *
 * Reads both row shapes (#479): the desktop table holds flat DB rows
 * (`last_action_status`), the mobile overlay a camelCase projection of the same
 * data (`activity`). The number of surfaces that must not disagree is now
 * three, which is exactly why this lives in one place.
 */
export function isGreenTarget(member) {
  const activity = member?.last_action_status ?? member?.activity
  const state = member?.status_state ?? member?.state
  return activity === 'Online' && state === 'Okay'
}

/** Battle stats descending; un-spied (null) targets sink to the bottom. */
function bspDescNullsLast(a, b) {
  const an = a.bsp == null
  const bn = b.bsp == null
  if (an !== bn) return an ? 1 : -1
  if (an && bn) return 0
  return b.bsp - a.bsp
}

/**
 * Abroad predicate for the farm-mode Abroad section (#561): true for
 * travelling, abroad, and hospitalized-abroad targets. Deliberately the same
 * concept as `stateToFilterKey(...) === 'Flying'` (duplicated in both war
 * rooms for the Status filter chips and the ✈ row flag in warRoomFlags.js) —
 * centralized here, once, for the same reason `isGreenTarget` is: two
 * separately-maintained copies of "is this target abroad" would eventually
 * disagree, and the failure mode is a target sorted into the wrong section.
 *
 * Why this matters for farm mode specifically: a released hospital timer
 * means "no longer hospitalized", not "attackable soon" — an abroad target
 * still needs real travel time back to Torn. Interleaving them into the
 * timer-driven main ordering (by release time) reads as "back soon" when it
 * is not, so farm mode segregates them into their own trailing section
 * instead (`splitFarmAbroad` below).
 *
 * Reads both row shapes (#479): the desktop table's flat DB rows
 * (`status_state`/`status_description`) and the mobile overlay's camelCase
 * projection (`state`/`description`).
 */
export function isAbroadTarget(member) {
  const state = member?.status_state ?? member?.state
  const description = member?.status_description ?? member?.description
  if (state === 'Traveling' || state === 'Abroad') return true
  if (state === 'Hospital') {
    return /^(In (?:a|an) .*? hospital)\b/i.test(description ?? '')
  }
  return false
}

/**
 * Splits an already-filtered roster into farm mode's two sections (#561):
 * the main list (unchanged two-tier ordering, via `farmCompare`) and a
 * trailing Abroad section for anyone `isAbroadTarget` flags.
 *
 * The Abroad section sorts by battle stats descending, nulls last — the same
 * tone `farmCompare`'s own tiers already use — rather than by timer, because
 * an abroad target's timer does not mean "attackable soon" the way a
 * domestic hospital target's does (see `isAbroadTarget`). Absent a stronger
 * signal (e.g. modelled flight time home), stats-desc is the safe default:
 * it still surfaces the most dangerous abroad targets first.
 *
 * `toFarmTarget` is the caller's own `{ isGreen, okay, until, bsp, okayAt }`
 * projection (both war rooms already build one of these for `farmCompare`;
 * row shapes differ between the two, so the projection stays caller-owned).
 */
export function splitFarmAbroad(members, toFarmTarget) {
  const main = []
  const abroad = []
  for (const m of members) {
    (isAbroadTarget(m) ? abroad : main).push(m)
  }
  main.sort((a, b) => farmCompare(toFarmTarget(a), toFarmTarget(b)))
  abroad.sort((a, b) => bspDescNullsLast(toFarmTarget(a), toFarmTarget(b)))
  return { main, abroad }
}

export function farmCompare(a, b) {
  // Tier 0 vs 1: the green attack button always wins the top of the list.
  if (a.isGreen !== b.isGreen) return a.isGreen ? -1 : 1

  // Green tier: purely battle stats (nulls last) — grab the biggest first.
  if (a.isGreen) return bspDescNullsLast(a, b)

  // Red tier keeps the existing farm ordering:
  //   sub 0 — Okay (not online): freshly-released first, then battle stats
  //   sub 1 — has timer, not Okay: soonest out first
  //   sub 2 — everything else (flying/abroad/fallen): battle stats
  const sub = (m) => (m.okay ? 0 : m.until ? 1 : 2)
  const sa = sub(a)
  const sb = sub(b)
  if (sa !== sb) return sa - sb
  if (sa === 0) {
    if (a.okayAt !== b.okayAt) return b.okayAt - a.okayAt
    return (b.bsp ?? 0) - (a.bsp ?? 0)
  }
  if (sa === 1) return (a.until ?? Infinity) - (b.until ?? Infinity)
  return (b.bsp ?? 0) - (a.bsp ?? 0)
}
