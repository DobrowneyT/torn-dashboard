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
import { reportSuggestions } from '../../ocSuggestions.js'
import {
  joinedTooLow, notInAnyOc, TOO_LOW_WINDOW_HOURS_DEFAULT, IDLE_GRACE_MINUTES_DEFAULT,
  type Crime, type Readings,
} from '../../ocSuggestionProducers.js'

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
  const names = new Map<string, string>(current.map((r: any) => [String(r.member_id), r.member_name]))
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
    graceMinutes: await numberSetting(db, 'oc_idle_grace_minutes', IDLE_GRACE_MINUTES_DEFAULT),
    previousKeys: await previous('idle'),
  })

  const a = await reportSuggestions(db, 'too_low', tooLow.live, tooLow.resolved)
  const b = await reportSuggestions(db, 'idle', idle.live, idle.resolved)
  return {
    rows: a.opened + b.opened,
    details: { too_low: { live: tooLow.live.length, ...a }, idle: { live: idle.live.length, ...b } },
  }
}
