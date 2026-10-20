// #1022 / #1023 — run the OC action feed's producers once a minute.
//
// ⚠️ **Zero Torn calls.** Everything comes from what `crime-occupancy`,
// `cpr-scan` and the members sync already stored (`collectOcWatch` reads the
// same snapshots the board does), 15 seconds behind the occupancy poll.
//
// ⚠️ **Stale crimes mean do nothing.** If the crimes snapshot is old the
// producers would see nobody seated and nothing open, and close every
// suggestion as expired. Waiting a minute is harmless; that is not.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { collectOcWatch } from '../../ocWatchInternal.js'
import { reportSuggestions, feedKinds } from '../../ocSuggestions.js'
import {
  joinedTooLow, notInAnyOc, seatSwap, swapResolved, TOO_LOW_WINDOW_HOURS_DEFAULT, IDLE_GRACE_MINUTES_DEFAULT,
  NEW_MEMBER_HOURS_DEFAULT,
  SWAP_MIN_GAIN_PP_DEFAULT, SWAP_MIN_WEIGHTED_GAIN_DEFAULT, type Crime, type Readings, type SwapCrime,
} from '../../ocSuggestionProducers.js'
import { loadOcModel, scenarioDiagram, type OcScenarioModel } from '../../oc/modelLoader.js'
import { parseScenarioTree, type ScenarioTree } from '../../oc/scenarioTree.js'
import { simulatedSuccess } from '../../oc/scenarioSimulator.js'
import { MAX_ROLE_FIDELITY_ERROR } from '../../oc/roleFidelity.js'

/** "Online" for a swap (MonChoon: both people online): Torn says Online, or acted in the last 5 min. */
export const ONLINE_WITHIN_SEC = 300

const trees = new Map<string, ScenarioTree | null>()

/**
 * Success chance for a crime's CPR vector, from the committed scenario model —
 * or null when the local simulation is not trustworthy for this crime.
 *
 * ⚠️ Local only: no call to tornprobability. Where the model's own fidelity
 * check says the diagram reproduces the service (error ≤ 0.02), its answer is
 * as good as the service's; where it does not (Ace in the Hole, Clinical
 * Precision…), the swap is ranked on role weights and SAYS so.
 */
function successFor(model: OcScenarioModel | undefined): ((v: Record<string, number>) => number) | null {
  if (!model || !model.diagramValid) return null
  const err = Number((model.roleFidelity as { error?: number } | null)?.error)
  if (!Number.isFinite(err) || err > MAX_ROLE_FIDELITY_ERROR) return null
  if (!trees.has(model.slug)) {
    const mmd = scenarioDiagram(model.slug)
    trees.set(model.slug, mmd ? parseScenarioTree(mmd) : null)
  }
  const tree = trees.get(model.slug)
  if (!tree) return null
  const roleNames = model.roles.map((r) => r.roleName)
  return (v) => simulatedSuccess(tree, roleNames,
    Object.fromEntries(model.roles.map((r) => [r.roleName, v[r.positionId] ?? 0])))
}

export const CRIMES_MAX_AGE_MS = 5 * 60_000

async function numberSetting(db: JobDeps['db'], key: string, fallback: number): Promise<number> {
  const { rows } = await db.query(`SELECT value #>> '{}' AS v FROM faction_settings WHERE key = $1`, [key])
  const n = Number(rows[0]?.v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export async function ocSuggestionsJob({ db }: JobDeps): Promise<RunResult> {
  const nowMs = Date.now()
  const feed = await collectOcWatch(db, nowMs)
  if (feed.crimes_fetched_at == null || nowMs - feed.crimes_fetched_at > CRIMES_MAX_AGE_MS) {
    return { rows: 0, details: { skipped: 'crimes snapshot missing or stale' } }
  }
  const crimes = feed.crimes as Crime[]

  const { rows: current } = await db.query(
    `SELECT member_id, member_name FROM members WHERE is_current IS TRUE AND is_fallen IS NOT TRUE`)
  // ⚠️ Names from Torn's roster first: a member who signed in before the
  // hourly members sync still has the placeholder "Member <id>" here.
  const placeholder = (id: string, n: unknown) => !n || n === `Member ${id}`
  const rosterName = new Map<string, string>()
  for (const m of (feed.members as any[]) ?? []) if (m?.id != null && m?.name) rosterName.set(String(m.id), String(m.name))
  const names = new Map<string, string>(current.map((r: any) => {
    const id = String(r.member_id)
    return [id, rosterName.get(id) ?? (placeholder(id, r.member_name) ? id : r.member_name)]
  }))
  const ids = [...names.keys()]

  const readings: Readings = new Map()
  if (ids.length) {
    const { rows } = await db.query(
      `SELECT member_id, crime_name, position_label, cpr_value FROM member_cpr_v2 WHERE member_id = ANY($1)`, [ids])
    for (const r of rows) {
      const m = readings.get(String(r.member_id)) ?? new Map<string, number>()
      m.set(`${r.crime_name}||${r.position_label}`, Math.round(Number(r.cpr_value)))
      readings.set(String(r.member_id), m)
    }
  }

  const stateOf = new Map<string, string>()
  for (const m of (feed.members as any[]) ?? []) if (m?.id != null) stateOf.set(String(m.id), m?.status?.state ?? null)
  const { rows: seen } = await db.query(`SELECT member_id, max(last_seen_at)::bigint AS last FROM crime_occupancy GROUP BY 1`)
  const { rows: stints } = await db.query(
    `SELECT member_id, extract(epoch FROM joined_at)::bigint AS joined FROM member_faction_stints WHERE left_at IS NULL`)
  const joinedFactionSec = new Map<string, number>(stints.map((r: any) => [String(r.member_id), Number(r.joined)]))
  const lastSeatedSec = new Map<string, number>(seen.map((r: any) => [String(r.member_id), Number(r.last)]))

  const previous = async (kind: string) => (await db.query(
    `SELECT key FROM oc_suggestions WHERE kind = $1 AND status IN ('open', 'snoozed')`, [kind])).rows.map((r: any) => r.key)

  const nowSec = Math.floor(nowMs / 1000)
  const tooLow = joinedTooLow({
    crimes, readings, names, nowSec,
    windowHours: await numberSetting(db, 'oc_too_low_window_hours', TOO_LOW_WINDOW_HOURS_DEFAULT),
    previousKeys: await previous('too_low'),
  })
  const idle = notInAnyOc({
    crimes, readings, nowSec, lastSeatedSec,
    members: ids.map((id) => ({ id, name: names.get(id) ?? id, state: stateOf.get(id) ?? null })),
    joinedFactionSec,
    graceMinutes: await numberSetting(db, 'oc_idle_grace_minutes', IDLE_GRACE_MINUTES_DEFAULT),
    newMemberHours: await numberSetting(db, 'oc_idle_new_member_hours', NEW_MEMBER_HOURS_DEFAULT),
    previousKeys: await previous('idle'),
  })

  // #1021 — better seating within each crime.
  const online = new Set<string>()
  for (const m of (feed.members as any[]) ?? []) {
    const la = m?.last_action ?? {}
    if (la.status === 'Online' || (Number(la.timestamp) && nowSec - Number(la.timestamp) <= ONLINE_WITHIN_SEC)) online.add(String(m.id))
  }
  const model = loadOcModel()
  const minGainPp = await numberSetting(db, 'oc_swap_min_gain_pp', SWAP_MIN_GAIN_PP_DEFAULT)
  const minWeightedGain = await numberSetting(db, 'oc_swap_min_weighted_gain', SWAP_MIN_WEIGHTED_GAIN_DEFAULT)
  const swaps = []
  for (const c of crimes as SwapCrime[]) {
    const m = model.get(c.name)
    if (!m) continue
    const s = seatSwap({
      crime: c, weights: new Map(m.roles.map((r) => [r.positionId, r.weight])),
      readings, online, names, nowSec, successOf: successFor(m), minGainPp, minWeightedGain,
    })
    if (s) swaps.push(s)
  }
  const swapResolvedKeys = new Set((await previous('swap')).filter((k) => swapResolved(k, crimes as SwapCrime[])))
  // ⚠️ `/oc feed` (#1024): a kind switched off produces nothing, and what it
  // had open closes as "Turned off" — not left hanging in the thread.
  const on = await feedKinds(db)
  const off = 'Turned off'
  const c = on.swap ? await reportSuggestions(db, 'swap', swaps, swapResolvedKeys)
    : await reportSuggestions(db, 'swap', [], new Set(), off)
  const a = on.too_low ? await reportSuggestions(db, 'too_low', tooLow.live, tooLow.resolved)
    : await reportSuggestions(db, 'too_low', [], new Set(), off)
  const b = on.idle ? await reportSuggestions(db, 'idle', idle.live, idle.resolved)
    : await reportSuggestions(db, 'idle', [], new Set(), off)
  return {
    rows: a.opened + b.opened + c.opened,
    details: {
      swap: { live: swaps.length, ...c },
      too_low: { live: tooLow.live.length, ...a },
      idle: { live: idle.live.length, ...b },
    },
  }
}
