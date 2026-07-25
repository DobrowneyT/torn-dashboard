// Helpers for the dashboard pinned-competition cards (#242): decide how to show
// the viewing member's own position, and format the lottery "you" line.

// How to render the caller's own row on a leaderboard card, given the shown
// `top` rows (already capped) and the caller's `me` standing:
//   'none'      — the caller has no standing in the window.
//   'highlight' — the caller is within the shown rows; emphasise that row.
//   'append'    — the caller is outside the shown rows; add a separate you-row.
export function ownRowMode(top, me, limit = 5) {
  if (!me) return 'none'
  const shown = Math.min(top?.length ?? 0, limit)
  return me.rank <= shown ? 'highlight' : 'append'
}

// The lottery card's "you" line: the caller's own score plus a qualified /
// not-yet indicator against the threshold. Returns { text, qualified } where
// qualified is null when the caller has no standing yet.
export function lotteryOwnStatus(me, competition) {
  if (!me) return { text: 'no data yet', qualified: null }
  const cmp = competition?.threshold_comparator === 'lte' ? '≤' : '≥'
  const threshold = Number(competition?.threshold_value ?? 0).toLocaleString()
  const status = me.qualified ? 'qualified' : 'not yet'
  return {
    text: `${Number(me.value).toLocaleString()} · ${status} (${cmp} ${threshold})`,
    qualified: me.qualified,
  }
}
