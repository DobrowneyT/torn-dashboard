// Interval union (#262), extracted so it can be shared without a cycle.
//
// It lived in payoutCalculations.js, which occupancyTime.js needs — and
// payoutCalculations then needed occupancyTime for the #389 diagnostics.
// Circular ESM imports resolve here by hoisting, but only by luck: one of the
// two would be reading a not-yet-initialised binding under a different bundler
// order. The shared primitive belongs in its own file.

// #262: total covered seconds across a member's time intervals, merging any
// that overlap or touch. Each interval is [start, end] in unix seconds, already
// clipped to the payout window. Because a member can only be in one OC at a
// time, their real elapsed time is the UNION of their crime/stint intervals —
// summing them independently double-counts overlaps (and could exceed the
// window). The union is bounded by the window, so the total never can.
export function mergeIntervalSeconds(intervals) {
  const valid = (intervals || [])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let curStart = null
  let curEnd = null
  for (const [s, e] of valid) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) total += curEnd - curStart
      curStart = s
      curEnd = e
    } else if (e > curEnd) {
      curEnd = e
    }
  }
  if (curEnd !== null) total += curEnd - curStart
  return total
}
