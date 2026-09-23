// Pure row math for the Member Overview, extracted from the component so it can
// be unit-tested without rendering (#286). Turns a member's daily snapshots into
// a row of per-stat deltas / daily rates, then classifies that row against a
// threshold set into: confirmed failures (red), "inconclusive" — can't assess
// for lack of data (amber), or ok. Missing data is never a silent pass.

import { STAT_PATHS, getByPath } from './statPaths'

const DAY_MS = 86400_000

/** The UTC midnight an instant falls in, so a clock can be compared to a DATE. */
const utcMidnight = (ms) => Math.floor(ms / DAY_MS) * DAY_MS
export const ACTIVE_THRESHOLD_HOURS = 48   // last action older than this → inactive
export const PI_NAME = 'Private Island'    // the property we require

/**
 * How old the newest snapshot may be before the window stops describing now.
 *
 * ⚠️ A stated tunable, not a magic number. `member-stats` sweeps once a day, so
 * a snapshot from yesterday is normal and calling it stale would paint the whole
 * roster amber every morning before the job runs. Two days allows for that plus
 * one missed run; beyond it the figures describe a member who may already have
 * stopped playing (#764).
 */
export const MAX_SNAPSHOT_AGE_DAYS = 2

// snapshots are newest-first. Pick the oldest snapshot within `days` of now
// (the delta's far end). days == null ("All") → the very oldest snapshot.
export function pickOldestInWindow(snapshots, days) {
  if (!snapshots || snapshots.length === 0) return null
  if (snapshots.length === 1) return snapshots[0]
  if (days == null) return snapshots[snapshots.length - 1]
  const target = new Date()
  target.setDate(target.getDate() - days)
  const targetStr = target.toISOString().slice(0, 10)
  for (const s of snapshots) {
    if (s.snapshot_date <= targetStr) return s
  }
  return snapshots[snapshots.length - 1]
}

export function daysBetween(olderDate, newerDate) {
  // db-time-safe: callers pass snapshot_date, a DATE column ("2026-08-03").
  const a = new Date(olderDate)
  const b = new Date(newerDate)
  return Math.max(1, Math.round((b - a) / DAY_MS))
}

export function isInactive(unixTs, nowMs = Date.now()) {
  if (!unixTs) return false
  const ageHours = (nowMs / 1000 - unixTs) / 3600
  return ageHours > ACTIVE_THRESHOLD_HOURS
}

// Build one member's overview row: identity fields + per-stat _current/_delta/
// _perday + gym energy, plus data-coverage flags. `member` carries identity
// (member_id, member_name, tier, total_days_in_faction, streak_days); `snaps`
// are that member's snapshots newest-first; `windowDays` is the selected window
// (null = All).
export function buildMemberRow(member, snaps = [], windowDays, { nowMs = Date.now() } = {}) {
  const newest = snaps[0]
  const oldest = pickOldestInWindow(snaps, windowDays)
  const haveTwoSnaps = !!(newest && oldest && newest !== oldest)
  const daysCovered = haveTwoSnaps ? daysBetween(oldest.snapshot_date, newest.snapshot_date) : 0

  // ⚠️ The delta can reach PAST the window (#764). pickOldestInWindow returns
  // the first snapshot at or before the boundary, and with a scraper gap that
  // can be far older — so a column headed "30d" was showing 45 days of gain.
  // `daysCovered >= windowDays` was the completeness test, which meant
  // overshooting made a row look MORE complete, and a member could pass a
  // 30-day requirement on 45 days of activity.
  const windowOvershoot = haveTwoSnaps && windowDays != null && daysCovered > windowDays

  // ⚠️ And the near end is not anchored to today (#764). `newest` is whatever
  // snaps[0] happens to be, so a member whose key died ten days ago reported
  // "the 30 days ending 10 days ago" as the last 30 — the case that most looks
  // like somebody going quiet.
  const newestMs = newest
    // db-time-safe: snapshot_date is a DATE column ("2026-08-03"), not a
    // timestamptz — the bare "+00" offset from #140 cannot appear here.
    ? new Date(newest.snapshot_date).getTime()
    : null
  // ⚠️ Both ends snapped to UTC midnight before subtracting. `snapshot_date` is
  // a DATE, so it parses to 00:00Z, while `nowMs` is the actual clock — so a
  // raw subtraction mixes a date with an instant and carries the time of day as
  // a fraction of a day. `Math.round` then tipped it: the same snapshot read as
  // 10 days old before noon UTC and 11 after, which is a test that passes all
  // morning and fails all afternoon. Days between two DATES is what is meant.
  const staleDays = newestMs == null
    ? null
    : Math.max(0, Math.round((utcMidnight(nowMs) - newestMs) / DAY_MS))
  const dataStale = staleDays != null && staleDays > MAX_SNAPSHOT_AGE_DAYS

  const windowSound = windowDays == null
    ? haveTwoSnaps
    : haveTwoSnaps && daysCovered >= windowDays && !windowOvershoot
  const dataComplete = windowSound && !dataStale
  const dataPartial = !dataComplete && haveTwoSnaps
  const dataMissing = !haveTwoSnaps
  const noData = snaps.length === 0

  // ⚠️ Ordered by what the reader should DO about it, and each cause named
  // separately: "too short" means wait, "spans longer" means the scraper has a
  // gap, "stale" means this member is no longer being measured. Collapsing
  // them into one "partial" sends someone hunting the wrong fault.
  const reasons = []
  if (windowOvershoot) {
    reasons.push(`Spans ${daysCovered}d, not ${windowDays}d — no snapshot near the window edge.`)
  } else if (haveTwoSnaps && windowDays != null && daysCovered < windowDays) {
    reasons.push(`Only ${daysCovered}d of ${windowDays}d of data.`)
  }
  if (dataStale) reasons.push(`Newest snapshot is ${staleDays}d old — this is not the last ${windowDays ?? 'available'} days.`)

  const dataPartialReason = dataMissing
    ? (noData
        ? 'No snapshots yet — nothing to assess.'
        : 'Only one snapshot — need at least two days of data to compute a delta.')
    : reasons.length > 0
      ? reasons.join(' ')
      : null

  const row = {
    member_id: member.member_id,
    member_name: member.member_name,
    tier: member.tier,
    total_days_in_faction: member.total_days_in_faction ?? null,
    streak_days: member.streak_days ?? null,
    level: getByPath(newest?.profile, 'level'),
    last_action_timestamp: newest?.last_action_timestamp ?? getByPath(newest?.profile, 'last_action.timestamp'),
    is_donator: newest?.is_donator,
    donator_label: getByPath(newest?.profile, 'donator_status'),
    property_name: newest?.property_name,
    snapshot_count: snaps.length,
    window_days: windowDays ?? null,
    /**
     * ⚠️ The SPAN between the two endpoints, not a count of days observed. A
     * member with 2 snapshots 30 days apart and one with 30 daily snapshots
     * both read 30 here; `snapshot_count` is what tells them apart. Most stats
     * are cumulative counters, so endpoints are sufficient for the delta —
     * what the span cannot tell you is how confident to be (#764).
     */
    days_covered: daysCovered,
    window_overshoot: windowOvershoot,
    stale_days: staleDays,
    data_stale: dataStale,
    data_complete: dataComplete,
    data_partial: !dataComplete,
    data_missing: dataMissing,
    no_data: noData,
    data_partial_reason: dataPartialReason,
  }

  const newestPs = newest?.personalstats
  const oldestPs = oldest?.personalstats
  for (const def of STAT_PATHS) {
    let cur = getByPath(newestPs, def.path)
    let old = oldestPs ? getByPath(oldestPs, def.path) : null
    if (def.isSeconds) {
      if (cur != null) cur = cur / 3600
      if (old != null) old = old / 3600
    }
    const delta = (cur != null && old != null && haveTwoSnaps) ? cur - old : null
    const perDay = (delta != null && daysCovered > 0) ? delta / daysCovered : null
    row[def.key + '_current'] = cur
    row[def.key + '_delta'] = delta
    row[def.key + '_perday'] = perDay
  }

  const gymEnergyNew = newest?.gym_energy
  const gymEnergyOld = oldest?.gym_energy
  const gymDelta = (gymEnergyNew != null && gymEnergyOld != null && haveTwoSnaps)
    ? gymEnergyNew - gymEnergyOld : null
  row.gym_energy = gymEnergyNew
  row.gym_energy_delta = gymDelta
  row.gym_energy_perday = (gymDelta != null && daysCovered > 0) ? gymDelta / daysCovered : null

  return row
}

// Threshold keys that check a point-in-time value rather than a per-day rate
// (#287 tenure). Mapped to the row field holding that value.
const POINT_IN_TIME_THRESHOLDS = {
  days_in_faction: 'total_days_in_faction',
  streak: 'streak_days',
}

// The value a threshold is checked against. Gym and the tenure thresholds are
// their own row fields; every other stat is a per-day rate.
function thresholdValue(row, statKey) {
  if (statKey === 'gym_energy') return row.gym_energy_perday
  if (POINT_IN_TIME_THRESHOLDS[statKey]) return row[POINT_IN_TIME_THRESHOLDS[statKey]]
  return row[statKey + '_perday']
}

// Classify a built row against a threshold set (statKey → min, or null for no
// active set). Returns:
//   threshold_failures    Set of stats present-and-below-min (red), or null
//   threshold_inconclusive Set of thresholded stats with no computable value, or null
//   compliance_status     'flagged' (confirmed problem) | 'inconclusive' | 'ok'
// Precedence: any confirmed problem → flagged; else any missing-data assessment
// (thresholded stat without data, or a member with no snapshots at all) →
// inconclusive; else ok. Missing data is never counted as passing.
export function classifyRow(row, thresholds, { piName = PI_NAME, nowMs = Date.now() } = {}) {
  const failures = new Set()
  const inconclusive = new Set()

  // ⚠️ A rate measured over the wrong days is not a verdict (#764). Two ways a
  // window stops describing what it claims:
  //
  //   - it reached PAST the edge, so a "30d" rate is really a 45d one;
  //   - its newest end is stale, so it describes the member as they were ten
  //     days ago.
  //
  // The second is the dangerous direction: somebody who stopped playing still
  // carries their old rate, and this module's rule is that missing data is
  // never a silent pass. Both go to inconclusive — amber asks a human to look,
  // which is the correct response to "we cannot tell".
  const windowDoubtful = row.window_overshoot === true || row.data_stale === true

  if (thresholds) {
    for (const [statKey, min] of Object.entries(thresholds)) {
      if (min == null || !Number.isFinite(Number(min))) continue
      const value = thresholdValue(row, statKey)
      if (value == null) inconclusive.add(statKey)
      // ⚠️ Tenure thresholds are point-in-time, not rates — they do not depend
      // on the delta at all, so a doubtful window is no reason to stop
      // checking them.
      else if (windowDoubtful && !POINT_IN_TIME_THRESHOLDS[statKey]) inconclusive.add(statKey)
      else if (value < Number(min)) failures.add(statKey)
    }
  }

  const redFlag =
       isInactive(row.last_action_timestamp, nowMs)
    || row.is_donator === false
    || (row.property_name && row.property_name !== piName)
    || failures.size > 0

  const status = redFlag
    ? 'flagged'
    : (inconclusive.size > 0 || row.no_data) ? 'inconclusive' : 'ok'

  return {
    threshold_failures: failures.size > 0 ? failures : null,
    threshold_inconclusive: inconclusive.size > 0 ? inconclusive : null,
    compliance_status: status,
  }
}

// Roll classified rows into the compliance summary. `flagged` (confirmed
// problems) and `inconclusive` (can't assess) are separate buckets.
export function summarizeCompliance(rows, { piName = PI_NAME, nowMs = Date.now() } = {}) {
  let flagged = 0, inconclusive = 0, inactive = 0, nonDonator = 0, nonPI = 0, thresholdFail = 0
  for (const r of rows) {
    if (isInactive(r.last_action_timestamp, nowMs)) inactive++
    if (r.is_donator === false) nonDonator++
    if (r.property_name && r.property_name !== piName) nonPI++
    if (r.threshold_failures && r.threshold_failures.size > 0) thresholdFail++
    if (r.compliance_status === 'flagged') flagged++
    else if (r.compliance_status === 'inconclusive') inconclusive++
  }
  return { total: rows.length, flagged, inconclusive, inactive, nonDonator, nonPI, thresholdFail }
}
