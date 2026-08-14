/**
 * Faction calendar: one normalised event shape, one adapter per source (#395).
 *
 * MonChoon's own conclusion in the ticket, and the reason the calendar is built
 * this way round:
 *
 *   > A calendar people have to populate manually will be stale within a
 *   > fortnight; one that aggregates dates the system already holds is useful
 *   > from day one.
 *
 * So five of the seven sources here are pure derivations of tables we already
 * fill. Only two are typed in — Torn's own events (no API exists for them) and
 * real birthdays (Torn holds no DOB anywhere).
 *
 * ⚠️ **Four different time representations feed this file**, which is the whole
 * reason adapters exist rather than a single query:
 *
 *   | source          | on the wire                        |
 *   |-----------------|------------------------------------|
 *   | ranked wars     | epoch SECONDS (bigint)             |
 *   | competitions    | timestamptz text, bare '+00' offset|
 *   | calendar_events | timestamptz text, bare '+00' offset|
 *   | payout weeks    | DATE ('2026-08-10')                |
 *   | birthdays       | month + day integers, no year      |
 *   | anniversaries   | Torn profile signup, shape unknown |
 *
 * Every one is normalised HERE, once, and everything downstream sees a Date.
 * Anything from Postgres goes through `parseDbTime` — `new Date` on a bare
 * '+00' offset returns NaN silently, which has now caused six live bugs in this
 * codebase (#140, #330, #419) and is guarded by a build-failing scanner.
 */
import { parseDbTime } from './time'
import { rotationSegments, picksOn, deriveMagnitudes, percentagesFor } from './steadfastRotation'

/** Torn City Time is UTC. Every derived date in this file is built in UTC. */
const DAY_MS = 86_400_000

/**
 * Kinds exist for colour and filtering, and are deliberately coarser than
 * sources: a reader wants "war stuff" and "money stuff", not eight legend
 * entries.
 */
export const EVENT_KINDS = {
  war: { label: 'War', tone: 'red' },
  competition: { label: 'Competition', tone: 'purple' },
  payout: { label: 'Payout', tone: 'green' },
  torn: { label: 'Torn event', tone: 'blue' },
  faction: { label: 'Faction', tone: 'slate' },
  personal: { label: 'Personal', tone: 'pink' },
  steadfast: { label: 'Steadfast', tone: 'amber' },
}

/** A UTC calendar day key, 'YYYY-MM-DD' — the grid's cell address. */
export function dayKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * A UTC midnight Date for a y/m/d, clamping an impossible day into the month.
 *
 * ⚠️ Feb 29 is the reason this is a function. A yearly recurrence — a birthday,
 * Christmas Town, an anniversary — landing on the 29th has no date to occupy in
 * three years out of four, and `Date.UTC(2027, 1, 29)` silently rolls over to
 * March 1st. Someone's birthday quietly moving to a different month is worse
 * than showing it a day early, so it clamps to the 28th.
 */
export function utcDate(year, month1, day) {
  const lastDay = new Date(Date.UTC(year, month1, 0)).getUTCDate() // day 0 of next month
  return new Date(Date.UTC(year, month1 - 1, Math.min(day, lastDay)))
}

/** Epoch seconds → Date; null for absent or non-finite. */
function fromEpochSeconds(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000) // db-time-safe: epoch arithmetic, not a DB string
}

/**
 * A DATE column ('2026-08-10') → UTC midnight.
 *
 * `parseDbTime` handles it, but only because `new Date('2026-08-10')` happens
 * to parse date-only strings as UTC. Being explicit costs nothing and does not
 * depend on that.
 */
function fromDateOnly(value) {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  return m ? utcDate(Number(m[1]), Number(m[2]), Number(m[3])) : null
}

let nextSyntheticId = 0
const evt = (e) => ({ note: null, href: null, endsAt: null, ...e, id: e.id ?? `gen-${nextSyntheticId++}` })

/* ── Derived sources ─────────────────────────────────────────────────────── */

/** Ranked wars. Epoch seconds; `end_at` is null while a war is still running. */
export function fromWars(rows) {
  return (rows ?? []).flatMap((w) => {
    const startsAt = fromEpochSeconds(w.start_at)
    if (!startsAt) return []
    const opponent = w.opponent_name || (w.opponent_id ? `Faction #${w.opponent_id}` : 'unknown faction')
    const endsAt = fromEpochSeconds(w.end_at)
    return [evt({
      id: `war-${w.id}`,
      source: 'war',
      kind: 'war',
      title: `Ranked war vs ${opponent}`,
      startsAt,
      endsAt,
      // ⚠️ A null end means STILL RUNNING here, not "instant". Everywhere else
      // in this file a missing end is a point in time, and conflating the two
      // drops the war you are currently in from a window that starts after it
      // began — which is the one war anybody is looking for.
      open: !endsAt,
      href: '/rw',
    })]
  })
}

/**
 * Competitions. timestamptz, and a rolling competition has no window at all —
 * those are excluded rather than pinned to today, because a competition with no
 * boundaries is genuinely not a dated thing.
 */
export function fromCompetitions(rows) {
  return (rows ?? []).flatMap((c) => {
    const startsAt = parseDbTime(c.window_start)
    if (!startsAt) return []
    return [evt({
      id: `competition-${c.id}`,
      source: 'competition',
      kind: 'competition',
      title: c.name,
      startsAt,
      endsAt: parseDbTime(c.window_end),
      href: '/members/competitions',
    })]
  })
}

/**
 * OC payouts — **one marker on the day the money moves**, not a bar across the
 * week it covers.
 *
 * MonChoon: *"I dont like the way that OC Payout spans the entire week. Can we
 * just have a single flag on Monday's for OC Payout"*. He is right, and the
 * reason is not only visual: a seven-day bar says "this is happening all week",
 * when the only date anybody needs is the one they get paid.
 *
 * ⚠️ The date is derived as **`week_end + 1 day`**, not "the next Monday". The
 * week from 3–9 August pays on the 10th because the 10th is the day after it
 * closed. Hard-coding Monday would produce the same answer today and the wrong
 * answer the moment a faction runs a week that is not Mon–Sun.
 *
 * The link carries the week id so the payouts page can open that week's modal
 * directly — the same one you get by clicking the row in Payout History.
 */
export function fromPayoutWeeks(rows) {
  return (rows ?? []).flatMap((w) => {
    const close = fromDateOnly(w.week_end)
    if (!close) return []
    const paidOn = new Date(close.getTime() + DAY_MS) // db-time-safe
    return [evt({
      id: `payout-${w.id}`,
      source: 'payout_week',
      kind: 'payout',
      title: 'OC Payout',
      note: `for ${w.week_start} – ${w.week_end}`,
      startsAt: paidOn,
      allDay: true,
      href: `/oc/payouts?week=${w.id}`,
    })]
  })
}

/**
 * Ranked-war payouts — a marker on the war's **last day**, only where a payout
 * actually exists.
 *
 * ⚠️ Driven off the `war_payouts` join, never off the war alone. A "RW Payout"
 * flag on every war that has ended would be a link to nothing for any war
 * leadership has not paid out yet, and a dead link on a calendar is worse than
 * no link — people stop trusting the ones that work.
 */
export function fromWarPayouts(rows) {
  return (rows ?? []).flatMap((w) => {
    if (w.payout_id == null) return []
    const endsAt = fromEpochSeconds(w.end_at)
    if (!endsAt) return []
    const opponent = w.opponent_name || (w.opponent_id ? `Faction #${w.opponent_id}` : 'unknown faction')
    return [evt({
      id: `war-payout-${w.payout_id}`,
      source: 'war_payout',
      kind: 'payout',
      title: `RW Payout — ${opponent}`,
      startsAt: new Date(Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth(), endsAt.getUTCDate())), // db-time-safe
      allDay: true,
      href: `/rw/payouts?payout=${w.payout_id}`,
    })]
  })
}

/* ── Typed-in sources ────────────────────────────────────────────────────── */

/**
 * Manual entries and Torn's own events, expanding yearly recurrence across the
 * requested window.
 *
 * Recurrence carries real weight here: this is the only part of the calendar
 * with no automatic source behind it, so it is the only part exposed to the
 * staleness the ticket warns about. "Christmas Town, every December" survives
 * a year of nobody maintaining the list; a one-off row does not.
 */
export function fromEvents(rows, { from, to } = {}) {
  return (rows ?? []).flatMap((e) => {
    const base = parseDbTime(e.starts_at)
    if (!base) return []
    const baseEnd = parseDbTime(e.ends_at)
    const isTorn = e.source === 'torn_event'
    const make = (startsAt, endsAt, year) => evt({
      id: year == null ? `event-${e.id}` : `event-${e.id}-${year}`,
      source: isTorn ? 'torn_event' : 'manual',
      kind: isTorn ? 'torn' : 'faction',
      title: e.title,
      note: e.note ?? null,
      startsAt,
      endsAt,
      recurring: e.recurrence === 'yearly',
      // ⚠️ Only typed-in entries may be deleted. A war or a competition shown
      // here is a VIEW onto another table, and a delete control on it either
      // does nothing or deletes the war.
      editable: true,
      eventId: e.id,
    })

    if (e.recurrence !== 'yearly') return [make(base, baseEnd, null)]

    const spanMs = baseEnd ? baseEnd.getTime() - base.getTime() : null
    const years = yearsSpanning(from, to, base)
    return years.map((year) => {
      const shifted = shiftToYear(base, year)
      return make(shifted, spanMs == null ? null : new Date(shifted.getTime() + spanMs), year)
    })
  })
}

/**
 * Real birthdays, typed in. Month and day only unless someone chose to give a
 * year, so the date is constructed per displayed year.
 */
export function fromBirthdays(rows, { from, to } = {}) {
  return (rows ?? []).flatMap((b) => {
    const month = Number(b.birth_month)
    const day = Number(b.birth_day)
    if (!Number.isFinite(month) || !Number.isFinite(day)) return []
    return yearsSpanning(from, to, null).map((year) => evt({
      id: `birthday-${b.member_id}-${year}`,
      source: 'birthday',
      kind: 'personal',
      title: `${b.member_name || `Member ${b.member_id}`} — birthday`,
      // The year is optional and separate on purpose: a faction needs the date,
      // not someone's age. Only shown when they chose to give it.
      note: b.birth_year ? `Turning ${year - Number(b.birth_year)}` : null,
      startsAt: utcDate(year, month, day),
      allDay: true,
      recurring: true,
      memberId: b.member_id,
      href: `/members/overview`,
    }))
  })
}

/** The four battle stats, in the order Torn lists them. */
const STEADFAST_STATS = [
  ['strength', 'STR'],
  ['defense', 'DEF'],
  ['speed', 'SPD'],
  ['dexterity', 'DEX'],
]

/** "STR 20% · DEF 15% · SPD 10%" — omitting stats we could not read. */
export function steadfastLabel(row) {
  const parts = STEADFAST_STATS
    // ⚠️ `null` is "we could not read it" and is skipped; a real 0 is printed.
    // Number(null) is 0, so this must test for null explicitly.
    .filter(([key]) => row?.[`steadfast_${key}`] !== null && row?.[`steadfast_${key}`] !== undefined)
    .map(([key, short]) => `${short} ${Number(row[`steadfast_${key}`])}%`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Steadfast as **bands**, one per stretch of TNL's rotation.
 *
 * MonChoon: *"for things that span multiple days, maybe have the event band
 * stretch across instead of individual ones on each day."*
 *
 * ⚠️ Two different sources of truth meet here, and keeping them apart is the
 * whole design:
 *
 *   • **Which** stat is boosted comes from the ROTATION (`steadfastRotation`) —
 *     pure calendar arithmetic, so it predicts forward indefinitely. That is
 *     the point: people plan training around it, and a training book is five
 *     days of commitment.
 *   • **How much** comes from the observed `/faction/upgrades` snapshot,
 *     because it depends on what the faction has unlocked. MonChoon,
 *     2026-08-14: *"We dont have anything at 20% at the moment... it depends
 *     on what we have unlocked."*
 *
 * Deriving the magnitudes from the rotation instead would have been a hardcoded
 * 15/20 that started lying the day the tertiary tree was bought. Deriving the
 * schedule from the snapshots would have made future months blank — and future
 * months are the ones worth looking at.
 *
 * With no snapshot at all, the bands still show which stats are boosted and
 * simply do not claim a percentage.
 */
export function fromSteadfast(payload, { from, to } = {}) {
  if (!(from instanceof Date) || !(to instanceof Date)) return []
  // ⚠️ Opt-in per faction. The rotation is TNL's policy and this stack serves
  // several factions; a schedule that is not yours looks exactly like one that
  // is, which is the worst way for a calendar to be wrong.
  if (payload?.steadfast_rotation !== true) return []

  // The most recent snapshot, even from outside the window — viewing next
  // month, every snapshot is in the past, and that is exactly when the
  // magnitudes are still wanted.
  const latest = payload?.steadfast_latest ?? null
  const magnitudes = latest
    ? deriveMagnitudes(latest, picksOn(fromDateOnly(latest.snapshot_date) ?? from))
    : null

  return rotationSegments(from, to).map((seg) => {
    const pct = percentagesFor(seg, magnitudes)
    const known = STEADFAST_STATS.filter(([key]) => pct[key] !== null && pct[key] !== undefined)
    const label = known.length > 0
      ? known.map(([key, short]) => `${short} ${pct[key]}%`).join(' · ')
      // No snapshot yet: name the boosted stats without inventing figures.
      : `${seg.strSpd.toUpperCase().slice(0, 3)} + ${seg.defDex.toUpperCase().slice(0, 3)} boosted`

    return evt({
      id: `steadfast-${dayKey(seg.start)}`,
      source: 'steadfast',
      kind: 'steadfast',
      title: `Steadfast ${label}`,
      note: [
        `${seg.strSpd} and ${seg.defDex} carry the secondary trees`,
        magnitudes ? `percentages observed ${magnitudes.observedOn}` : 'percentages not yet scraped',
        magnitudes?.strSpd?.suspect || magnitudes?.defDex?.suspect
          ? '⚠ observed values do not fit the expected pattern — check the faction tree'
          : null,
      ].filter(Boolean).join(' · '),
      startsAt: seg.start,
      endsAt: seg.end,
      allDay: true,
      band: true,
    })
  })
}

/**
 * Torn account anniversaries — derived, not typed in, from the profile blob
 * already snapshotted daily.
 *
 * ⚠️ The signup field's shape is not pinned down. Torn v1 served
 * '2011-08-27 15:39:33'; v2 serves epoch seconds on most timestamps but this
 * one was never verified against a live response. Both are accepted rather
 * than guessing, because guessing wrong shows every member the same wrong date
 * and nothing about that failure looks like a failure.
 */
export function fromAnniversaries(rows, { from, to } = {}) {
  return (rows ?? []).flatMap((m) => {
    const signup = parseSignup(m.signup)
    if (!signup) return []
    return yearsSpanning(from, to, null).flatMap((year) => {
      // No anniversary before the account existed.
      if (year <= signup.getUTCFullYear()) return []
      return [evt({
        id: `anniversary-${m.member_id}-${year}`,
        source: 'anniversary',
        kind: 'personal',
        title: `${m.member_name || `Member ${m.member_id}`} — ${year - signup.getUTCFullYear()} years in Torn`,
        startsAt: utcDate(year, signup.getUTCMonth() + 1, signup.getUTCDate()),
        allDay: true,
        recurring: true,
        memberId: m.member_id,
        href: `/members/overview`,
      })]
    })
  })
}

/** Accepts epoch seconds, epoch milliseconds, or any timestamp string. */
export function parseSignup(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    // Torn launched in 2004, so anything below ~1e11 is seconds, not millis.
    const d = new Date(n < 1e11 ? n * 1000 : n) // db-time-safe: epoch arithmetic
    return Number.isNaN(d.getTime()) ? null : d
  }
  // 'YYYY-MM-DD HH:MM:SS' with no offset is UTC, which parseDbTime handles
  // once the space is a 'T'.
  return parseDbTime(String(value).replace(' ', 'T'))
}

/* ── Aggregation ─────────────────────────────────────────────────────────── */

/** Every UTC year touched by [from, to]; falls back to the base date's year. */
function yearsSpanning(from, to, base) {
  if (!(from instanceof Date) || !(to instanceof Date)) {
    return base ? [base.getUTCFullYear()] : [new Date().getUTCFullYear()] // db-time-safe
  }
  const years = []
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) years.push(y)
  return years
}

/** Same month/day/time as `base`, in `year` — Feb 29 clamped, not rolled over. */
function shiftToYear(base, year) {
  const day = utcDate(year, base.getUTCMonth() + 1, base.getUTCDate())
  return new Date(day.getTime()
    + base.getUTCHours() * 3_600_000
    + base.getUTCMinutes() * 60_000) // db-time-safe: epoch arithmetic
}

/**
 * When an event stops occupying the calendar. An open-ended event — a war with
 * no recorded end — has not stopped, and must not be treated as instantaneous.
 */
function effectiveEnd(e) {
  if (e.endsAt) return e.endsAt
  return e.open ? new Date(8.64e15) : e.startsAt // db-time-safe: max Date
}

/**
 * All sources into one sorted list, clipped to the window.
 *
 * An event is kept when it OVERLAPS the window, not when it starts inside it —
 * otherwise a war that began last month vanishes from this month's grid while
 * it is still being fought, which is the one time anybody looks.
 */
export function aggregate(payload, { from, to } = {}) {
  const window = from instanceof Date && to instanceof Date ? { from, to } : {}
  const all = [
    ...fromWars(payload?.wars),
    ...fromWarPayouts(payload?.wars),
    ...fromCompetitions(payload?.competitions),
    ...fromPayoutWeeks(payload?.payout_weeks),
    ...fromEvents(payload?.events, window),
    ...fromBirthdays(payload?.birthdays, window),
    ...fromAnniversaries(payload?.anniversaries, window),
    ...fromSteadfast(payload, window),
  ]

  const clipped = window.from
    ? all.filter((e) => effectiveEnd(e) >= window.from && e.startsAt <= window.to)
    : all

  return clipped.sort((a, b) => a.startsAt - b.startsAt || String(a.title).localeCompare(String(b.title)))
}

/**
 * Events indexed by every UTC day they cover, so a multi-day war appears in
 * each of its cells rather than only the first.
 */
export function byDay(events, { maxSpanDays = 90, openUntil = new Date() } = {}) {
  const map = new Map()
  for (const e of events ?? []) {
    const start = e.startsAt
    if (!start) continue
    // An open-ended war fills its cells up to today and no further — it has not
    // finished, but it has not happened tomorrow either.
    const candidate = e.endsAt ?? (e.open ? openUntil : start)
    const end = candidate > start ? candidate : start
    // A cap, because an unbounded loop over a bad date is how a calendar
    // becomes an infinite loop rather than a wrong pixel.
    const days = Math.min(Math.floor((end - start) / DAY_MS), maxSpanDays)
    for (let i = 0; i <= days; i++) {
      const key = dayKey(new Date(start.getTime() + i * DAY_MS)) // db-time-safe
      if (!key) continue
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(e)
    }
  }
  return map
}

/**
 * The dashboard card's contents: what is happening soon.
 *
 * Includes events already running — "the war you are in" is upcoming
 * information in every sense that matters to someone opening the dashboard.
 */
export function upcoming(events, { now = new Date(), days = 7, limit = 5 } = {}) {
  const horizon = new Date(now.getTime() + days * DAY_MS) // db-time-safe
  return (events ?? [])
    .filter((e) => effectiveEnd(e) >= now && e.startsAt <= horizon)
    .sort((a, b) => a.startsAt - b.startsAt)
    .slice(0, limit)
}

/**
 * Lay one week row out: continuous bands for anything spanning days, ordinary
 * pills for anything that does not.
 *
 * MonChoon: *"for things that span multiple days, maybe have the event band
 * stretch across instead of individual ones on each day."*
 *
 * ⚠️ The repeated-pill rendering was not just untidy, it MISCOUNTED. A war
 * showing in five cells reads as five things; the "+2 more" overflow in each
 * cell was counting the same war five times, and a genuinely busy day could
 * hide a one-off behind four repeats of the same war. A band says one thing
 * once and leaves the cells for what actually happens on them.
 *
 * `continuesLeft` / `continuesRight` mark a band clipped by the week boundary,
 * so the UI can flatten that edge instead of drawing a rounded end where the
 * event does not actually stop.
 */
export function layoutWeek(cells, events) {
  const keys = cells.map((c) => c.key)
  const first = cells[0].date
  const last = cells[6].date

  const bands = []
  const singles = new Map(keys.map((k) => [k, []]))

  for (const e of events ?? []) {
    if (!e?.startsAt) continue
    const end = effectiveEnd(e)
    const startDay = dayKey(e.startsAt)
    const endDay = dayKey(end)
    const multiDay = e.band === true || (endDay !== null && endDay !== startDay)

    if (!multiDay) {
      if (singles.has(startDay)) singles.get(startDay).push(e)
      continue
    }

    // Clip to this week; skip an event that does not reach it at all.
    if (end < first || e.startsAt > new Date(last.getTime() + DAY_MS - 1)) continue
    const startCol = Math.max(0, keys.indexOf(startDay) === -1 ? 0 : keys.indexOf(startDay))
    const endIdx = keys.indexOf(endDay)
    const endCol = endIdx === -1 ? 6 : endIdx
    bands.push({
      event: e,
      startCol,
      endCol: Math.max(startCol, endCol),
      continuesLeft: e.startsAt < first,
      continuesRight: end > new Date(last.getTime() + DAY_MS - 1),
    })
  }

  // Greedy lane packing: the first lane with room. Stable because `events` is
  // already sorted, so a band does not hop rows as the month is re-rendered.
  const laneEnds = []
  for (const band of bands.sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol)) {
    let lane = laneEnds.findIndex((e) => e < band.startCol)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(-1) }
    laneEnds[lane] = band.endCol
    band.lane = lane
  }

  return { bands, singles, lanes: laneEnds.length }
}

/** The six-week UTC grid containing `month`, Monday-first. */
export function monthGrid(month) {
  const year = month.getUTCFullYear()
  const m = month.getUTCMonth()
  const first = new Date(Date.UTC(year, m, 1))
  // getUTCDay is Sunday-0; shift so Monday is column 0.
  const lead = (first.getUTCDay() + 6) % 7
  const start = new Date(first.getTime() - lead * DAY_MS) // db-time-safe
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getTime() + i * DAY_MS) // db-time-safe
    return { date, key: dayKey(date), inMonth: date.getUTCMonth() === m }
  })
}
