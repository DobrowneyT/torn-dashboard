/**
 * What this faction's own runs say about a crime (#728).
 *
 * ⚠️ Every success figure elsewhere on this page is tornprobability's model.
 * This is the only thing on the Simulator that came from the faction itself,
 * and on Forge's highest earner the two disagree: Break the Bank shows no
 * measurable gain across the CPR range Forge operates in, while the guidance
 * pushes its bar toward a threshold that fields zero crews.
 *
 * ⚠️ Its own file, like the guidance and chain panels — OCSimulatorView took
 * the page down once already (v3.97.0) and does not need more hooks.
 */
import { compareToObserved } from '../utils/ocObservedFit'

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)
const cpr = (v) => (v === null || v === undefined ? '—' : Math.round(v))

export function ObservedPanel({ observed, predicted, crewCpr }) {
  if (!observed) return null

  if (!observed.enough) {
    return (
      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        {/* ⚠️ "We have not run this enough" is not "this crime fails". The
            distinction is the whole #351 rule. */}
        {observed.runs > 0
          ? `Only ${observed.runs} run${observed.runs === 1 ? '' : 's'} of this crime in the last
             ${observed.window_days} days — too few to say anything about it yet.`
          : `This faction has not run this crime in the last ${observed.window_days} days.`}
      </p>
    )
  }

  const fit = compareToObserved({ observed, predicted, crewCpr })
  const informative = (observed.roles ?? []).filter((r) => r.informative)
  const uninformative = (observed.roles ?? []).filter((r) => !r.informative)

  return (
    <div className="mt-3 rounded border border-gray-300 dark:border-gray-700 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-600 dark:text-gray-400">
        Our own history — {observed.runs} runs, {observed.window_days} days
      </div>
      <div className="mt-0.5 text-sm">
        Succeeded <strong>{pct(observed.rate)}</strong> of the time.
      </div>

      {fit.status === 'disagrees' && (
        <p className="mt-1.5 text-xs rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 px-2 py-1.5">
          {/* ⚠️ The point of the whole feature. A model disagreeing with the
              faction's own runs is the model being wrong HERE, and the guidance
              is built on it. */}
          <strong>The model and our history disagree.</strong> The model predicts{' '}
          {pct(predicted)} for this crew; at a comparable crew we actually ran{' '}
          <strong>{pct(fit.observedRate)}</strong> over {fit.bucket.runs} runs — the model is{' '}
          {fit.direction === 'model-optimistic' ? 'optimistic' : 'pessimistic'} by{' '}
          {pct(Math.abs(fit.gap))}.
        </p>
      )}
      {fit.status === 'out-of-range' && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          We have never run this crime at a crew near {cpr(crewCpr)} — our runs span{' '}
          {cpr(fit.range[0])}–{cpr(fit.range[1])} CPR, so there is nothing here to check the
          model against.
        </p>
      )}
      {fit.status === 'agrees' && (
        <p className="mt-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          Consistent with the model, which predicts {pct(predicted)} for this crew.
        </p>
      )}

      <table className="mt-2 w-full text-xs">
        <thead className="text-gray-500 dark:text-gray-400">
          <tr className="text-left">
            <th className="font-medium py-0.5">CREW CPR</th>
            <th className="font-medium py-0.5">RUNS</th>
            <th className="font-medium py-0.5">SUCCEEDED</th>
          </tr>
        </thead>
        <tbody>
          {observed.buckets.map((b) => (
            <tr key={b.lo} className="border-t border-gray-200 dark:border-gray-800">
              <td className="py-0.5 tabular-nums">{cpr(b.lo)}–{cpr(b.hi)}</td>
              <td className="py-0.5 tabular-nums">{b.runs}</td>
              <td className="py-0.5 tabular-nums font-medium">{pct(b.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {informative.length > 0 && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
          Where the crew has varied, success tracked{' '}
          {informative
            .slice()
            .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
            .map((r) => `${r.position} (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)})`)
            .join(', ')}
          .
        </p>
      )}

      {/* ⚠️ THE correction this panel must not invite. A role held at the same
          CPR in every run has no signal — that is a gap in what we have TRIED,
          not evidence the role is unimportant. Forge's Blast from the Past runs
          Muscle at ~77 every time and it is the heaviest role in the crime. */}
      {uninformative.length > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          No read on{' '}
          {uninformative.map((r) => r.position).join(', ')} — we have run{' '}
          {uninformative.length === 1 ? 'it' : 'them'} at almost the same CPR every time.
          That says nothing about how much {uninformative.length === 1 ? 'it matters' : 'they matter'}.
        </p>
      )}
    </div>
  )
}
