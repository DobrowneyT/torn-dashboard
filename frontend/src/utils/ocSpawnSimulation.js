/**
 * Does the roster survive contact with how crimes actually spawn? (#693)
 *
 * Slice 4 (#692) optimises ONE crime in a steady state. This checks the thing
 * that optimisation cannot see: spawning is lumpy, partly outside our control,
 * and **members are shared across every crime in flight**. A threshold set that
 * is optimal per crime can be unfillable the moment three crimes want the same
 * six people.
 *
 * ⚠️ "A member cannot be in two organised crimes at once" is a GAME RULE, not a
 * modelling choice, and it is the entire reason this slice exists. Crewing goes
 * through the matching in #689 against members who are actually free — never
 * through a per-role headcount, which cannot see overlap and is optimistic by
 * up to 5x.
 *
 * ## Deterministic, on purpose
 *
 * Spawns are allocated by weight in a largest-remainder round robin rather than
 * drawn at random. A leader asking "are we short?" needs a reproducible answer,
 * not a sample — and a plan that reshuffles between runs is not a plan.
 * Variance analysis is a separate question from feasibility.
 *
 * ## Agnostic to the tier ladder
 *
 * No tier name, tier count or role count appears here. Scenarios arrive with
 * their own `spawnWeight` and `category`, so the Advanced 25%-each and the
 * Elaborate 2:2:1 are *data*, and a tier added above Elaborate is a config
 * entry. ⚠️ The Elaborate "1 we cannot do" needs no special handling either: a
 * scenario nobody can crew reports itself, with the reason.
 */

import { maxDisjointCrews } from './ocCrewMatching'
import { personDays } from './ocPersonDays'

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export const DEFAULT_SCOPE = { start: 100, cap: 100, regenPerDay: 1 }

/**
 * Spawn order for `days × spawnsPerDay` slots, honouring each scenario's weight.
 *
 * Largest-remainder: give every scenario its exact share of the total, then
 * hand the rounding leftovers to whoever was shorted most. Interleaved rather
 * than blocked, so a heavily-weighted crime does not monopolise the first half
 * of the horizon and flatter itself on availability.
 */
function spawnSchedule(scenarios, slots) {
  const weights = scenarios.map((s) => Math.max(0, num(s.spawnWeight) ?? 1))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0 || slots <= 0) return []

  const exact = weights.map((w) => (w / total) * slots)
  const counts = exact.map(Math.floor)
  let left = slots - counts.reduce((a, b) => a + b, 0)
  const byRemainder = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i)
  for (let j = 0; left > 0; j = (j + 1) % byRemainder.length, left -= 1) {
    counts[byRemainder[j].i] += 1
  }

  // Interleave by repeatedly taking whoever is furthest behind their share.
  const issued = counts.map(() => 0)
  const order = []
  for (let n = 0; n < slots; n += 1) {
    let pick = -1
    let best = -Infinity
    for (let i = 0; i < scenarios.length; i += 1) {
      if (issued[i] >= counts[i]) continue
      const deficit = counts[i] === 0 ? -Infinity : issued[i] / counts[i]
      const score = -deficit
      if (score > best) { best = score; pick = i }
    }
    if (pick === -1) break
    issued[pick] += 1
    order.push(scenarios[pick])
  }
  return order
}

/** Why a scenario can never be crewed, or null if it can. */
function unfillableReason(scenario, readings) {
  for (const pos of scenario.positionIds) {
    const rows = readings?.[scenario.name]?.[pos] ?? []
    const usable = rows.filter((r) => num(r?.cpr) !== null)
    // ⚠️ "Never observed" is not "nobody is good enough" (#351). The first is a
    // gap in our measurement — forge's current state on Elaborate roles — and
    // reporting it as an infeasible tier would be a verdict we have not earned.
    if (usable.length === 0) return 'no-readings'
    const bar = num(scenario.vector?.[pos])
    if (bar !== null && !usable.some((r) => num(r.cpr) >= bar)) return 'below-bar'
  }
  return null
}

export function simulateSpawns({
  scenarios = [], readings = {}, days = 30, spawnsPerDay = 1,
  gap, rosterSize = null, scope: scopeOpts = {},
} = {}) {
  const scope = { ...DEFAULT_SCOPE, ...scopeOpts }
  const order = spawnSchedule(scenarios, Math.max(0, Math.round(days * spawnsPerDay)))

  const perScenario = {}
  for (const s of scenarios) {
    const reason = unfillableReason(s, readings)
    perScenario[s.name] = {
      spawned: 0, filled: 0, unfilled: 0, bindingRoles: [],
      unfillable: reason !== null, unfillableReason: reason,
      scopeSpent: 0, scopeReturned: 0, income: 0,
    }
  }

  /** memberId -> day it becomes free again. */
  const busyUntil = new Map()
  const completions = new Map()   // day -> [{ scenario, members }]
  const unfillReasons = {}
  const bindingSeen = {}
  let banked = scope.start
  let filled = 0
  let unfilled = 0
  let income = 0
  let reservedPersonDays = 0

  const note = (key) => { unfillReasons[key] = (unfillReasons[key] ?? 0) + 1 }

  let slot = 0
  for (let day = 0; day < days; day += 1) {
    // Completions first: a crew released this morning can be re-used today.
    for (const done of completions.get(day) ?? []) {
      for (const m of done.members) busyUntil.delete(m)
      const cost = num(done.scenario.category?.scopeCost) ?? 0
      const reward = num(done.scenario.category?.scopeReward) ?? 0
      const p = num(done.scenario.successChance) ?? 0
      // ⚠️ EXPECTED scope back, not a coin flip. The cost was already spent at
      // spawn; only success pays it back, and that asymmetry is the whole scope
      // economy (ocScope.js).
      banked = Math.min(scope.cap, banked + p * reward)
      perScenario[done.scenario.name].scopeReturned += p * reward
      void cost
    }
    completions.delete(day)

    banked = Math.min(scope.cap, banked + scope.regenPerDay)

    for (let i = 0; i < spawnsPerDay && slot < order.length; i += 1, slot += 1) {
      const s = order[slot]
      const row = perScenario[s.name]
      row.spawned += 1

      const cost = num(s.category?.scopeCost) ?? 0
      if (banked < cost) { row.unfilled += 1; unfilled += 1; note('no-scope'); continue }

      // Only members who are free today can be committed.
      const free = {}
      for (const pos of s.positionIds) {
        free[pos] = (readings?.[s.name]?.[pos] ?? []).filter((r) => !busyUntil.has(String(r.member_id)))
      }
      const match = maxDisjointCrews(free, s.vector, { maxK: 1 })
      if (match.k < 1) {
        row.unfilled += 1
        unfilled += 1
        note('no-crew')
        for (const r of match.limitingRoles ?? []) {
          bindingSeen[s.name] = bindingSeen[s.name] ?? new Set()
          bindingSeen[s.name].add(r)
        }
        continue
      }

      const crew = Object.values(match.crews[0])
      const n = s.positionIds.length
      // ⚠️ Reserved for the crime's FULL duration. In reality the last joiner is
      // held one day, not `n` — see `occupancy` in the result, which reports how
      // much this overstates. Conservative, which is the safe direction for a
      // feasibility check, but not a free assumption.
      const until = day + n
      for (const m of crew) busyUntil.set(String(m), until)
      reservedPersonDays += n * n

      banked -= cost
      row.scopeSpent += cost
      const ex = num(s.expectedValue) ?? 0
      row.income += ex
      income += ex
      row.filled += 1
      filled += 1
      if (!completions.has(until)) completions.set(until, [])
      completions.get(until).push({ scenario: s, members: crew })
    }
  }

  for (const [name, roles] of Object.entries(bindingSeen)) {
    perScenario[name].bindingRoles = [...roles].sort()
  }

  const spawned = filled + unfilled
  const netPerSpawn = (() => {
    if (spawned === 0) return null
    let net = 0
    for (const s of scenarios) {
      const r = perScenario[s.name]
      if (r.filled === 0) continue
      const cost = num(s.category?.scopeCost) ?? 0
      const reward = num(s.category?.scopeReward) ?? 0
      net += r.filled * ((num(s.successChance) ?? 0) * reward - cost)
    }
    return filled === 0 ? null : net / filled
  })()

  // ⚠️ Solvency is a PORTFOLIO question and the answer is a recommendation, not
  // a veto (#692 → #701). "Two Simple spawns a week cover the gap" is
  // actionable; "Elaborate is disallowed" is not, and is not what was asked.
  const spawnsPerDayActual = days > 0 ? filled / days : 0
  const scopeDrainPerDay = netPerSpawn === null ? 0 : -(netPerSpawn * spawnsPerDayActual)
  const shortfallPerDay = Math.max(0, scopeDrainPerDay - scope.regenPerDay)

  const sampleRoles = scenarios[0]?.positionIds?.length ?? 0
  const truePerCrime = personDays(sampleRoles, gap)

  return {
    days, spawned, filled, unfilled, unfillReasons, perScenario,
    scope: {
      start: scope.start, end: banked, netPerSpawn,
      solvent: shortfallPerDay === 0,
      shortfallPerDay,
      drainPerDay: scopeDrainPerDay,
      regenPerDay: scope.regenPerDay,
    },
    income: {
      total: income,
      perFactionMemberPerDay:
        rosterSize && rosterSize > 0 && days > 0 ? income / (rosterSize * days) : null,
    },
    occupancy: {
      model: 'reserved-for-full-duration',
      reservedPersonDaysPerCrime: sampleRoles * sampleRoles,
      truePersonDaysPerCrime: truePerCrime,
      overstatement: truePerCrime ? (sampleRoles * sampleRoles) / truePerCrime : null,
      reservedPersonDays,
    },
  }
}
