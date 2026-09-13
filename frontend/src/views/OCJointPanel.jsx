/**
 * The joint CPR plan across the selected crimes (#714 wiring of #710).
 *
 * ⚠️ **This is the table to publish; the per-crime one is a ceiling.** Each
 * crime card computes its thresholds as if it had the whole roster to itself,
 * which is why those numbers came out higher than the faction actually uses.
 * Here the crimes compete for the same people, and what each one gave up is
 * shown beside what it kept — because a set of lower numbers with no reasoning
 * attached will not be trusted or followed.
 *
 * ⚠️ Its own file. The Simulator view has taken this page down once (v3.97.0).
 */
import { formatCurrency } from '../utils/payoutCalculations'

const REASONS = {
  'no-readings': 'never observed anyone in one of its roles — a gap in what we have measured, not a verdict',
  'not-crewable': 'nobody clears the bar on at least one role',
  'no-expected-value': 'payouts are not fully priced',
  'roster-unavailable': 'its roster data could not be loaded',
  'chain-child': 'only ever appears as a chain reward, so it is not a spawn decision — its parent accounts for it',
}

export function JointPanel({ plan, onSolve, solving, crimeCount }) {
  if (!plan) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold">Plan these {crimeCount} crimes together</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {/* ⚠️ Says the cost before it is paid. Each crime's candidates are a
              handful of requests to a small third-party probability service. */}
          Each crime card above solves as if it had the whole roster to itself, so those
          numbers are a ceiling. This works out what they can run <em>together</em>, and what
          each has to give up. A few seconds and a few dozen probability calls.
        </p>
        <button type="button" onClick={onSolve} disabled={solving || crimeCount === 0}
          aria-busy={solving || undefined}
          className="mt-2 px-3 py-1.5 text-sm rounded bg-indigo-600 text-white disabled:opacity-60 inline-flex items-center gap-2">
          {solving && (
            <span aria-hidden="true"
              className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
          )}
          {solving ? 'Solving…' : 'Solve together'}
        </button>
      </div>
    )
  }

  const names = Object.keys(plan.chosen).sort()
  const skipped = Object.entries(plan.skipped ?? {})

  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">Joint plan — {names.length} crimes</h3>
        <button type="button" onClick={onSolve} disabled={solving}
          className="text-xs text-indigo-600 dark:text-indigo-400 disabled:opacity-60">
          {solving ? 'Solving…' : 'Recalculate'}
        </button>
      </div>

      {names.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
          None of the selected crimes could be solved.
        </p>
      ) : (
        <div className={`overflow-x-auto mt-2 ${solving ? 'opacity-40' : ''}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
                <th className="py-1 pr-3">Crime</th>
                <th className="py-1 pr-3">Thresholds</th>
                <th className="py-1 pr-3">Crews</th>
                <th className="py-1 pr-3">Gave up</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const pick = plan.chosen[name]
                const gave = plan.concessions[name]
                return (
                  <tr key={name} className="border-t border-gray-200 dark:border-gray-700 align-top">
                    <td className="py-1.5 pr-3 font-medium">{name}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {Object.keys(pick.vector).sort().map((p) => pick.vector[p]).join(' / ')}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums">{pick.crews}</td>
                    <td className="py-1.5 pr-3 text-xs text-gray-500 dark:text-gray-400">
                      {/* ⚠️ The insight, not decoration: "gave up 39 points for 4
                          more crews" is what makes a lower number defensible. */}
                      {gave.pointsGivenUp === 0
                        ? <span className="text-gray-400">kept its ceiling</span>
                        : <>{gave.pointsGivenUp} pts{gave.crewsGained > 0 && ` → +${gave.crewsGained} crews`}</>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {plan.simulation && (
        <p className="text-xs text-gray-600 dark:text-gray-300 mt-2">
          Over {plan.simulation.days} simulated days this crews{' '}
          <strong>{plan.simulation.filled} of {plan.simulation.spawned}</strong> spawns
          {plan.score != null && <> · {formatCurrency(Math.round(plan.score))} per member per day</>}
          {plan.simulation.scope && !plan.simulation.scope.solvent && (
            <> · ⚠️ short {plan.simulation.scope.shortfallPerDay.toFixed(2)} scope a day —
              cover it with cheaper spawns</>
          )}
        </p>
      )}

      {skipped.length > 0 && (
        <ul className="text-xs text-gray-500 dark:text-gray-400 mt-2 list-disc pl-4 space-y-0.5">
          {skipped.map(([name, reason]) => (
            <li key={name}><strong>{name}</strong> skipped — {REASONS[reason] ?? reason}</li>
          ))}
        </ul>
      )}

      <ul className="text-xs text-gray-500 dark:text-gray-400 mt-2 list-disc pl-4 space-y-0.5">
        <li>
          Solved across the crimes selected above only — a crime not on screen is not
          competing for the roster here.
        </li>
        {/* ⚠️ Two known gaps, stated rather than buried. */}
        {/* ⚠️ Measured or assumed — say which. A plan built on a guess that
            reads like a measurement is the worse of the two. */}
        {plan.spawnMix?.measured ? (
          <li>
            Spawn mix from this faction&apos;s own last {plan.spawnMix.windowDays} days:{' '}
            {plan.spawnMix.spawnsPerDay.toFixed(1)} decisions a day across{' '}
            {Object.keys(plan.spawnMix.weightByName).length} crimes. Chain rewards are
            excluded — they are consequences, not choices.
          </li>
        ) : (
          <li>
            Not enough recent history to measure the spawn mix, so an even one is assumed.
            The real mix is rarely even.
          </li>
        )}
        <li>
          A committed member is held for the crime&apos;s whole duration, which overstates
          occupancy by about half and makes the roster look tighter than it is.
        </li>
      </ul>
    </div>
  )
}
