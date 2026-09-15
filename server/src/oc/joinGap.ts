/**
 * Measuring the join gap `g` instead of assuming 12 hours (#687).
 *
 * `personDays(n, g) = n(n+1)/2 + (n-1)·g` is the denominator of every
 * per-person-per-day figure the OC model produces, and `g` is its only free
 * parameter. Every published minimum-CPR threshold inherits it.
 *
 * ⚠️ **The assumption was wrong, and wrong differently per faction.** Measured
 * across 180 days on 2026-09-14:
 *
 * ```
 *            n=4              n=5              n=6          implied g
 *   tnl     11.67 / 11.50    17.38 / 17.00    24.22 / 23.50   13-16h
 *   forge   13.16 / 11.50    19.59 / 17.00    26.89 / 23.50   25-28h
 *                (measured / formula at g=12h)
 * ```
 *
 * tnl is close to the assumption; **forge is more than double it**, so forge's
 * $/person-day was running ~14% optimistic. This is faction behaviour, exactly
 * as the issue predicted — capacityx and forge must not share a number.
 *
 * ⚠️ **`g` is FITTED, not observed directly.** Rather than measuring intervals
 * between joins, we solve for the `g` that reconciles the formula with the
 * person-days actually consumed:
 *
 *     g = (measuredPersonDays − n(n+1)/2) / (n − 1)
 *
 * That is deliberate. The formula is what consumes `g`, so the useful value is
 * whichever one makes it match reality — it absorbs late joins, re-fills, and
 * whatever else Torn does that we have not modelled. A directly-measured join
 * interval would be a different number that the formula does not want.
 */

/** One crime: how many roles it has, and the person-days its members were held. */
export interface CrimeHold {
  crimeId: string
  roles: number
  personDays: number
}

export interface GapBucket {
  roles: number
  crimes: number
  medianGapHours: number
  p10GapHours: number
  p90GapHours: number
  spreadHours: number
  capped: number
}

export interface JoinGapSummary {
  measured: boolean
  gapHours: number
  crimes: number
  byRoleCount: Record<number, GapBucket>
  reason: 'ok' | 'too-few-crimes'
}

/**
 * ⚠️ The documented fallback, kept so a tenant with no history still gets a
 * number — and so "we measured 12h" and "we assumed 12h" stay distinguishable.
 */
export const ASSUMED_GAP_HOURS = 12

/** Crimes needed before a measured gap replaces the assumption. */
export const MIN_CRIMES_FOR_GAP = 20

/**
 * ⚠️ A crime held far longer than a full extra day per join is not slow
 * filling, it is a stall, a clock problem, or a crime nobody finished. Counted
 * and excluded rather than dragging the median.
 */
export const MAX_PLAUSIBLE_GAP_HOURS = 72

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export function summariseJoinGap(
  crimes: CrimeHold[],
  { minCrimes = MIN_CRIMES_FOR_GAP, maxGapHours = MAX_PLAUSIBLE_GAP_HOURS } = {}
): JoinGapSummary {
  const byRoles = new Map<number, { gaps: number[]; capped: number }>()

  for (const c of crimes ?? []) {
    const n = Number(c?.roles)
    const pd = Number(c?.personDays)
    // ⚠️ `g` is slack per JOIN, so a one-role crime has no second joiner and
    // would divide by zero.
    if (!Number.isFinite(n) || n < 2 || !Number.isFinite(pd)) continue

    const lockIn = (n * (n + 1)) / 2
    // ⚠️ Clamped at zero. Person-days below the perfect-fill lock-in means a
    // clock or a missing slot is wrong, not that members joined before the
    // crime existed.
    const hours = Math.max(0, ((pd - lockIn) / (n - 1)) * 24)

    if (!byRoles.has(n)) byRoles.set(n, { gaps: [], capped: 0 })
    const b = byRoles.get(n)!
    if (hours > maxGapHours) { b.capped += 1; continue }
    b.gaps.push(hours)
  }

  const byRoleCount: Record<number, GapBucket> = {}
  let total = 0
  let weighted = 0

  for (const [roles, b] of [...byRoles.entries()].sort((a, z) => a[0] - z[0])) {
    if (b.gaps.length === 0) continue
    const s = [...b.gaps].sort((a, z) => a - z)
    const med = quantile(s, 0.5)
    const p10 = quantile(s, 0.1)
    const p90 = quantile(s, 0.9)
    byRoleCount[roles] = {
      roles,
      crimes: s.length + b.capped,
      medianGapHours: Math.round(med * 10) / 10,
      p10GapHours: Math.round(p10 * 10) / 10,
      p90GapHours: Math.round(p90 * 10) / 10,
      spreadHours: Math.round((p90 - p10) * 10) / 10,
      capped: b.capped,
    }
    // ⚠️ Weighted by how much each role count is actually RUN. A faction that
    // runs one 3-role crime a month and forty 6-role ones has the 6-role
    // behaviour, and an unweighted mean would say otherwise.
    total += s.length
    weighted += med * s.length
  }

  const counted = Object.values(byRoleCount).reduce((a, b) => a + b.crimes, 0)
  if (counted < minCrimes || total === 0) {
    return {
      measured: false,
      gapHours: ASSUMED_GAP_HOURS,
      crimes: counted,
      byRoleCount,
      reason: 'too-few-crimes',
    }
  }

  return {
    measured: true,
    gapHours: Math.round((weighted / total) * 10) / 10,
    crimes: counted,
    byRoleCount,
    reason: 'ok',
  }
}
