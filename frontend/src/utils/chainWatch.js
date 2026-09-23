/**
 * Chain Watch derivations (#772).
 *
 * ⚠️ These live here rather than inline in the view on purpose. "Which hours
 * have elapsed", "where is the next gap" and "what does the six-hour warning
 * say" are the shape of `memberMetrics.js` and `eventWindows.js`, not JSX —
 * and the throwaway prototype for this page shipped with a bug
 * (`rows.filter(isPast)`, where `filter` hands the callback
 * `(element, index, array)` and the helper got a row where it expected an hour)
 * that a unit test would have caught on its first assertion while a visual
 * check did not catch at all.
 *
 * ⚠️ Everything is in **TCT, which is UTC**. Torn speaks TCT and leadership
 * says TCT out loud, so it is the canonical column. The viewer's own local time
 * sits beside it and is formatted **per row, from that row's own instant** —
 * never by adding a fixed offset. The spreadsheet this replaces typed three
 * zone rows by hand and the 2025 event crossed the US DST change; the damage is
 * still in the file, where rows 100-101 list `2:00-3:00` twice. A DST fold
 * showing two rows with the same local clock time is CORRECT and must not be
 * "fixed".
 */
import { parseDbTime } from './time'

const HOUR_MS = 3600_000

/** How far ahead the standing gap warning looks. Shared with #775's ping. */
export const GAP_HORIZON_HOURS = 6

/**
 * How far ahead the coverage headline counts.
 *
 * ⚠️ Scoped, not "the whole event". A freshly added day is 24 hours of nothing,
 * so an unbounded count leaps the instant somebody clicks *Add a day* — which
 * reads as the roster collapsing when in fact the window grew. Two days answers
 * "what do I need to fill now".
 */
export const COVERAGE_HORIZON_HOURS = 48

/** Zero-padded TCT clock for an instant. TCT is UTC, so this reads UTC. */
export function tctLabel(ms) {
  const d = new Date(ms) // db-time-safe: an epoch number, never a DB string.
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** The TCT calendar day an instant falls in, as `YYYY-MM-DD`. */
export function tctDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10) // db-time-safe: epoch number.
}

/** The viewer's IANA zone, or null when the browser will not say. */
export function viewerZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/**
 * The viewer's own clock for an instant.
 *
 * ⚠️ Formatted from the instant every time. Two rows either side of a DST fold
 * legitimately produce the same label, and that is the truth of the day rather
 * than a bug to paper over.
 */
export function localLabel(ms, zone = viewerZone()) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit', minute: '2-digit', hour12: false,
      ...(zone ? { timeZone: zone } : {}),
    }).format(new Date(ms)) // db-time-safe: epoch number.
  } catch {
    return tctLabel(ms)
  }
}

/** Short zone name for the column heading ("Winnipeg", "London"). */
export function zoneLabel(zone = viewerZone()) {
  if (!zone) return 'local'
  return zone.split('/').pop().replace(/_/g, ' ')
}

/**
 * Every hour of the event's PLANNED window, with its slots filled in.
 *
 * ⚠️ Built from `ends_at`, not `actually_ended_at`. The grid is deliberately
 * drawn past the expected end — nobody knows how long a 100k chain runs — and
 * an hour that turned out not to happen still has to be visible, or a member
 * cannot see why they were not paid for it (#773).
 *
 * ⚠️ Stepping by one hour of milliseconds is right precisely BECAUSE TCT is
 * UTC: every TCT hour is 3600 seconds, DST or not. The local column absorbs the
 * fold, not the grid.
 */
export function hourRows(event, signups = [], nowMs = Date.now()) {
  const start = parseDbTime(event?.starts_at)
  const end = parseDbTime(event?.ends_at)
  if (!start || !end || end <= start) return []

  const perHour = Math.max(1, Number(event.slots_per_hour) || 1)
  const bonusHours = new Set((event.bonus_hours ?? []).map(Number))

  // Index sign-ups by hour so the grid is one pass, not a scan per cell.
  const byHour = new Map()
  for (const s of signups) {
    const at = parseDbTime(s.hour_start)
    if (!at) continue
    const key = at.getTime()
    if (!byHour.has(key)) byHour.set(key, [])
    byHour.get(key).push(s)
  }

  const rows = []
  for (let ms = start.getTime(); ms < end.getTime(); ms += HOUR_MS) {
    const here = byHour.get(ms) ?? []
    const slots = Array.from({ length: perHour }, (_, i) =>
      here.find((s) => Number(s.slot_index) === i) ?? null)
    rows.push({
      ms,
      hourIso: new Date(ms).toISOString(), // db-time-safe: epoch number.
      tct: tctLabel(ms),
      dayKey: tctDayKey(ms),
      slots,
      openSlots: slots.filter((s) => !s).length,
      isBonus: bonusHours.has(new Date(ms).getUTCHours()), // db-time-safe: epoch.
      isPast: ms + HOUR_MS <= nowMs,
      isNow: ms <= nowMs && nowMs < ms + HOUR_MS,
    })
  }
  return rows
}

/** Rows grouped under their TCT day, in order. Days are SHORT at both ends. */
export function groupByTctDay(rows) {
  const out = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last && last.dayKey === row.dayKey) last.rows.push(row)
    else out.push({ dayKey: row.dayKey, rows: [row] })
  }
  return out
}

/**
 * Slots with nobody in them inside the next six hours.
 *
 * ⚠️ Counts SLOTS, not hours. An hour holding one of two watchers is one
 * unfilled slot — not zero, and not two. One severity, deliberately: a missing
 * watcher is a missing watcher (MonChoon, 2026-09-22). On 2025's numbers that
 * lights the alert often, and that is the intended behaviour, not a bug to
 * quieten.
 */
export function gapsAhead(rows, nowMs, horizonHours = GAP_HORIZON_HOURS) {
  // ⚠️ Anchored to the top of the CURRENT hour, not to the instant. "The next
  // six hours" has to mean six whole TCT hours, or the horizon slides through
  // the day and a page opened at :05 reports a different set from the same page
  // opened at :55 — and the Discord ping (#775) sharing this definition would
  // disagree with the screen.
  const until = Math.floor(nowMs / HOUR_MS) * HOUR_MS + horizonHours * HOUR_MS
  return rows
    .filter((r) => !r.isPast && r.ms < until && r.openSlots > 0)
    .map((r) => ({ ms: r.ms, tct: r.tct, hourIso: r.hourIso, open: r.openSlots, slots: r.slots.length }))
}

/**
 * The warning sentence.
 *
 * ⚠️ One severity does not mean one message. The text still marks the hours
 * that are completely naked, so a leader reading it knows instantly which one
 * to fix first — they simply do not get two colours of alarm.
 */
export function gapSentence(gaps, horizonHours = GAP_HORIZON_HOURS) {
  const slots = gaps.reduce((n, g) => n + g.open, 0)
  if (slots === 0) return null
  const list = gaps.map((g) => `${g.tct}${g.open === g.slots ? ' (both)' : ''}`).join(', ')
  return `${slots} slot${slots === 1 ? '' : 's'} unfilled in the next ${horizonHours} hours — ${list} TCT.`
}

/**
 * What the header says about coverage.
 *
 * ⚠️ Leads with the NEXT unstaffed hour rather than a total. Adding a day must
 * not make the headline look worse: empty grid appended after the next gap
 * changes nothing about what needs filling now.
 */
export function coverage(rows, nowMs, horizonHours = COVERAGE_HORIZON_HOURS) {
  const ahead = rows.filter((r) => !r.isPast)
  const nextGap = ahead.find((r) => r.openSlots > 0) ?? null
  const until = Math.floor(nowMs / HOUR_MS) * HOUR_MS + horizonHours * HOUR_MS
  const openInHorizon = ahead
    .filter((r) => r.ms < until)
    .reduce((n, r) => n + r.openSlots, 0)
  return {
    nextGap,
    openInHorizon,
    horizonHours,
    elapsedHours: rows.length - ahead.length,
    totalHours: rows.length,
  }
}

/**
 * Members a leader may put in this slot.
 *
 * ⚠️ Whoever already holds the OTHER slot of the hour stays in the list, marked
 * `disabledReason`, rather than being dropped from it: a leader hunting for a
 * name that is simply missing concludes the picker is broken. The database
 * refuses the pairing anyway (#771) — two watchers exist so that one of them
 * can fail, and the same person twice is that redundancy gone while the grid
 * still reads as covered.
 */
export function pickerOptions(roster, row, slotIndex) {
  const elsewhere = new Set(
    (row?.slots ?? [])
      .filter((s, i) => s && i !== slotIndex)
      .map((s) => String(s.member_id)),
  )
  return (roster ?? []).map((m) => ({
    member_id: String(m.member_id),
    member_name: m.member_name,
    disabledReason: elsewhere.has(String(m.member_id)) ? 'already watching this hour' : null,
  }))
}

/** What the bonus marker says, from the event rather than a hardcoded string. */
export function bonusLabel(event) {
  const x = Number(event?.bonus_multiplier) || 2
  const what = event?.bonus_applies_to ?? 'tickets'
  if (what === 'payout') return `pays ${x}× money`
  if (what === 'both') return `pays ${x}× money and tickets`
  return `pays ${x}× raffle tickets`
}
