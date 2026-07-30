// Pure row math for the Member Overview, extracted from the component so it can
// be unit-tested without rendering (#286). Turns a member's daily snapshots into
// a row of per-stat deltas / daily rates, then classifies that row against a
// threshold set into: confirmed failures (red), "inconclusive" — can't assess
// for lack of data (amber), or ok. Missing data is never a silent pass.

import { STAT_PATHS, getByPath } from './statPaths'

const DAY_MS = 86400_000
export const ACTIVE_THRESHOLD_HOURS = 48   // last action older than this → inactive
export const PI_NAME = 'Private Island'    // the property we require

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
export function buildMemberRow(member, snaps = [], windowDays) {
  const newest = snaps[0]
  const oldest = pickOldestInWindow(snaps, windowDays)
  const haveTwoSnaps = !!(newest && oldest && newest !== oldest)
  const daysCovered = haveTwoSnaps ? daysBetween(oldest.snapshot_date, newest.snapshot_date) : 0

  const dataComplete = windowDays == null ? haveTwoSnaps : daysCovered >= windowDays
  const dataPartial = !dataComplete && haveTwoSnaps
  const dataMissing = !haveTwoSnaps
  const noData = snaps.length === 0
  const dataPartialReason = dataMissing
    ? (noData
        ? 'No snapshots yet — nothing to assess.'
        : 'Only one snapshot — need at least two days of data to compute a delta.')
    : dataPartial
      ? `Only ${daysCovered}d of ${windowDays}d of data.`
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
    days_covered: daysCovered,
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

// The per-day value a threshold is checked against (gym is its own column).
function thresholdValue(row, statKey) {
  return statKey === 'gym_energy' ? row.gym_energy_perday : row[statKey + '_perday']
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
  if (thresholds) {
    for (const [statKey, min] of Object.entries(thresholds)) {
      if (min == null || !Number.isFinite(Number(min))) continue
      const value = thresholdValue(row, statKey)
      if (value == null) inconclusive.add(statKey)
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
