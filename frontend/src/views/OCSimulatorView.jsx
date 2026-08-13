/**
 * OC Simulator (#390) — success chance, per-ending probabilities and E(x) for a
 * proposed crew, before the crime is spawned.
 *
 * Gated to OC managers, leadership and admin (MonChoon), matching the Planner.
 *
 * Two things this page is careful about, both of which come down to the same
 * thing — an OC manager schedules real crimes off these numbers:
 *
 *   1. E(x) is a LOWER BOUND until every good ending is priced. The payout
 *      table is hand-entered as endings are observed, and is currently mostly
 *      empty. A partial sum shown as "the" expected value understates exactly
 *      the crimes whose best ending happens to be unpriced.
 *
 *   2. Four of the 31 upstream models are still in progress, and they answer
 *      with numbers that look exactly as authoritative as the finished ones.
 *      That status is stated on the page, not buried.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FlaskConical, Info, LoaderCircle } from 'lucide-react'
import { apiGet, apiPost } from '../utils/apiClient'
import { expectedValue, payoutsFor } from '../utils/ocExpectedValue'
import { formatCurrency } from '../utils/payoutCalculations'

/** Where a fresh crew starts. Mid-range, so moving a slider shows movement. */
const DEFAULT_CPR = 50

/** Debounce on the probability call — it is a request per keystroke otherwise. */
const CALC_DEBOUNCE_MS = 250

export default function OCSimulatorView() {
  const [scenarios, setScenarios] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [cprs, setCprs] = useState([])
  const [result, setResult] = useState(null)
  const [calcError, setCalcError] = useState(null)
  const [calculating, setCalculating] = useState(false)

  useEffect(() => {
    apiGet('/api/oc-simulator/scenarios')
      .then((res) => {
        setScenarios(res.scenarios ?? [])
        if ((res.scenarios ?? []).length > 0) setSelected(res.scenarios[0].name)
      })
      .catch((e) => setLoadError(e?.message || 'Could not load scenarios'))
  }, [])

  const scenario = useMemo(
    () => (scenarios ?? []).find((s) => s.name === selected) ?? null,
    [scenarios, selected]
  )

  // Reset the crew whenever the crime changes — a six-role vector left over
  // from the last crime would be rejected by the server, and silently reusing
  // the first N values would model a crew nobody picked.
  useEffect(() => {
    if (!scenario) return
    setCprs(Array.from({ length: scenario.parameter_count }, () => DEFAULT_CPR))
    setResult(null)
    setCalcError(null)
  }, [scenario?.name, scenario?.parameter_count])

  const timerRef = useRef(null)
  const seqRef = useRef(0)

  const calculate = useCallback((name, parameters) => {
    const seq = ++seqRef.current
    setCalculating(true)
    apiPost('/api/oc-simulator/calculate', { scenario: name, parameters })
      .then((res) => {
        // Ignore a response that has been overtaken — sliders fire fast, and
        // out-of-order replies would show numbers for a crew no longer on screen.
        if (seq !== seqRef.current) return
        setResult(res.result)
        setCalcError(null)
      })
      .catch((e) => {
        if (seq !== seqRef.current) return
        // No stale result left on screen next to a fresh crew: a success chance
        // is a number someone acts on.
        setResult(null)
        setCalcError(e?.message || 'The probability service could not be reached')
      })
      .finally(() => { if (seq === seqRef.current) setCalculating(false) })
  }, [])

  useEffect(() => {
    if (!scenario || cprs.length !== scenario.parameter_count) return
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => calculate(scenario.name, cprs), CALC_DEBOUNCE_MS)
    return () => clearTimeout(timerRef.current)
  }, [scenario, cprs, calculate])

  if (loadError) {
    return <div className="card text-sm text-red-600 dark:text-red-400">{loadError}</div>
  }
  if (!scenarios) {
    return (
      <div className="card flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <LoaderCircle className="w-4 h-4 animate-spin" /> Loading scenarios…
      </div>
    )
  }
  if (scenarios.length === 0) {
    return (
      <div className="card text-sm text-gray-600 dark:text-gray-400">
        <p className="font-medium mb-1">No scenarios mirrored yet.</p>
        <p>
          The nightly <code>oc-scenarios-mirror</code> job populates these from the probability
          model. Until it has run once, there is nothing to simulate.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold">OC Simulator</h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Set each role&apos;s CPR to model a crew before spawning the crime. Numbers come from our
          nightly mirror of the community probability model, not from Torn.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="input max-w-xs"
          >
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>{s.name}</option>
            ))}
          </select>
          {scenario && <ModelQuality scenario={scenario} />}
        </div>
      </div>

      {scenario && (
        <div className="grid gap-6 lg:grid-cols-2">
          <CrewPanel scenario={scenario} cprs={cprs} onChange={setCprs} />
          <ResultPanel
            scenario={scenario}
            result={result}
            calculating={calculating}
            error={calcError}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Whether the upstream model for this crime is finished, and how good the
 * diagram is.
 *
 * ⚠️ This is the #376 lesson made visible. Lock Stock's endings sum to exactly
 * 1.00000 from a third of Break the Bank's observed paths, and nothing in the
 * numbers says so.
 */
function ModelQuality({ scenario }) {
  const problems = scenario.diagram_problems ?? []
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {scenario.is_complete === null && (
        <span className="px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300">
          Model status unknown
        </span>
      )}
      {scenario.is_complete === false && (
        <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          Model still in progress
        </span>
      )}
      {scenario.is_complete === true && (
        <span className="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300">
          Model complete
        </span>
      )}
      {scenario.observed_paths != null && (
        <span className="text-gray-500 dark:text-gray-400 tabular-nums">
          {scenario.observed_paths.toLocaleString()} observed paths
        </span>
      )}
      {problems.length > 0 && (
        <span
          className="text-gray-500 dark:text-gray-400 cursor-help border-b border-dashed border-gray-400"
          title={problems.join('\n')}
        >
          {problems.length} diagram note{problems.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  )
}

function CrewPanel({ scenario, cprs, onChange }) {
  const setAt = (i, value) => {
    const next = [...cprs]
    next[i] = value
    onChange(next)
  }
  const setAll = (value) => onChange(cprs.map(() => value))

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Crew</h3>
        <div className="flex gap-1">
          {[25, 50, 75, 95].map((v) => (
            <button
              key={v}
              onClick={() => setAll(v)}
              className="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600"
            >
              All {v}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {scenario.roles.map((role, i) => (
          <div key={role.position_id}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {role.role_name}
                {/* Weight is the model's own statement of how much this role
                    matters — worth showing, because the highest-weight role is
                    where a CPR point buys the most. */}
                {role.weight != null && (
                  <span className="ml-2 text-xs text-gray-400">
                    {Number(role.weight).toFixed(1)}% impact
                  </span>
                )}
              </span>
              <span className="tabular-nums text-sm font-semibold">{cprs[i] ?? 0}</span>
            </div>
            <input
              type="range"
              min="0"
              max="100"
              value={cprs[i] ?? 0}
              onChange={(e) => setAt(i, Number(e.target.value))}
              className="w-full accent-blue-600"
              aria-label={`${role.role_name} CPR`}
            />
          </div>
        ))}
      </div>

      {scenario.roles.length !== scenario.parameter_count && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          This crime takes {scenario.parameter_count} roles but only {scenario.roles.length} are
          mirrored, so it cannot be simulated until the next mirror run.
        </p>
      )}
    </div>
  )
}

function ResultPanel({ scenario, result, calculating, error }) {
  const endings = useMemo(() => {
    if (!result) return []
    return Object.entries(result)
      .filter(([k]) => k.startsWith('goodEnding') || k.startsWith('badEnding'))
      .sort((a, b) => b[1] - a[1])
  }, [result])

  // Only good endings carry money, and only some of them are priced.
  const goodProbabilities = useMemo(() => {
    if (!result) return {}
    return Object.fromEntries(Object.entries(result).filter(([k]) => k.startsWith('goodEnding')))
  }, [result])

  const ev = useMemo(
    () => (result ? expectedValue(scenario.name, goodProbabilities) : null),
    [scenario.name, goodProbabilities, result]
  )
  const priced = payoutsFor(scenario.name)

  // Which diagram node each ending maps to, so an unresolved one can say so.
  const endingMeta = useMemo(() => {
    const map = new Map()
    for (const e of scenario.endings ?? []) map.set(e.ending_key, e)
    return map
  }, [scenario.endings])

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Outcome</h3>
        {calculating && <LoaderCircle className="w-4 h-4 animate-spin text-gray-400" />}
      </div>

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {error}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            No figures are shown rather than stale ones — a success chance is a number people act on.
          </p>
        </div>
      )}

      {!error && !result && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Adjust a slider to calculate.</p>
      )}

      {!error && result && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Figure
              label="Success"
              value={`${(result.successChance * 100).toFixed(2)}%`}
              tone="text-green-600 dark:text-green-400"
            />
            <Figure
              label="Failure"
              value={`${(result.failureChance * 100).toFixed(2)}%`}
              tone="text-red-600 dark:text-red-400"
            />
          </div>

          <ExpectedValue ev={ev} priced={priced} />

          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
              Endings by likelihood
            </div>
            <div className="space-y-1">
              {endings.map(([key, p]) => {
                const meta = endingMeta.get(key)
                const isGood = key.startsWith('goodEnding')
                const payout = isGood ? priced?.[key] : 0
                return (
                  <div key={key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isGood ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="truncate">{key}</span>
                      {meta && !meta.resolved && (
                        <span
                          className="text-amber-600 dark:text-amber-400 cursor-help shrink-0"
                          title={meta.problem || 'This ending could not be matched to the diagram'}
                        >
                          unmapped
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-3 whitespace-nowrap tabular-nums">
                      <span className="text-gray-500 dark:text-gray-400">
                        {isGood && payout == null
                          ? 'unpriced'
                          : formatCurrency(payout ?? 0)}
                      </span>
                      <span className="w-16 text-right">{(p * 100).toFixed(3)}%</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * E(x), presented as what it actually is.
 *
 * ⚠️ With no payouts entered, the honest answer is not "£0" — it is "we cannot
 * say yet". Rendering a partial sum as the expected value is the failure this
 * whole module was written to avoid.
 */
function ExpectedValue({ ev, priced }) {
  if (!ev) return null
  const anyPriced = priced && Object.values(priced).some((v) => v != null)

  if (!anyPriced) {
    return (
      <div className="rounded border border-gray-200 dark:border-slate-700 p-3">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Expected value
        </div>
        <div className="mt-1 flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            No payouts recorded for this crime yet, so E(x) cannot be calculated. It is left blank
            rather than shown as zero — a zero would read as &ldquo;this crime pays nothing&rdquo;.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-gray-200 dark:border-slate-700 p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Expected value {ev.complete ? '' : '(lower bound)'}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">
        {ev.complete ? '' : 'at least '}{formatCurrency(Math.round(ev.expected))}
      </div>
      {!ev.complete && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {ev.missing.length} ending{ev.missing.length === 1 ? '' : 's'} unpriced, covering{' '}
          {((1 - ev.pricedProbability) * 100).toFixed(2)}% of the probability. The real value is
          higher by an unknown amount — never lower.
        </p>
      )}
    </div>
  )
}

function Figure({ label, value, tone }) {
  return (
    <div className="rounded bg-gray-50 dark:bg-slate-700/40 py-2 text-center">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone || ''}`}>{value}</div>
    </div>
  )
}
