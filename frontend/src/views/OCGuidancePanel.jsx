/**
 * The published CPR guidance for one crime (#707, wiring #688).
 *
 * ⚠️ **Its own file, deliberately.** The OC Simulator view is where v3.97.0
 * shipped a temporal-dead-zone crash that replaced the whole page with an error
 * boundary for every user. Adding another chain of hooks to it widens exactly
 * the blast radius that caused. This mounts independently and has its own render
 * test.
 *
 * ⚠️ **Presentation only.** Every number here comes from `publishGuidance`;
 * nothing is computed in the render. A figure that appears in this file and
 * nowhere upstream is a bug.
 */
import { useState } from 'react'

const fmtMoney = (v) =>
  v === null || v === undefined ? null : `$${Math.round(v).toLocaleString()}`

const fmtCpr = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1))

/** Why a crime has no table, in words a leader can act on. */
function NotPublishable({ reason, limitingRoles, chainsTo }) {
  // ⚠️ "Never observed" and "nobody clears the bar" are DIFFERENT facts (#351).
  // The first is a gap in our measurement — forge's current state on several
  // roles — and rendering it as "impossible" would be a verdict we have not
  // earned, and would stop anyone investigating.
  if (reason === 'no-readings') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No CPR guidance yet: we have <strong>never observed</strong> anyone in{' '}
        {(limitingRoles ?? []).join(', ') || 'one of these roles'}. That is a gap in what we
        have measured, not a verdict on the roster — run the crime once, or a CPR scan, and
        this fills in.
      </p>
    )
  }
  if (reason === 'not-crewable') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No CPR guidance: <strong>nobody clears</strong> the bar on at least one role, so this
        crime cannot be crewed at any threshold we could publish.
      </p>
    )
  }
  if (reason === 'chains') {
    // ⚠️ Not a pricing gap — a different KIND of reward. Stacking the Deck pays
    // nothing itself; every good ending spawns Ace in the Hole. Reporting that
    // as "unpriced" reads as a data problem and sends somebody hunting for a
    // number that does not exist.
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No CPR guidance: this crime pays no money or items — every successful ending
        spawns <strong>{chainsTo}</strong> instead. Its value is whatever{' '}
        {chainsTo} is worth, times the chance of getting there, so set thresholds
        on {chainsTo} and treat this as the way in.
      </p>
    )
  }
  if (reason === 'no-expected-value') {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        No CPR guidance: this crime&apos;s payouts are not fully priced, so any threshold
        would rest on an incomplete figure. Absent beats confidently wrong.
      </p>
    )
  }
  return (
    <p className="text-sm text-gray-500 dark:text-gray-400">
      No CPR guidance available for this crime.
    </p>
  )
}

export function GuidancePanel({ guidance, reason, limitingRoles, chainsTo, onCompute, computing }) {
  const [showWorking, setShowWorking] = useState(false)

  if (!guidance) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={onCompute}
          disabled={computing}
          aria-busy={computing || undefined}
          className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white disabled:opacity-60 inline-flex items-center gap-2"
        >
          {computing && (
            <span
              aria-hidden="true"
              className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin"
            />
          )}
          {computing ? 'Working…' : 'Suggest minimum CPRs'}
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {/* ⚠️ Says the cost out loud. Every candidate is a request to a small
              third-party service, which is why this is a button and not a
              recalculation on every slider drag. */}
          Runs the crew-fit and payout model against the current roster. A few
          calls to the probability service, so it is on demand.
        </p>
      </div>
    )
  }

  if (!guidance.publishable) {
    return <div className="mt-4"><NotPublishable reason={reason} limitingRoles={limitingRoles} chainsTo={chainsTo} /></div>
  }

  const { value } = guidance

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">Suggested minimum CPRs</h3>
        {onCompute && (
          <button type="button" onClick={onCompute} disabled={computing}
            aria-busy={computing || undefined}
            className="text-xs text-indigo-600 dark:text-indigo-400 disabled:opacity-60 inline-flex items-center gap-1.5">
            {computing && (
              <span aria-hidden="true"
                className="w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
            )}
            {computing ? 'Working…' : 'Recalculate'}
          </button>
        )}
      </div>

      <div className={`overflow-x-auto mt-2 transition-opacity ${computing ? 'opacity-40' : ''}`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-gray-500 dark:text-gray-400">
              <th className="py-1 pr-3">Role</th>
              <th className="py-1 pr-3">Impact</th>
              <th className="py-1 pr-3">Publish</th>
              <th className="py-1 pr-3">Model used</th>
              <th className="py-1 pr-3">Expected crew</th>
              <th className="py-1 pr-3">Can fill</th>
            </tr>
          </thead>
          <tbody>
            {guidance.roles.map((r) => (
              <tr key={r.positionId} className="border-t border-gray-200 dark:border-gray-700 align-top">
                <td className="py-1.5 pr-3">
                  <div className="font-medium">{r.roleName}</div>
                  {r.isCarry && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      carry — no training needed
                    </div>
                  )}
                  {r.nearMisses.length > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {r.nearMisses.length} within {r.nearMisses[0].pointsNeeded === 1 ? 'a point' : `${Math.max(...r.nearMisses.map((m) => m.pointsNeeded))} points`}
                    </div>
                  )}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-gray-500 dark:text-gray-400">
                  {r.weight === null ? '—' : `${r.weight.toFixed(1)}%`}
                </td>
                <td className="py-1.5 pr-3 tabular-nums font-semibold">{r.published}</td>
                {/* ⚠️ The bar the model actually scored at stays visible even
                    when we publish 0, or the table cannot be audited. */}
                <td className="py-1.5 pr-3 tabular-nums text-gray-500 dark:text-gray-400">
                  {fmtCpr(r.floor)}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-gray-500 dark:text-gray-400">
                  {fmtCpr(r.expected)}
                </td>
                <td className="py-1.5 pr-3 text-xs text-gray-500 dark:text-gray-400">
                  <span className="tabular-nums">{r.eligible}</span> of {r.readings}
                  {/* A bar with seven clearing it and one clearing the next point
                      is a knife edge one departure invalidates. */}
                  {r.cliff > 0 && (
                    <span className={r.cliff >= r.eligible / 2 ? ' text-amber-600 dark:text-amber-400' : ''}>
                      {' '}· {r.eligible} → {r.eligibleOneHigher} at +1
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {value.floor !== null && (
        <p className="text-xs text-gray-600 dark:text-gray-300 mt-2">
          At the published floor this crime is worth <strong>{fmtMoney(value.floor)}</strong>
          {value.expected !== null && (
            <> · at the expected crew, <strong>{fmtMoney(value.expected)}</strong>
              {value.uplift !== null && ` (+${Math.round(value.uplift * 100)}%)`}</>
          )}
        </p>
      )}

      {/* ⚠️ Always visible, never behind a toggle. The point of stating these is
          that a table reading as permanent truth goes stale and nobody notices —
          an assumption somebody has to click to find is one nobody reads. */}
      {/* ⚠️ The single most important caveat on this table, and it has to sit
          ABOVE the numbers rather than in the footnotes. Every threshold here
          is computed as if this crime had the whole roster to itself. It does
          not — the same people are wanted by every other crime in flight, so
          these are a per-crime CEILING and will be too high to run side by
          side. The joint solve across crimes is #710. */}
      <p className="text-xs mt-2 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 px-2 py-1.5">
        <strong>One crime at a time.</strong> These assume this crime has first claim on the
        whole roster. Every other crime wants the same people, so treat them as a ceiling
        for this crime, not as a set to publish across all of them.
      </p>

      {guidance.assumptions.length > 0 && (
        <ul className="text-xs text-gray-500 dark:text-gray-400 mt-2 list-disc pl-4 space-y-0.5">
          {guidance.assumptions.map((a) => <li key={a}>{a}</li>)}
        </ul>
      )}
      {guidance.generatedAt && (
        <button type="button" onClick={() => setShowWorking((v) => !v)}
          className="text-xs text-gray-500 dark:text-gray-400 mt-1 underline">
          {showWorking ? 'Hide' : 'When was this computed?'}
        </button>
      )}
      {showWorking && guidance.generatedAt && (
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Computed {guidance.generatedAt} from the roster as it stood then. Recompute after
          anyone joins, leaves or trains.
        </p>
      )}
    </div>
  )
}
