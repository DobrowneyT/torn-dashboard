// Latency-sample aggregation for the stress harness (#116). Pure functions —
// unit-tested from server/test/stress-harness.test.ts.

/** Nearest-rank percentile on a pre-sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** Summarize raw millisecond samples into the numbers the report prints. */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const count = sorted.length
  return {
    count,
    min: count ? sorted[0] : null,
    max: count ? sorted[count - 1] : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: count ? sorted.reduce((a, b) => a + b, 0) / count : null,
  }
}
