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

/** Battle stats descending; un-spied (null) targets sink to the bottom. */
function bspDescNullsLast(a, b) {
  const an = a.bsp == null
  const bn = b.bsp == null
  if (an !== bn) return an ? 1 : -1
  if (an && bn) return 0
  return b.bsp - a.bsp
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
