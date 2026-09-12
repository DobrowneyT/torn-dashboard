/**
 * What a crime is worth per person per day (#690, part of #688).
 *
 * The metric the CPR algorithm optimises against, and the only honest way to
 * compare crimes with different role counts: a bigger crime ties up more people
 * for longer, so ranking on raw E(X) silently favours it.
 *
 * ## The mechanic
 *
 * A crime completes `24h × n` after the first member joins — each member adds
 * 24h in their role, and the roles run back to back. A member is held from the
 * moment they join until the crime resolves, so the person-days one crime
 * consumes are:
 *
 *     personDays(n, g) = n(n+1)/2  +  (n-1)·g
 *                        └ lock-in ┘   └ slack ┘
 *
 * `n(n+1)/2` is lock-in under a perfect fill: joins land exactly 24h apart, so
 * the locks are `n, n-1, … 1` days.
 *
 * ⚠️ **The slack term is `(n-1)·g` and is NOT cumulative.** This is the
 * counter-intuitive part and it was got wrong once in review. The gaps do not
 * delay the crime — it completes at `24h × n` whatever happens. Joiners arrive
 * *early* and idle, rather than the crime finishing *late*. So each non-first
 * joiner is locked exactly `g` longer than ideal, ONCE. Modelling the gaps as
 * pushing completion out gives `g·n(n-1)/2`, which over-charges a six-role
 * crime by 21% and biases the whole hierarchy toward larger crimes.
 *
 * ## The two figures, and why both
 *
 * `perParticipant` is what somebody IN the crew earns for their time.
 * `perFactionMember` spreads the same income across the whole roster, so a
 * member sitting idle counts as the cost they are.
 *
 * ⚠️ They coincide at full utilisation and diverge exactly when the CPR bar is
 * too high to crew a second crime — which is the entire tension the algorithm
 * exists to resolve. Optimising the first alone would set every bar to the
 * ceiling and leave most of the faction earning nothing.
 */

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/**
 * How long we assume it takes the next member to join, in days.
 *
 * ⚠️ This is FACTION BEHAVIOUR, not a game rule — the only free parameter in
 * the whole figure, and every threshold the algorithm produces inherits it.
 * #687 measures our real value from observed occupancy; until then this is an
 * assumption and the UI must say so.
 */
export const GAP_DEFAULT_DAYS = 0.5

/**
 * ⚠️ A gap above 24h would mean a joiner arriving before the previous one did,
 * which is not a slower fill — it is a different crime.
 */
export const GAP_MAX_DAYS = 1

const clampGap = (g) => {
  const v = num(g)
  if (v === null) return GAP_DEFAULT_DAYS
  return Math.min(GAP_MAX_DAYS, Math.max(0, v))
}

/**
 * Person-days one run of an `n`-role crime consumes.
 *
 * Null for a nonsense role count — absent, never zero. A zero here would divide
 * into an infinite return per person.
 */
export function personDays(roleCount, gap = GAP_DEFAULT_DAYS) {
  const n = num(roleCount)
  if (n === null || n < 1) return null
  return (n * (n + 1)) / 2 + (n - 1) * clampGap(gap)
}

/**
 * @param expectedValue E(X) for one run, at the crew being considered.
 * @param roleCount the crime's `n`.
 * @param rosterSize members the faction has, for the faction-wide figure.
 * @param crews how many run concurrently — from `maxDisjointCrews` (#689).
 *   ⚠️ Omitted means we do not know, and the result says `assumedCrews: true`
 *   rather than quietly presenting a guess as a measurement.
 * @param gap days between joins; defaults to the assumption above.
 */
export function perPersonPerDay({ expectedValue, roleCount, rosterSize, crews, gap } = {}) {
  const n = num(roleCount)
  const ex = num(expectedValue)
  const roster = num(rosterSize)
  const k = num(crews)
  const usedGap = clampGap(gap)
  const days = personDays(n, usedGap)

  const missing = []
  if (n === null || n < 1) missing.push('roleCount')
  if (ex === null) missing.push('expectedValue')
  if (roster === null || roster <= 0) missing.push('rosterSize')

  const perParticipant = days === null || ex === null ? null : ex / days

  // ⚠️ Throughput, not rate: `k` crews each yield E(X) once per crime, and a
  // crime takes `n` days. Dividing by the roster turns it into what the average
  // member earns — which is the point, because the members not in a crew are
  // still in that denominator.
  const usedCrews = k === null || k < 0 ? 1 : k
  const perFactionMember =
    days === null || ex === null || roster === null || roster <= 0
      ? null
      : (usedCrews * ex) / (n * roster)

  return {
    personDays: days,
    perParticipant,
    perFactionMember,
    /** Share of the roster actually committed. 1 means nobody is idle. */
    utilisation:
      days === null || roster === null || roster <= 0 ? null : (usedCrews * days) / (n * roster),
    crews: usedCrews,
    assumedCrews: k === null || k < 0,
    gap: usedGap,
    gapIsAssumed: num(gap) === null,
    missing,
  }
}
