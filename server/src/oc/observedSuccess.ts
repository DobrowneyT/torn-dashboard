/**
 * The faction's own crime history as a check on tornprobability's model (#728).
 *
 * Every success figure the OC Simulator shows is the model's. Forge has 370
 * Advanced runs in 120 days where we know both the crew's CPR and the outcome —
 * ground truth the Simulator has never consulted. Where the two disagree, the
 * model is wrong FOR THIS FACTION, and the guidance built on it is wrong too.
 *
 * The disagreement that motivated this: Break the Bank is Forge's highest
 * earner at $9.79M per person-day and shows **no measurable gain** across the
 * CPR range Forge actually operates in (76.2% at 62-65, 73.8% at 65-70) — while
 * the published guidance pushes its bar toward 75, where the roster can field
 * **zero** crews.
 *
 * ⚠️ **The hazard here is restriction of range, and it is severe.** The
 * correlation between a role's CPR and success measures where the faction has
 * VARIED the crew, not which role matters. Forge holds Blast from the Past's
 * Muscle at ~77 in every run, so Muscle shows a -0.36 "effect" — not because it
 * is unimportant but because there is nothing to see. Reported as a number,
 * that ranks the crime's heaviest role as ignorable and would gut the crime.
 *
 * So a role whose CPR barely moves reports `informative: false` and `delta:
 * null`. **Withheld, not zero.** A 0.0 in that column reads as "measured, no
 * effect", which is the precise misreading this guards against — the same rule
 * as #441/#473/#351.
 */

/** One slot of one run. `cpr` may be absent — a slot we never read. */
export interface ObservedSlot {
  crimeId: string
  ok: boolean
  position: string
  cpr: number | null
}

export interface ObservedBucket {
  lo: number
  hi: number
  runs: number
  successes: number
  rate: number
  meanCpr: number
}

export interface ObservedRole {
  position: string
  runs: number
  spread: number
  cprWhenOk: number | null
  cprWhenFail: number | null
  delta: number | null
  informative: boolean
  reason: 'ok' | 'narrow-range' | 'too-few-runs' | 'one-outcome'
}

export interface ObservedSummary {
  runs: number
  successes: number
  rate: number | null
  enough: boolean
  buckets: ObservedBucket[]
  roles: ObservedRole[]
}

/**
 * ⚠️ **A stated tunable, not a discovered constant.** Below this p90-p10 spread
 * in a role's CPR, the history cannot separate that role's contribution from
 * noise. Five points is roughly where Forge's own roles divide: Blast from the
 * Past's Muscle spans ~3 and says nothing; its Picklock spans ~25 and does.
 */
export const MIN_INFORMATIVE_SPREAD = 5

/** Runs needed before any of this is worth showing at all. */
export const DEFAULT_MIN_RUNS = 15

/** Runs needed inside one bucket before its rate means anything. */
export const DEFAULT_MIN_BUCKET_RUNS = 8

/** Most buckets to cut the range into, before the minimum-size rule applies. */
export const DEFAULT_MAX_BUCKETS = 4

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export function summariseObserved(
  slots: ObservedSlot[],
  {
    minRuns = DEFAULT_MIN_RUNS,
    minBucketRuns = DEFAULT_MIN_BUCKET_RUNS,
    maxBuckets = DEFAULT_MAX_BUCKETS,
    minInformativeSpread = MIN_INFORMATIVE_SPREAD,
  } = {}
): ObservedSummary {
  // ⚠️ Grouped by RUN, not by slot. A six-role crime contributes one
  // observation, not six — counting slots would inflate every sample size
  // sixfold and make noise look like evidence.
  const byRun = new Map<string, { ok: boolean; cprs: number[] }>()
  const byRole = new Map<string, { ok: number[]; fail: number[] }>()

  for (const s of slots ?? []) {
    const cpr = num(s?.cpr)
    // ⚠️ A slot with no reading is skipped, never scored as 0. Treating it as
    // zero would drag the crew mean down and manufacture a correlation.
    if (cpr === null) continue
    const id = String(s.crimeId)
    if (!byRun.has(id)) byRun.set(id, { ok: Boolean(s.ok), cprs: [] })
    byRun.get(id)!.cprs.push(cpr)

    if (!byRole.has(s.position)) byRole.set(s.position, { ok: [], fail: [] })
    byRole.get(s.position)![s.ok ? 'ok' : 'fail'].push(cpr)
  }

  const runs = [...byRun.values()]
    .map((r) => ({ ok: r.ok, meanCpr: mean(r.cprs)! }))
    .filter((r) => Number.isFinite(r.meanCpr))
    .sort((a, b) => a.meanCpr - b.meanCpr)

  const successes = runs.filter((r) => r.ok).length
  const base: ObservedSummary = {
    runs: runs.length,
    successes,
    rate: runs.length > 0 ? successes / runs.length : null,
    enough: runs.length >= minRuns,
    buckets: [],
    roles: [],
  }
  if (!base.enough) return base

  // ⚠️ Bucket edges come from the OBSERVED range, never from a fixed CPR grid.
  // A faction operating at 40-50 must get 40-50 buckets, not five empty ones
  // spanning 55-80 — and tomorrow's roster is not today's.
  const wanted = Math.max(1, Math.min(maxBuckets, Math.floor(runs.length / minBucketRuns)))
  const per = Math.ceil(runs.length / wanted)
  const buckets: ObservedBucket[] = []
  for (let i = 0; i < runs.length; i += per) {
    const slice = runs.slice(i, i + per)
    if (slice.length === 0) continue
    // Fold a short tail into the previous bucket rather than publishing it.
    if (slice.length < minBucketRuns && buckets.length > 0) {
      const prev = buckets[buckets.length - 1]
      const merged = runs.slice(Math.max(0, i - per), i + per)
      prev.hi = merged[merged.length - 1].meanCpr
      prev.runs = merged.length
      prev.successes = merged.filter((r) => r.ok).length
      prev.rate = prev.successes / prev.runs
      prev.meanCpr = mean(merged.map((r) => r.meanCpr))!
      continue
    }
    const ok = slice.filter((r) => r.ok).length
    buckets.push({
      lo: slice[0].meanCpr,
      hi: slice[slice.length - 1].meanCpr,
      runs: slice.length,
      successes: ok,
      rate: ok / slice.length,
      meanCpr: mean(slice.map((r) => r.meanCpr))!,
    })
  }

  const roles: ObservedRole[] = [...byRole.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([position, r]) => {
      const all = [...r.ok, ...r.fail].sort((a, b) => a - b)
      const spread = quantile(all, 0.9) - quantile(all, 0.1)
      const cprWhenOk = mean(r.ok)
      const cprWhenFail = mean(r.fail)

      // Three separate ways to have nothing to say, kept separate because they
      // call for different responses: run more crimes, vary the crew, or wait.
      const reason: ObservedRole['reason'] =
        all.length < minRuns ? 'too-few-runs'
          : cprWhenOk === null || cprWhenFail === null ? 'one-outcome'
            : spread < minInformativeSpread ? 'narrow-range'
              : 'ok'
      const informative = reason === 'ok'

      return {
        position,
        runs: all.length,
        spread,
        cprWhenOk,
        cprWhenFail,
        // ⚠️ Withheld rather than zeroed. See the module note.
        delta: informative ? cprWhenOk! - cprWhenFail! : null,
        informative,
        reason,
      }
    })

  return { ...base, buckets, roles }
}
