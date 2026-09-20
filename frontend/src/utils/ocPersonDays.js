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
 *     personDays(n, s) = n(n+1)/2  +  (n-1)·s
 *                        └ lock-in ┘   └ slack ┘
 *
 * `n(n+1)/2` is lock-in under a perfect fill: joins land exactly 24h apart, so
 * the locks are `n, n-1, … 1` days.
 *
 * ⚠️ **The slack term is `(n-1)·s` and is NOT cumulative.** This is the
 * counter-intuitive part and it was got wrong once in review. Slack does not
 * delay the crime — it completes at `24h × n` whatever happens. Members sit
 * down *early* and idle, rather than the crime finishing *late*. So each
 * non-first seat is held exactly `s` longer than ideal, ONCE. Modelling it as
 * pushing completion out gives `s·n(n-1)/2`, which over-charges a six-role
 * crime by 21% and biases the whole hierarchy toward larger crimes.
 *
 * ⚠️ **It used to be called `g`, for "join gap", and that name was wrong**
 * (#744). It was described as "we cannot expect the next person to join the
 * instant the previous role's 24h expires" — a gap between joins, i.e. people
 * arriving LATE. Measured, the opposite happens: capacityx takes its sixth
 * seat at hour 65 for a slot not needed until 120. The name pointed at a fix
 * nobody could make ("fill faster") instead of the one they can ("stop sitting
 * down before you are needed").
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
 * How long each seat after the first is held beyond its schedule, in days.
 *
 * ⚠️ This is FACTION BEHAVIOUR, not a game rule — the only free parameter in
 * the whole figure, and every threshold the algorithm produces inherits it.
 * #687 measures our real value from observed occupancy; until then this is an
 * assumption and the UI must say so.
 */
export const SLACK_DEFAULT_DAYS = 0.5

/**
 * ⚠️ Slack above 24h would put a seat a full role-length out of position, which
 * is not a faction filling differently — it is a different crime.
 */
export const SLACK_MAX_DAYS = 1

const clampSlack = (s) => {
  const v = num(s)
  if (v === null) return SLACK_DEFAULT_DAYS
  return Math.min(SLACK_MAX_DAYS, Math.max(0, v))
}

/**
 * Person-days one run of an `n`-role crime consumes.
 *
 * Null for a nonsense role count — absent, never zero. A zero here would divide
 * into an infinite return per person.
 */
export function personDays(roleCount, slackPerSeat = SLACK_DEFAULT_DAYS) {
  const n = num(roleCount)
  if (n === null || n < 1) return null
  return (n * (n + 1)) / 2 + (n - 1) * clampSlack(slackPerSeat)
}

/**
 * @param expectedValue E(X) for one run, at the crew being considered.
 * @param roleCount the crime's `n`.
 * @param rosterSize members the faction has, for the faction-wide figure.
 * @param crews how many run concurrently — from `maxDisjointCrews` (#689).
 *   ⚠️ Omitted means we do not know, and the result says `assumedCrews: true`
 *   rather than quietly presenting a guess as a measurement.
 * @param slackPerSeat days each seat after the first is held beyond its
 *   schedule; defaults to the assumption above.
 */
export function perPersonPerDay({ expectedValue, roleCount, rosterSize, crews, slackPerSeat } = {}) {
  const n = num(roleCount)
  const ex = num(expectedValue)
  const roster = num(rosterSize)
  const k = num(crews)
  const usedSlack = clampSlack(slackPerSeat)
  const days = personDays(n, usedSlack)

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
    slackPerSeat: usedSlack,
    slackIsAssumed: num(slackPerSeat) === null,
    missing,
  }
}
