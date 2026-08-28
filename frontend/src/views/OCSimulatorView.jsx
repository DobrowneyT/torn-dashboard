/**
 * OC Simulator (#390, #445) — model a crew before spawning, several crimes at
 * a time.
 *
 * Gated to OC managers, leadership and admin (MonChoon), matching the Planner.
 *
 * Things this page is careful about, all of which come down to the same thing —
 * an OC manager schedules real crimes off these numbers:
 *
 *   1. E(x) is a LOWER BOUND until every good ending is priced. Payouts come
 *      from the mirrored feed (#440), joined to endings through the #390
 *      mapping, so a crime is under-priced when an ending could not be mapped
 *      or has no observations. A partial sum shown as "the" expected value
 *      understates exactly the crimes whose best ending is unpriced.
 *
 *   2. Four of the 31 upstream models are still in progress and answer with
 *      numbers that look exactly as authoritative as the finished ones.
 *
 *   3. Headcount is what CAN fill a role, not what is free to (#442).
 *
 * ⚠️ Each crime is an independent card owning its own CPR vector, result and
 * roster readings. That is not just tidiness: a role called "Muscle #1" in one
 * crime is a DIFFERENT role from "Muscle #1" in another, with its own weights,
 * checkpoints and per-member CPR (MonChoon, 2026-08-13). Sharing slider state
 * across cards by role name would model something untrue. It also means moving
 * one slider recalculates only that crime.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FlaskConical, Info, LoaderCircle, ListPlus, Trophy, X } from 'lucide-react'
import { apiGet, apiPost } from '../utils/apiClient'
import { useViewState } from '../contexts/ViewStateContext'
import { expectedValue } from '../utils/ocExpectedValue'
import {
  payoutsFromEndings, respectFromEndings, pricingQuality, payoutSpread, paysInItems,
} from '../utils/ocScenarioPayouts'
import { formatCurrency } from '../utils/payoutCalculations'
import { headcountAtCpr, maxSustainableCpr } from '../utils/ocRosterFit'
import { crimeSensitivity, ROLE_CLASS_LABELS, PROBE_DELTA } from '../utils/ocSensitivity'
import { scopeVerdict } from '../utils/ocScope'
import { makeCategoryResolver } from '../utils/ocPlanner'
import { config } from '../config'
import CrimePickerModal from '../components/oc/CrimePickerModal'
import CrimeRankingTable from '../components/oc/CrimeRankingTable'
import {
  selectedScenarios, staleSelections, selectionScopeCost, toggleSelection,
} from '../utils/ocCrimeSelection'

/** Where a fresh crew starts. Mid-range, so moving a slider shows movement. */
const DEFAULT_CPR = 50

/** Debounce on the probability call — it is a request per keystroke otherwise. */
const CALC_DEBOUNCE_MS = 250

export default function OCSimulatorView() {
  const [scenarios, setScenarios] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rankingOpen, setRankingOpen] = useState(false)

  // Persisted: re-picking six crimes on every visit would kill the workflow
  // this screen exists to enable.
  const [persisted, setPersisted] = useViewState('oc_simulator')
  const selected = persisted?.selectedCrimes ?? null

  useEffect(() => {
    apiGet('/api/oc-simulator/scenarios')
      .then((res) => setScenarios(res.scenarios ?? []))
      .catch((e) => setLoadError(e?.message || 'Could not load scenarios'))
  }, [])

  const setSelected = useCallback((next) => {
    setPersisted({ ...(persisted ?? {}), selectedCrimes: next })
  }, [persisted, setPersisted])

  // First visit: show the first crime rather than an empty page, so the screen
  // explains itself without a trip through the picker.
  useEffect(() => {
    if (selected !== null || !scenarios || scenarios.length === 0) return
    setSelected([scenarios[0].name])
  }, [scenarios, selected, setSelected])

  const chosen = useMemo(() => selectedScenarios(scenarios, selected), [scenarios, selected])
  const stale = useMemo(() => staleSelections(scenarios, selected), [scenarios, selected])
  const totalScope = useMemo(() => selectionScopeCost(scenarios, selected), [scenarios, selected])

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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <FlaskConical className="w-5 h-5 text-gray-400" />
              <h2 className="text-lg font-semibold">OC Simulator</h2>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Set each role&apos;s CPR to model a crew before spawning. Numbers come from our
              nightly mirror of the community probability model, not from Torn.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setRankingOpen((v) => !v)}
              className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-slate-600 flex items-center gap-1.5"
            >
              <Trophy className="w-4 h-4" />
              {rankingOpen ? 'Hide ranking' : 'Rank all crimes'}
            </button>
            <button onClick={() => setPickerOpen(true)} className="btn-primary flex items-center gap-1.5 text-sm">
              <ListPlus className="w-4 h-4" />
              {chosen.length > 0 ? `${chosen.length} crime${chosen.length === 1 ? '' : 's'}` : 'Choose crimes'}
            </button>
          </div>
        </div>

        {chosen.length > 1 && totalScope != null && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            Spawning one of each would cost <span className="font-medium">{totalScope} scope</span>.
          </p>
        )}

        {/* A persisted selection can outlive a crime being renamed upstream.
            Say what went missing rather than silently showing fewer cards. */}
        {stale.length > 0 && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            No longer in the mirror, so not shown: {stale.join(', ')}.
          </p>
        )}
      </div>

      {rankingOpen && <CrimeRankingTable scenarios={scenarios} />}

      {chosen.length === 0 && (
        <div className="card text-sm text-gray-600 dark:text-gray-400">
          Nothing selected. Use <span className="font-medium">Choose crimes</span> to pick which to
          compare — they appear in the order you tick them.
        </div>
      )}

      {chosen.map((scenario) => (
        <CrimeCard
          key={scenario.name}
          scenario={scenario}
          onRemove={() => setSelected(toggleSelection(selected, scenario.name))}
        />
      ))}

      {pickerOpen && (
        <CrimePickerModal
          scenarios={scenarios}
          selected={selected ?? []}
          onApply={setSelected}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * One crime, fully self-contained: its own crew, its own result, its own
 * roster readings, its own debounce.
 *
 * Independent state per card is what makes moving a slider recalculate only
 * that crime — six crimes on screen must not mean six requests per adjustment
 * against a small third-party server.
 */
function CrimeCard({ scenario, onRemove }) {
  const [cprs, setCprs] = useState(
    () => Array.from({ length: scenario.parameter_count }, () => DEFAULT_CPR)
  )
  const [result, setResult] = useState(null)
  const [calcError, setCalcError] = useState(null)
  const [calculating, setCalculating] = useState(false)
  const [rosterCpr, setRosterCpr] = useState(null)

  // Re-seed if the mirror changes a crime's role count under us.
  useEffect(() => {
    setCprs((prev) => (prev.length === scenario.parameter_count
      ? prev
      : Array.from({ length: scenario.parameter_count }, () => DEFAULT_CPR)))
  }, [scenario.parameter_count])

  useEffect(() => {
    let cancelled = false
    setRosterCpr(null)
    apiGet(`/api/oc-simulator/roster-cpr/${encodeURIComponent(scenario.name)}`)
      .then((res) => { if (!cancelled) setRosterCpr(res) })
      .catch(() => { if (!cancelled) setRosterCpr(null) })
    return () => { cancelled = true }
  }, [scenario.name])

  // #441: measured ON DEMAND, not per slider tick. It costs one extra request
  // per role, so firing it continuously would turn a 6-role crime into seven
  // requests per adjustment against a small third-party server.
  const [sensitivity, setSensitivity] = useState(null)
  const [measuring, setMeasuring] = useState(false)

  // Any change to the crew invalidates a previous measurement — showing it
  // against a different crew would attribute one crew's numbers to another.
  useEffect(() => { setSensitivity(null) }, [cprs])

  const measure = useCallback(async () => {
    setMeasuring(true)
    try {
      const byRole = {}
      for (let i = 0; i < scenario.roles.length; i++) {
        const role = scenario.roles[i]
        // Step DOWN if the role is already near the ceiling, so the probe stays
        // inside 0-100 and still measures the same local slope.
        const up = (cprs[i] ?? 0) + PROBE_DELTA <= 100
        const delta = up ? PROBE_DELTA : -PROBE_DELTA
        const probe = cprs.map((v, j) => (j === i ? Math.min(100, Math.max(0, v + delta)) : v))
        const [base, bumped] = await Promise.all([
          apiPost('/api/oc-simulator/calculate', { scenario: scenario.name, parameters: cprs }),
          apiPost('/api/oc-simulator/calculate', { scenario: scenario.name, parameters: probe }),
        ])
        byRole[role.position_id] = {
          base: base.result,
          bumped: bumped.result,
          delta,
        }
      }
      // Sign is carried by the probe direction, so a downward probe still
      // yields the slope rather than its negation.
      const rows = crimeSensitivity(
        scenario,
        Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, {
          base: v.delta > 0 ? v.base : v.bumped,
          bumped: v.delta > 0 ? v.bumped : v.base,
        }])),
        PROBE_DELTA
      )
      setSensitivity(rows)
    } catch {
      setSensitivity(null)
    } finally {
      setMeasuring(false)
    }
  }, [scenario, cprs])

  const timerRef = useRef(null)
  const seqRef = useRef(0)

  const calculate = useCallback((name, parameters) => {
    const seq = ++seqRef.current
    setCalculating(true)
    apiPost('/api/oc-simulator/calculate', { scenario: name, parameters })
      .then((res) => {
        // Ignore a response overtaken by a newer one — sliders fire fast, and
        // out-of-order replies would show numbers for a crew no longer on screen.
        if (seq !== seqRef.current) return
        setResult(res.result)
        setCalcError(null)
      })
      .catch((e) => {
        if (seq !== seqRef.current) return
        // No stale result left next to a fresh crew: a success chance is a
        // number people act on.
        setResult(null)
        setCalcError(e?.message || 'The probability service could not be reached')
      })
      .finally(() => { if (seq === seqRef.current) setCalculating(false) })
  }, [])

  useEffect(() => {
    if (cprs.length !== scenario.parameter_count) return
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => calculate(scenario.name, cprs), CALC_DEBOUNCE_MS)
    return () => clearTimeout(timerRef.current)
  }, [scenario.name, scenario.parameter_count, cprs, calculate])

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">{scenario.name}</h3>
          <ModelQuality scenario={scenario} />
        </div>
        <div className="flex items-center gap-3">
          {result && (
            <span className="text-sm tabular-nums">
              <span className="text-gray-500 dark:text-gray-400">success </span>
              <span className="font-semibold text-green-600 dark:text-green-400">
                {(result.successChance * 100).toFixed(2)}%
              </span>
            </span>
          )}
          <button
            onClick={onRemove}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400"
            aria-label={`Remove ${scenario.name}`}
            title="Remove from comparison"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CrewPanel
          scenario={scenario}
          cprs={cprs}
          onChange={setCprs}
          rosterCpr={rosterCpr}
          sensitivity={sensitivity}
          measuring={measuring}
          onMeasure={measure}
        />
        <ResultPanel scenario={scenario} result={result} calculating={calculating} error={calcError} />
      </div>
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

function CrewPanel({ scenario, cprs, onChange, rosterCpr, sensitivity, measuring, onMeasure }) {
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
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={onMeasure}
            disabled={measuring}
            title="Measure what each role is worth: how much it moves success, and how much it moves payout"
            className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-slate-600 disabled:opacity-50 mr-1"
          >
            {measuring ? 'Measuring…' : 'What matters?'}
          </button>
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
            <RoleHeadcount role={role} rosterCpr={rosterCpr} cpr={cprs[i] ?? 0} />
            <RoleSensitivity row={sensitivity?.find((r) => r.positionId === role.position_id)} />
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

/**
 * How many of our members clear this role's bar (#442).
 *
 * ⚠️ "Can fill", never "available". A member with the CPR may already be in
 * another crime — members cannot be in two OCs at once — and this does not know
 * that. It is an upper bound, and the wording has to keep saying so.
 */
function RoleHeadcount({ role, rosterCpr, cpr }) {
  if (!rosterCpr) return null

  // ⚠️ A role we could not join to a Torn position has no readings, which would
  // otherwise render as "0 can fill" — a far more alarming claim than "we could
  // not look", and one that would send someone hunting a training problem that
  // does not exist.
  if ((rosterCpr.unmatched_roles ?? []).includes(role.role_name)) {
    return (
      <div className="text-xs text-gray-400 mt-0.5">
        No CPR readings tied to this role yet — headcount unavailable, not zero.
      </div>
    )
  }
  if ((rosterCpr.conflicts ?? []).some((c) => c.roleName === role.role_name)) {
    return (
      <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
        This role&apos;s name and slot disagree between sources, so its readings are not
        trustworthy enough to count.
      </div>
    )
  }

  const readings = rosterCpr.readings?.[role.position_id] ?? []
  if (readings.length === 0) {
    return (
      <div className="text-xs text-gray-400 mt-0.5">
        Nobody has been observed in this role, so we have no readings for it.
      </div>
    )
  }

  const eligible = headcountAtCpr(readings, cpr)
  const ceiling = maxSustainableCpr(readings, 1)
  return (
    <div className={`text-xs mt-0.5 ${eligible === 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
      <span className="tabular-nums font-medium">{eligible}</span> of {readings.length} can fill
      this at {cpr}
      {eligible === 0 && ceiling != null && (
        <span> — best is {ceiling}</span>
      )}
    </div>
  )
}

/**
 * What this role is worth, as TWO numbers (#441).
 *
 * ⚠️ Never collapsed into one score. A role that barely changes success but
 * decides which ending you reach is a "router", and on Break the Bank the gap
 * between endings is ~$159M — averaging that together with its negligible
 * success effect would make it look unimportant, and someone would put their
 * weakest member there.
 */
function RoleSensitivity({ row }) {
  if (!row || row.kind === 'unknown') return null

  const tone = {
    gate: 'text-blue-600 dark:text-blue-400',
    router: 'text-purple-600 dark:text-purple-400',
    both: 'text-green-600 dark:text-green-400',
    minor: 'text-gray-400',
  }[row.kind]

  return (
    <div className={`text-xs mt-0.5 flex flex-wrap items-center gap-x-3 ${tone}`}>
      <span className="font-medium">{ROLE_CLASS_LABELS[row.kind]}</span>
      {row.dSuccess !== null && (
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {(row.dSuccess * 100).toFixed(3)} pts success / CPR
        </span>
      )}
      {row.dValue !== null ? (
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {formatCurrency(Math.round(row.dValue))} / CPR
        </span>
      ) : (
        /* ⚠️ Not "$0". We could not measure it — either the crime is unpriced
           or this role shifts probability onto endings we cannot value. */
        <span className="text-gray-400" title="Payout effect could not be measured for this role">
          payout effect unknown
        </span>
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

  // ⚠️ E(x) takes BOTH kinds. `expectedValue` has an explicit branch counting
  // bad endings as fully-covered mass paying zero — passing only the good ones
  // made that branch dead code, and the "unpriced coverage" figure was then a
  // share of the good mass reported as a share of ALL the probability. On
  // Clinical Precision that read 78.72% when the real answer is 16.15%: a
  // five-fold overstatement of how much of the crime we cannot price.
  const endingProbabilities = useMemo(() => {
    if (!result) return {}
    return Object.fromEntries(
      Object.entries(result).filter(([k]) => k.startsWith('goodEnding') || k.startsWith('badEnding'))
    )
  }, [result])

  // #440: payouts come from the mirrored feed, joined to endings through the
  // #390 mapping. No hand-entered table any more.
  const priced = useMemo(() => payoutsFromEndings(scenario.endings), [scenario.endings])
  const respect = useMemo(() => respectFromEndings(scenario.endings), [scenario.endings])
  const quality = useMemo(() => pricingQuality(scenario.endings), [scenario.endings])
  const spread = useMemo(() => payoutSpread(scenario.endings), [scenario.endings])
  const itemsOnly = useMemo(() => paysInItems(scenario.endings), [scenario.endings])

  const ev = useMemo(
    () => (result ? expectedValue(scenario.name, endingProbabilities, priced) : null),
    [scenario.name, endingProbabilities, result, priced]
  )

  // Expected respect, on the same terms as expected money.
  const expectedRespect = useMemo(() => {
    if (!result) return null
    let total = 0
    for (const [key, p] of Object.entries(goodProbabilities)) {
      const r = respect[key]
      if (typeof r === 'number' && Number.isFinite(p)) total += p * r
    }
    return total
  }, [goodProbabilities, respect, result])

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

          <ScopeVerdict scenario={scenario} successChance={result.successChance} />

          <ExpectedValue ev={ev} priced={priced} quality={quality} spread={spread}
            expectedRespect={expectedRespect} itemsOnly={itemsOnly} />

          <div className="mt-4">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
              Endings by likelihood
            </div>
            <div className="space-y-1">
              {endings.map(([key, p]) => {
                const meta = endingMeta.get(key)
                const isGood = key.startsWith('goodEnding')
                const payout = isGood ? priced?.[key] : 0
                const obs = meta?.observations ?? null
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
                      {isGood && payout != null && obs != null && obs < 30 && (
                        <span className="text-amber-600 dark:text-amber-400"
                          title={`Averaged from only ${obs} observed run${obs === 1 ? '' : 's'}`}>
                          n={obs}
                        </span>
                      )}
                      {isGood && Number(meta?.item_value_avg) > 0 && (
                        <span className="text-gray-400 dark:text-gray-500" title={
                          `Includes ${formatCurrency(meta.item_value_avg)} of item value at current market prices` +
                          (meta.item_value_unmatched?.length
                            ? ` — could not price: ${meta.item_value_unmatched.join(', ')}`
                            : '')
                        }>
                          +items
                        </span>
                      )}
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
function ExpectedValue({ ev, priced, quality, spread, expectedRespect, itemsOnly }) {
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
            The mirror has no observed payouts for this crime yet, so E(x) cannot be calculated.
            It is left blank rather than shown as zero — a zero would read as &ldquo;this crime
            pays nothing&rdquo;.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-gray-200 dark:border-slate-700 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Expected value {ev.complete ? '' : '(lower bound)'}
        </div>
        {expectedRespect != null && expectedRespect > 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {expectedRespect.toFixed(1)} respect
          </div>
        )}
      </div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">
        {ev.complete ? '' : 'at least '}{formatCurrency(Math.round(ev.expected))}
      </div>

      {/* ⚠️ $0 across every ending does not mean worthless — several crimes
          reward items, which the feed does not price. Saying "pays nothing"
          here would be a wrong answer, not a missing one. */}
      {itemsOnly && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          Every ending on this crime reports no cash, but it still earns respect — its rewards are
          items, which the probability feed does not price. Judge this one on respect, not on E(x).
        </p>
      )}

      {!ev.complete && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {ev.missing.length} ending{ev.missing.length === 1 ? '' : 's'} unpriced, covering{' '}
          {((1 - ev.pricedProbability) * 100).toFixed(2)}% of the probability. The real value is
          higher by an unknown amount — never lower.
        </p>
      )}

      {/* The three ways pricing can be weak have three different fixes, so they
          are reported separately rather than as one "incomplete" badge. */}
      {quality && (quality.unmapped.length > 0 || quality.thin.length > 0) && (
        <div className="mt-2 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
          {quality.unmapped.length > 0 && (
            <div>
              {quality.unmapped.length} ending{quality.unmapped.length === 1 ? '' : 's'} could not
              be matched to the diagram, so they cannot be priced at all.
            </div>
          )}
          {quality.thin.length > 0 && (
            <div className="text-amber-600 dark:text-amber-400">
              {quality.thin.length} priced from very few observed runs — treat those figures as
              rough.
            </div>
          )}
        </div>
      )}

      {/* What a "router" role is worth: the gap between best and worst ending. */}
      {spread && spread.gap > 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Endings range {formatCurrency(spread.worst)} – {formatCurrency(spread.best)}, a spread of{' '}
          <span className="font-medium">{formatCurrency(spread.gap)}</span> — what the roles that
          steer which ending you land in are worth.
        </p>
      )}
    </div>
  )
}

/**
 * Whether this crew can afford to keep running this crime (#444 groundwork).
 *
 * Scope is spent to spawn and only returned on SUCCESS, so every difficulty has
 * a break-even success chance below which the crime drains the faction's
 * ability to spawn anything. That line — not the money — is the answer to
 * "what minimum CPR should we set".
 *
 * ⚠️ A crime paying enormous money below its break-even is still one the
 * faction cannot sustain, and E(x) alone will never say so.
 */
function ScopeVerdict({ scenario, successChance }) {
  const categoryKey = useMemo(() => {
    const resolve = makeCategoryResolver({
      scenarios: config.ocScenarios || {},
      categories: config.ocCategories || {},
    })
    return resolve(scenario.name, null)
  }, [scenario.name])

  const verdict = useMemo(
    () => scopeVerdict(categoryKey, successChance),
    [categoryKey, successChance]
  )
  // Unknown category: say nothing rather than guess a cost.
  if (!verdict) return null

  const pct = (v) => `${(v * 100).toFixed(1)}%`
  return (
    <div className={`rounded border p-3 mb-3 ${verdict.sustainable
      ? 'border-gray-200 dark:border-slate-700'
      : 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Scope — {verdict.label}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          costs {verdict.cost}, pays {verdict.reward} on success
        </div>
      </div>
      <div className={`mt-0.5 text-sm font-semibold ${verdict.sustainable
        ? 'text-green-600 dark:text-green-400'
        : 'text-red-600 dark:text-red-400'}`}>
        {verdict.sustainable
          ? `Sustainable — nets ${verdict.net.toFixed(2)} scope per run`
          : `Scope-negative — loses ${Math.abs(verdict.net).toFixed(2)} scope per run`}
      </div>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        Break-even is {pct(verdict.breakEven)} success; this crew is at{' '}
        {pct(successChance)} ({verdict.margin >= 0 ? '+' : ''}{(verdict.margin * 100).toFixed(1)} pts).
        {!verdict.sustainable && ' Below the line the faction slowly loses the scope to spawn anything.'}
      </p>
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
