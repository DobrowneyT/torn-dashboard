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
import { personDays } from '../utils/ocPersonDays'
import {
  payoutsFromEndings, respectFromEndings, pricingQuality, payoutSpread, paysInItems,
  withoutEndingPadding, collapseAliasedEndings, endingValueBreakdown,
  chainTargetOf, chainTargets, unpricedAreAllChains,
} from '../utils/ocScenarioPayouts'
import { formatCurrency } from '../utils/payoutCalculations'
import { headcountAtCpr, maxSustainableCpr } from '../utils/ocRosterFit'
import { crimeSensitivity, ROLE_CLASS_LABELS, PROBE_DELTA } from '../utils/ocSensitivity'
import { scopeVerdict } from '../utils/ocScope'
import { makeCategoryResolver } from '../utils/ocPlanner'
import { computeGuidance } from '../utils/ocGuidancePipeline'
import { GuidancePanel } from './OCGuidancePanel'
import { ChainPanel } from './OCChainPanel'
import { ObservedPanel } from './OCObservedPanel'
import { JointPanel } from './OCJointPanel'
import { solveForSelection } from '../utils/ocJointPipeline'
import { computeChainEconomics, meanCpr } from '../utils/ocChainPipeline'
import { buildChainIndex, chainFrom } from '../utils/ocChains'
import InfoTooltip, { InfoDot, tipLines } from '../components/InfoTooltip'
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
  // #585: observed previous_crime_id edges, so the ranking can price a crime
  // whose payout is one or two crimes downstream — and, since #712, so a crime
  // card can show what its chain is actually worth.
  const [chains, setChains] = useState([])
  // #715: what this faction actually spawns, so the planner stops assuming.
  const [spawns, setSpawns] = useState(null)
  // #687: the faction's measured join gap, fetched once for the page. ⚠️
  // Declared HERE, in the outer component and above every use — both the joint
  // solve below and each CrimeCard need it, and the card gets it as a PROP
  // rather than fetching its own copy per crime.
  const [joinGap, setJoinGap] = useState(null)
  // #609 slice 7: whether the item catalogue behind every dollar figure below
  // is fresh enough to use. The server withholds prices rather than serving
  // stale ones, so without this the page would show a fleet of "unpriced"
  // endings and no explanation for it.
  const [itemPrices, setItemPrices] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [rankingOpen, setRankingOpen] = useState(false)
  const [jointPlan, setJointPlan] = useState(null)
  const [solvingJoint, setSolvingJoint] = useState(false)

  // Persisted: re-picking six crimes on every visit would kill the workflow
  // this screen exists to enable.
  const [persisted, setPersisted] = useViewState('oc_simulator')
  const selected = persisted?.selectedCrimes ?? null

  useEffect(() => {
    apiGet('/api/oc-simulator/scenarios')
      .then((res) => {
        setScenarios(res.scenarios ?? [])
        setChains(res.chains ?? [])
        setSpawns(res.spawns ?? null)
        setItemPrices(res.item_prices ?? null)
      })
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

  useEffect(() => {
    let cancelled = false
    apiGet('/api/oc-simulator/join-gap')
      .then((res) => { if (!cancelled) setJoinGap(res) })
      .catch(() => { if (!cancelled) setJoinGap(null) })
    return () => { cancelled = true }
  }, [])

  const chosen = useMemo(() => selectedScenarios(scenarios, selected), [scenarios, selected])

  // ⚠️ Declared BELOW `chosen`, and that placement is load-bearing: a hook's
  // dependency array is evaluated immediately, so naming a `const` from above
  // its own declaration is the temporal-dead-zone throw that replaced this page
  // with an error boundary in v3.97.0.
  //
  // Cleared when the selection changes — a plan computed for one set of crimes
  // shown under another is worse than no plan.
  useEffect(() => { setJointPlan(null) }, [selected])

  const solveJoint = useCallback(async () => {
    setSolvingJoint(true)
    // The solve is seconds of synchronous simulation; without a yield React
    // never paints the busy state and the page looks dead (v3.107.1).
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    try {
      const resolveCategory = makeCategoryResolver({
        scenarios: config.ocScenarios || {},
        categories: config.ocCategories || {},
      })
      setJointPlan(await solveForSelection({
        crimes: chosen,
        fetchReadings: (name) =>
          apiGet(`/api/oc-simulator/roster-cpr/${encodeURIComponent(name)}`),
        categoryOf: (name) => (config.ocCategories || {})[resolveCategory(name, null)] ?? null,
        call: (name, parameters) =>
          apiPost('/api/oc-simulator/calculate', { scenario: name, parameters }),
        days: 30, spawnsPerDay: 4,
        gap: joinGap?.measured ? joinGap.gapHours / 24 : 0.5,
        spawns,
      }))
    } catch {
      setJointPlan(null)
    } finally {
      setSolvingJoint(false)
    }
  }, [chosen, spawns, joinGap])
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

        {/* ⚠️ Prices are REFUSED, not silently used, once the catalogue has gone
            stale (#609 slice 7) — the same rule as unpriced endings (#473) and
            item_value_unmatched (#441). Everything below then reports as
            unpriced, which without this banner looks like a data problem
            rather than a deliberate refusal with a fixable cause. */}
        {itemPrices && itemPrices.fresh === false && (
          <div className="mt-3 rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-2">
            <p className="text-xs text-amber-800 dark:text-amber-200">
              <strong>Item prices unavailable.</strong> {itemPrices.reason} Item rewards below are
              reported as unpriced rather than valued at a stale price — every other number is
              unaffected. Check the <em>items-sync</em> job in Global Admin.
            </p>
          </div>
        )}

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

      {rankingOpen && <CrimeRankingTable scenarios={scenarios} chains={chains} />}

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
          scenarios={scenarios}
          chainEdges={chains}
          joinGap={joinGap}
          onRemove={() => setSelected(toggleSelection(selected, scenario.name))}
        />
      ))}

      {/* ⚠️ Below the cards on purpose. Each card's thresholds are a CEILING —
          computed as if that crime had the whole roster — and this is the plan
          that reconciles them. Reading order should match that. */}
      {chosen.length > 1 && (
        <JointPanel
          plan={jointPlan}
          onSolve={solveJoint}
          solving={solvingJoint}
          crimeCount={chosen.length}
        />
      )}

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
export function CrimeCard({ scenario, scenarios = [], chainEdges = [], joinGap = null, onRemove }) {
  const [cprs, setCprs] = useState(
    () => Array.from({ length: scenario.parameter_count }, () => DEFAULT_CPR)
  )
  const [result, setResult] = useState(null)
  const [calcError, setCalcError] = useState(null)
  const [calculating, setCalculating] = useState(false)
  const [rosterCpr, setRosterCpr] = useState(null)
  // ⚠️ Guidance is computed ON DEMAND, never on a slider drag. Each candidate
  // vector is a request to tornprobability, a small third-party server this
  // codebase already counts calls against.
  const [guidance, setGuidance] = useState(null)
  const [guidanceMeta, setGuidanceMeta] = useState(null)
  const [computingGuidance, setComputingGuidance] = useState(false)
  const [chain, setChain] = useState(null)
  const [computingChain, setComputingChain] = useState(false)

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

  // #728: what our OWN runs say. Our server, so it rides along with the roster
  // read rather than waiting for a button.
  const [observed, setObserved] = useState(null)
  useEffect(() => {
    let cancelled = false
    setObserved(null)
    apiGet(`/api/oc-simulator/observed/${encodeURIComponent(scenario.name)}`)
      .then((res) => { if (!cancelled) setObserved(res) })
      .catch(() => { if (!cancelled) setObserved(null) })
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

  // ⚠️ Cleared whenever the crime changes: a table computed for one crime shown
  // under another is worse than no table at all.
  useEffect(() => { setGuidance(null); setGuidanceMeta(null) }, [scenario.name])

  const suggestCprs = useCallback(async () => {
    setComputingGuidance(true)
    // ⚠️ Yield to the browser before the heavy part. Candidate generation is
    // synchronous CPU work — crew matching over the whole roster — so without
    // this React never gets to paint "Working…" and the page simply locks with
    // the button still looking idle. That is exactly how v3.107.0 felt: a dead
    // page, then a faded button appearing seconds later.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    try {
      const resolve = makeCategoryResolver({
        scenarios: config.ocScenarios || {},
        categories: config.ocCategories || {},
      })
      const categoryKey = resolve(scenario.name, null)
      const out = await computeGuidance({
        scenario,
        rosterCpr,
        category: (config.ocCategories || {})[categoryKey] ?? null,
        call: (name, parameters) =>
          apiPost('/api/oc-simulator/calculate', { scenario: name, parameters }),
        // ⚠️ Measured where we have the history, assumed where we do not — and
        // the table says which, because "we measured 12h" and "we assumed 12h"
        // are different claims (#687).
        gap: joinGap?.measured ? joinGap.gapHours / 24 : 0.5,
        gapIsAssumed: !joinGap?.measured,
        // #713: a chain ROOT pays nothing itself, so it is valued at the whole
        // chain. Without these it would be refused — and it is the crime
        // members actually join.
        scenarios,
        chains: chainEdges,
        categoryOf: (name) => resolve(name, null),
        // ⚠️ Fallback only (#725). Downstream links are priced from their OWN
        // roster below; this covers a link this faction has never run.
        chainCpr: meanCpr(cprs) ?? DEFAULT_CPR,
        fetchReadings: (name) =>
          apiGet(`/api/oc-simulator/roster-cpr/${encodeURIComponent(name)}`),
      })
      setGuidance(out.guidance)
      setGuidanceMeta({
        reason: out.reason, limitingRoles: out.limitingRoles,
        chainsTo: out.chainsTo, chainContext: out.chainContext,
        chainSource: out.chainSource,
      })
    } catch {
      // ⚠️ A failure leaves the panel in its idle state rather than showing a
      // half-computed table. Nothing here is worth publishing on a guess.
      setGuidance(null)
      setGuidanceMeta(null)
    } finally {
      setComputingGuidance(false)
    }
  }, [scenario, rosterCpr, scenarios, chainEdges, cprs, joinGap])

  useEffect(() => { setChain(null) }, [scenario.name])

  const valueChain = useCallback(async () => {
    setComputingChain(true)
    // Same yield as the guidance button: the probe awaits are async but the
    // React state has to paint before them.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    try {
      const resolve = makeCategoryResolver({
        scenarios: config.ocScenarios || {},
        categories: config.ocCategories || {},
      })
      setChain(await computeChainEconomics({
        rootName: scenario.name,
        scenarios,
        chains: chainEdges,
        // ⚠️ Flat, and the panel says so: the links have different role counts,
        // so the sliders on screen cannot be carried downstream.
        assumedCpr: meanCpr(cprs) ?? DEFAULT_CPR,
        categoryOf: (name) => resolve(name, null),
        call: (name, parameters) =>
          apiPost('/api/oc-simulator/calculate', { scenario: name, parameters }),
      }))
    } catch {
      setChain(null)
    } finally {
      setComputingChain(false)
    }
  }, [scenario.name, scenarios, chainEdges, cprs])

  const isChain = useMemo(
    () => chainFrom(scenario.name, buildChainIndex(chainEdges)).length > 1,
    [scenario.name, chainEdges]
  )

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
        <div>
          <ResultPanel scenario={scenario} result={result} calculating={calculating} error={calcError} />
          <ObservedPanel
            observed={observed}
            predicted={result?.successChance ?? null}
            crewCpr={meanCpr(cprs)}
          />
          {isChain && (
            <ChainPanel chain={chain} rootName={scenario.name}
              onCompute={valueChain} computing={computingChain} />
          )}
          <GuidancePanel
            guidance={guidance}
            reason={guidanceMeta?.reason}
            limitingRoles={guidanceMeta?.limitingRoles}
            chainsTo={guidanceMeta?.chainsTo}
            chainOf={guidanceMeta?.chainContext ? guidanceMeta.chainContext.links[guidanceMeta.chainContext.links.length - 1].name : null}
            chainSource={guidanceMeta?.chainSource ?? null}
            chainCrew={guidanceMeta?.chainContext
              ? Object.fromEntries(Object.entries(guidanceMeta.chainContext.crewByName)
                  .filter(([n]) => n !== scenario.name))
              : null}
            onCompute={suggestCprs}
            computing={computingGuidance}
          />
        </div>
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
        <InfoTooltip
          label={`${problems.length} diagram note${problems.length === 1 ? '' : 's'}`}
          className="text-gray-500 dark:text-gray-400"
        >
          {tipLines(problems.join('\n'))}
        </InfoTooltip>
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
            className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-slate-600 disabled:opacity-50"
          >
            {measuring ? 'Measuring…' : 'What matters?'}
          </button>
          {/* Its own tap target, not a wrap: the button is live, and one tap
              cannot both explain it and press it. */}
          <InfoDot label="What “What matters?” measures" className="mr-1">
            Measures what each role is worth: how much it moves success, and how
            much it moves payout.
          </InfoDot>
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
        <InfoTooltip label="payout effect unknown" className="text-gray-400">
          Payout effect could not be measured for this role.
        </InfoTooltip>
      )}
    </div>
  )
}

/**
 * The whole reward story for one ending, as hover text.
 *
 * A tooltip rather than more columns because the endings list is already dense
 * and this is detail you go looking for, not detail you scan. What it must
 * always answer: is this cash or items, how wide is it, and how much evidence
 * is behind it.
 *
 * ⚠️ The observation count is stated on the same line as the range, never
 * apart from it. A floor drawn from two runs and one drawn from six thousand
 * render identically, and the number is the only thing that separates them.
 */
/**
 * The reward breakdown as panel content (#612).
 *
 * ⚠️ `whitespace-pre-wrap`, not `tipLines`: rewardTooltip lays the drops out
 * with indentation and blank-line separators, which is structure the author
 * chose. Trimming each line to make paragraphs would throw it away.
 */
function RewardTip({ breakdown }) {
  const text = rewardTooltip(breakdown)
  if (!text) return null
  return <div className="whitespace-pre-wrap font-mono text-[10px] leading-snug">{text}</div>
}

function rewardTooltip(b) {
  if (!b) return undefined
  const lines = []
  const noun = b.kind === 'items' ? 'Item value' : 'Cash'
  lines.push(`${noun}: ${formatCurrency(Math.round(b.total))} on average`)
  if (b.range) {
    lines.push(b.kind === 'items'
      ? `Ranges ${formatCurrency(Math.round(b.range.lo))} – ${formatCurrency(Math.round(b.range.hi))}`
        + ' (floor = drops never missed, ceiling = every drop at its largest stack)'
      : `Observed ${formatCurrency(Math.round(b.range.lo))} – ${formatCurrency(Math.round(b.range.hi))}`)
  }
  if (b.observations != null) {
    lines.push(`From ${b.observations.toLocaleString()} observed run${b.observations === 1 ? '' : 's'}`)
  }
  if (b.kind === 'items' && b.drops.length > 0) {
    lines.push('')
    lines.push('Drops, at current market prices:')
    for (const d of b.drops) {
      const qty = d.qty && d.qty.max !== d.qty.min ? `${d.qty.min}\u2013${d.qty.max}` : `${d.qty?.avg ?? 1}`
      lines.push(
        `  ${d.name} \u00D7${qty}  \u00B7  ${(d.dropRate * 100).toFixed(1)}% of runs`
        + `  \u00B7  ${formatCurrency(Math.round(d.contribution))}`
      )
    }
  }
  if (b.unmatched.length > 0) {
    lines.push('')
    // Absent beats confidently wrong: these drops are real and the total below
    // does not include them, so the figure is a floor rather than an estimate.
    lines.push(`Could not price: ${b.unmatched.join(', ')} — the total excludes them.`)
  }
  return lines.join('\n')
}

/**
 * ⚠️ Exported for tests ONLY, and it earns the export.
 *
 * This panel is the one part of the Simulator with real derivation logic in it,
 * and it shipped a crash in v3.97.0 — a useMemo naming `collapsed` from above
 * its own declaration, which is a temporal-dead-zone throw the moment the panel
 * renders with a result. Every pure helper it calls was covered; nothing
 * mounted the component, so "Cannot access 'o' before initialization" reached
 * production and took the whole page down. See ResultPanel.test.jsx.
 */
export function ResultPanel({ scenario, result, calculating, error }) {
  // ⚠️ E(x) takes BOTH kinds. `expectedValue` has an explicit branch counting
  // bad endings as fully-covered mass paying zero — passing only the good ones
  // made that branch dead code, and the "unpriced coverage" figure was then a
  // share of the good mass reported as a share of ALL the probability. On
  // Clinical Precision that read 78.72% when the real answer is 16.15%: a
  // five-fold overstatement of how much of the crime we cannot price.
  //
  // ⚠️ And the service pads its answer with ending slots the crime does not
  // have — see withoutEndingPadding(), which is why the raw response is never
  // read directly here. Everything below derives from the trimmed map, so the
  // list, E(x) and the respect total cannot disagree about which endings exist.
  const endingProbabilities = useMemo(
    () => (result ? withoutEndingPadding(result, scenario.endings) : {}),
    [result, scenario.endings]
  )

  // Only good endings carry money, and only some of them are priced.
  // ⚠️ Alias rows are FOLDED IN, not hidden. goodEnding3, goodEnding35 and
  // goodEnding310 are one outcome under three labels, so the surviving row
  // carries their combined 17.778% — which is what Crimes Hub's simulator
  // reports for that terminal. Hiding them instead would leave the ending
  // reading 10.526% and the column no longer summing to 100%.
  const collapsed = useMemo(
    () => collapseAliasedEndings(endingProbabilities, scenario.endings),
    [endingProbabilities, scenario.endings]
  )

  // ⚠️ MUST stay below `collapsed` — a useMemo dependency array is evaluated
  // immediately, not deferred with the callback, so naming `collapsed` from
  // above its own declaration is a temporal-dead-zone throw, not a lint nit.
  // That shipped in v3.97.0 and took the whole Simulator down with
  // "Cannot access 'o' before initialization".
  const goodProbabilities = useMemo(
    () => Object.fromEntries(
      Object.entries(collapsed.probabilities).filter(([k]) => k.startsWith('goodEnding'))
    ),
    [collapsed]
  )

  const endings = useMemo(
    () => Object.entries(collapsed.probabilities).sort((a, b) => b[1] - a[1]),
    [collapsed]
  )

  // #440: payouts come from the mirrored feed, joined to endings through the
  // #390 mapping. No hand-entered table any more.
  const priced = useMemo(() => payoutsFromEndings(scenario.endings), [scenario.endings])
  const respect = useMemo(() => respectFromEndings(scenario.endings), [scenario.endings])
  const quality = useMemo(() => pricingQuality(scenario.endings), [scenario.endings])
  const spread = useMemo(() => payoutSpread(scenario.endings), [scenario.endings])
  const itemsOnly = useMemo(() => paysInItems(scenario.endings), [scenario.endings])

  // ⚠️ The COLLAPSED map, so E(x) and the list agree about which endings exist.
  // The total is identical either way — an alias prices from the same node as
  // its target, so summing rows that share a payout changes nothing — but a
  // `missing` list naming a row nobody can see would be unexplainable.
  const ev = useMemo(
    () => (result ? expectedValue(scenario.name, collapsed.probabilities, priced) : null),
    [scenario.name, collapsed, result, priced]
  )

  // ⚠️ BELOW `ev`, and that placement is load-bearing. A useMemo dependency
  // array is evaluated IMMEDIATELY, not deferred with the callback, so naming
  // `ev` from above its own declaration is a temporal-dead-zone throw on every
  // render — which is exactly how v3.97.0 replaced this page with an error
  // boundary for every user.
  const chainOut = useMemo(() => chainTargets(scenario.endings), [scenario.endings])
  const chainedOnly = useMemo(
    () => (ev ? unpricedAreAllChains(scenario.endings, ev.missing) : false),
    [scenario.endings, ev]
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

          <DisputedSuccess endings={endings} endingMeta={endingMeta}
            successChance={result.successChance} />

          <ScopeVerdict scenario={scenario} successChance={result.successChance} />

          <ExpectedValue ev={ev} priced={priced} quality={quality} spread={spread}
            expectedRespect={expectedRespect} itemsOnly={itemsOnly} chainedOnly={chainedOnly}
          chainOut={chainOut} roleCount={scenario.roles?.length ?? scenario.parameter_count}
        />

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
                const merged = collapsed.mergedLabels.get(key) ?? null
                const breakdown = isGood ? endingValueBreakdown(meta) : null
                return (
                  <div key={key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isGood ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className="truncate">{key}</span>
                      {/* ⚠️ GOOD endings only, both of them. A bad ending pays $0 by
                          the game's rules (BAD_ENDINGS_PAY_ZERO), so whether it
                          resolved to a diagram node changes nothing anyone can
                          act on — and 97 of the fleet's bad endings are
                          unmapped, which put an amber badge on half the rows of
                          crimes whose pricing is complete. pricingQuality()
                          already scoped its own summary to good endings; this
                          was the one place still asking every row. */}
                      {/* One outcome the service labels several ways (#606). The
                          extra rows are gone — folded into this one — so all that
                          is left to say is that this row's chance is a sum, which
                          belongs on hover rather than back in the list. */}
                      {merged && (
                        <InfoTooltip
                          label={`×${merged.length}`}
                          className="text-gray-400 dark:text-gray-500 shrink-0"
                        >
                          The probability service reports this one diagram ending
                          under {merged.length} labels ({merged.join(', ')}). Their
                          chances are added together here; the payout is identical
                          for all of them because they share a node.
                        </InfoTooltip>
                      )}
                      {/* ⚠️ The two sources disagree about whether this outcome is a
                          success or a failure (#606), and neither is adopted. It
                          takes precedence over the starved tag below because
                          "no diagram match" describes a GAP, and this is not a
                          gap — the other model has the ending, it just files it
                          on the other side. */}
                      {meta?.disputed_kind && (
                        <InfoTooltip
                          label={`Crimes Hub: ${meta.disputed_kind === 'bad' ? 'failure' : 'success'}`}
                          className="text-amber-600 dark:text-amber-400 shrink-0"
                        >
                          Contested: the probability service counts this as a
                          {isGood ? ' success' : ' failure'}, Crimes Hub draws it as a
                          {meta.disputed_kind === 'bad' ? ' failure' : ' success'}.
                          Neither is adopted — the payout is $0 either way, so only
                          the success chance is affected.
                        </InfoTooltip>
                      )}
                      {isGood && !meta?.disputed_kind && meta?.starved && (
                        <InfoTooltip
                          label="no diagram match"
                          className="text-gray-400 dark:text-gray-500 shrink-0"
                        >
                          {tipLines(meta.problem) ?? 'No diagram terminal for this ending — confirmed, treated as $0 (#473).'}
                        </InfoTooltip>
                      )}
                      {isGood && meta && !meta.resolved && !meta.starved && (
                        <InfoTooltip
                          label="unmapped"
                          className="text-amber-600 dark:text-amber-400 shrink-0"
                        >
                          {tipLines(meta.problem) ?? 'This ending could not be matched to the diagram.'}
                        </InfoTooltip>
                      )}
                    </span>
                    <span className="flex items-center gap-3 whitespace-nowrap tabular-nums">
                      {/* ⚠️ "unpriced" describes a gap in OUR measurement.
                          A chain link is not that — it pays nothing because
                          success spawns the next crime, which is what the
                          crime IS (#585: 124/124 successful Stacking the Deck
                          runs spawned a child). Saying "unpriced" sends
                          somebody hunting a number that does not exist. */}
                      <InfoTooltip
                        label={isGood && payout == null && chainTargetOf(meta)
                          ? <span className="text-indigo-600 dark:text-indigo-400">→ {chainTargetOf(meta)}</span>
                          : isGood && payout == null
                            ? 'unpriced'
                            : formatCurrency(payout ?? 0)}
                        decoration={breakdown ? undefined : 'no-underline'}
                        className="text-gray-500 dark:text-gray-400"
                      >
                        {breakdown ? <RewardTip breakdown={breakdown} /> : null}
                      </InfoTooltip>
                      {/* The observed spread, where there is one. On a cash
                          ending this is what the node actually paid across its
                          runs; on an items ending it is the floor and ceiling of
                          the drops. Either way the reader was previously shown a
                          single averaged number with no hint of its width — on
                          Blast from the Past that hid a $50M swing. */}
                      {breakdown?.range && (
                        <InfoTooltip
                          label={`${formatCurrency(breakdown.range.lo)}–${formatCurrency(breakdown.range.hi)}`}
                          className="text-gray-400 dark:text-gray-500 hidden sm:inline"
                        >
                          <RewardTip breakdown={breakdown} />
                        </InfoTooltip>
                      )}
                      {isGood && payout != null && obs != null && obs < 30 && (
                        <InfoTooltip label={`n=${obs}`} className="text-amber-600 dark:text-amber-400">
                          Averaged from only {obs} observed run{obs === 1 ? '' : 's'}.
                        </InfoTooltip>
                      )}
                      {/* ⚠️ "in items", not "+items". Nothing is being ADDED: no
                          crime in the fleet pays both cash and items, so on the
                          eight that drop items this figure IS the payout, priced
                          at current market rates. The old label read as a bonus
                          on top of a cash reward that does not exist. */}
                      {isGood && breakdown?.kind === 'items' && (
                        <InfoTooltip label="in items" className="text-gray-400 dark:text-gray-500">
                          <RewardTip breakdown={breakdown} />
                        </InfoTooltip>
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
function ExpectedValue({ ev, priced, quality, spread, expectedRespect, itemsOnly, chainedOnly, chainOut = [], roleCount }) {
  // ⚠️ Absent rather than zero when the crime is unpriced — a chain root pays
  // nothing itself, and $0 per person-day would read as worthless (#351).
  const perPersonDay =
    ev?.complete && Number.isFinite(ev.expected) && ev.expected > 0 && roleCount >= 1
      ? ev.expected / personDays(roleCount)
      : null

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

      {/* ⚠️ **$ per person-day (#602).** This is the metric the whole model
          optimises — `perPersonPerDay` has existed since #690 and was consulted
          only inside `ocThresholdSearch`'s scoring, so the number that makes two
          crimes comparable was absent from the page built to compare crimes.

          A 4-role crime and a 6-role crime cannot be compared on E(x): the
          6-role one locks 23.5 person-days against the other's 11.5. Forge's
          Break the Bank pays 2.8x Clinical Precision per run and only 1.4x per
          person-day, which is the figure that decides what to spawn. */}
      {perPersonDay !== null && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          <strong className="tabular-nums">{formatCurrency(Math.round(perPersonDay))}</strong>{' '}
          per person-day — {roleCount} roles hold{' '}
          <span className="tabular-nums">{personDays(roleCount).toFixed(1)}</span> person-days
          per run. This is what compares one crime against another.
        </p>
      )}

      {/* ⚠️ $0 across every ending does not mean worthless — several crimes
          reward items, which the feed does not price. Saying "pays nothing"
          here would be a wrong answer, not a missing one. */}
      {itemsOnly && (
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          Every ending on this crime reports no cash, but it still earns respect — its rewards are
          items, which the probability feed does not price. Judge this one on respect, not on E(x).
        </p>
      )}

      {/* ⚠️ A chain and a measurement gap need DIFFERENT messages. "The real
          value is higher by an unknown amount" is right for an ending we have
          not priced and wrong for one whose value we know perfectly well —
          it is simply on another crime. */}
      {!ev.complete && chainedOnly && (
        <p className="mt-1 text-xs text-indigo-600 dark:text-indigo-400">
          This crime pays no money itself — every successful ending spawns{' '}
          <strong>{chainOut.join(' or ')}</strong>, covering{' '}
          {(ev.missingProbability * 100).toFixed(2)}% of the probability. Its value is whatever{' '}
          {chainOut.length === 1 ? chainOut[0] : 'that crime'} is worth, so judge the pair
          together rather than reading this as a zero.
        </p>
      )}
      {!ev.complete && !chainedOnly && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {ev.missing.length} ending{ev.missing.length === 1 ? '' : 's'} unpriced, covering{' '}
          {(ev.missingProbability * 100).toFixed(2)}% of the probability. The real value is
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
/**
 * Where the two sources disagree about whether an outcome is a success (#606).
 *
 * ⚠️ The alternative figure is DERIVED LIVE, not read from the model. Our
 * success chance minus the contested endings' probability is what the other
 * model gives, because the two agree on everything else: on Counter Offer all
 * four good terminals match to within 0.005 points, and only the classification
 * of two endings differs. Deriving it means the caveat works at every crew,
 * where a recorded figure would only be true at the one crew it was captured at.
 *
 * `disputed_success_chance` is kept as the ANCHOR that proves the derivation:
 * at all CPRs 75 it reproduces Crimes Hub's published 84.91%, and a test pins
 * that. It is evidence, not an input.
 *
 * The disagreement does not touch the payout — a failure pays $0 and these
 * endings are already valued at $0, so E(x) is identical either way. It moves
 * the success chance, and the scope verdict directly below reads off exactly
 * that number.
 */
function DisputedSuccess({ endings, endingMeta, successChance }) {
  const ours = Number(successChance)
  if (!Number.isFinite(ours)) return null

  const contested = endings.filter(([key]) => endingMeta.get(key)?.disputed_kind === 'bad')
  if (contested.length === 0) return null

  const mass = contested.reduce((sum, [, p]) => sum + (Number(p) || 0), 0)
  // Nothing worth a warning: the contested endings are unreachable at this crew.
  if (mass <= 0) return null
  const theirs = ours - mass

  return (
    <div className="mt-3 rounded border border-amber-300 dark:border-amber-700/60 p-3">
      <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">
            Contested: Crimes Hub&rsquo;s model puts this crew at {(theirs * 100).toFixed(2)}%.
          </div>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            The two disagree about {contested.length} ending{contested.length === 1 ? '' : 's'} worth{' '}
            {(mass * 100).toFixed(2)}% of runs ({contested.map(([k]) => k).join(', ')}). The
            probability service counts {contested.length === 1 ? 'it' : 'them'} as successes;
            Crimes Hub draws {contested.length === 1 ? 'it' : 'them'} as failures — and marks{' '}
            {contested.length === 1 ? 'it' : 'them'} uncertain itself.
          </p>
          <p className="mt-1 text-gray-600 dark:text-gray-400">
            Neither is adopted, and the <span className="font-medium">expected value is
            unaffected</span> either way — a failure pays nothing, and these are already valued
            at nothing. The scope verdict below reads off the success chance, so treat its
            margin as the optimistic end of a range.
          </p>
        </div>
      </div>
    </div>
  )
}

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
