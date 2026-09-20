// The schedule model behind Global Admin's Scraper Jobs editor (#756).
//
// A cron expression goes in, a *sentence* comes out — "every day", "at minutes
// 5 and 35" — which is what the editor's controls bind to. Then the sentence
// goes back out as cron. Nothing else in the app should be parsing these.
//
// ⚠️ **Six fields, always.** node-cron reads a leading SECONDS field when it is
// given six, and standard cron has five. So `*/5 * * * *` is every five minutes
// while `*/5 * * * * *` is every five SECONDS — a 12× jump in Torn API traffic
// against a shared key pool, from one extra asterisk, with nothing to reject it
// because both are valid. Everything that leaves `buildCron` has six fields, so
// the ambiguity cannot be typed in the first place.
//
// ⚠️ **Refusing to parse is a feature.** The sentence cannot say "the 1st of
// the month" or "9-17". Rather than rounding such a schedule off to something
// it *can* say — silently changing a cadence somebody chose — `parseCron`
// returns null and the caller falls back to a raw text box. An editor that
// quietly rewrites a cadence is worse than the text box it replaces: the text
// box at least fails loudly.

/** Periods the sentence can express, in the order the dropdown lists them. */
export const PERIODS = ['minute', 'nminutes', 'hour', 'nhours', 'day', 'week']

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n) => String(n).padStart(2, '0')

/**
 * Expand one field into the values it matches — `*`, lists and `*​/n` steps only.
 *
 * Returns null for anything else, including ranges. A range is perfectly valid
 * cron and we simply have no control for it; see the refusal note above.
 */
function expand(spec, min, max) {
  if (typeof spec !== 'string' || spec === '') return null
  if (spec === '*') return { star: true, values: null, step: null }
  const stepMatch = /^\*\/(\d+)$/.exec(spec)
  if (stepMatch) {
    const step = Number(stepMatch[1])
    if (!Number.isInteger(step) || step < 1 || step > max) return null
    return { star: false, values: null, step }
  }
  if (!/^\d+(,\d+)*$/.test(spec)) return null
  const values = [...new Set(spec.split(',').map(Number))].sort((a, b) => a - b)
  if (values.some((v) => !Number.isInteger(v) || v < min || v > max)) return null
  return { star: false, values, step: null }
}

/** A sorted, de-duplicated list, or a fallback when the caller gave us nothing. */
function clean(list, fallback) {
  const v = Array.isArray(list) ? [...new Set(list.map(Number))].filter(Number.isInteger).sort((a, b) => a - b) : []
  return v.length > 0 ? v : fallback
}

/**
 * Cron → sentence. Accepts five fields (read as seconds-zero, since the column
 * may already hold one) or six. Returns null for anything unmodellable.
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return null
  const f = expr.trim().split(/\s+/).filter(Boolean)
  if (f.length !== 5 && f.length !== 6) return null
  const [secSpec, minSpec, hourSpec, domSpec, monSpec, dowSpec] =
    f.length === 6 ? f : ['0', ...f]

  const sec = expand(secSpec, 0, 59)
  const min = expand(minSpec, 0, 59)
  const hour = expand(hourSpec, 0, 23)
  const dom = expand(domSpec, 1, 31)
  const mon = expand(monSpec, 1, 12)
  const dow = expand(dowSpec, 0, 6)
  if (!sec || !min || !hour || !dom || !mon || !dow) return null

  // The sentence has no controls for these, so a constraint on either means the
  // expression belongs in a text box, not in this editor.
  if (!dom.star || !mon.star) return null
  // Seconds is a chip row: a step there is a sub-minute cadence we deliberately
  // do not offer a one-click path to.
  if (sec.step !== null) return null

  const secs = sec.star ? null : sec.values
  if (secs === null) return null // `* * * * * *` — every second; never offered.

  const base = { secs, mins: [0], hours: [0], dows: [1], n: 5 }

  if (!dow.star) {
    if (dow.step !== null || min.star || min.step !== null || hour.star || hour.step !== null) return null
    return { ...base, period: 'week', mins: min.values, hours: hour.values, dows: dow.values }
  }
  if (min.star && hour.star) return { ...base, period: 'minute' }
  if (min.step !== null && hour.star) return { ...base, period: 'nminutes', n: min.step }
  if (min.star || min.values === null) return null
  if (hour.star) return { ...base, period: 'hour', mins: min.values }
  if (hour.step !== null) return { ...base, period: 'nhours', n: hour.step, mins: min.values }
  return { ...base, period: 'day', mins: min.values, hours: hour.values }
}

/** Sentence → cron. Always six fields. */
export function buildCron(state) {
  if (!state || typeof state !== 'object') return '0 0 * * * *'
  const secs = clean(state.secs, [0]).join(',')
  const mins = clean(state.mins, [0]).join(',')
  const hours = clean(state.hours, [0]).join(',')
  const dows = clean(state.dows, [1]).join(',')
  const n = Number.isInteger(state.n) && state.n > 0 ? state.n : 5

  switch (state.period) {
    case 'minute':   return `${secs} * * * * *`
    case 'nminutes': return `${secs} */${n} * * * *`
    case 'hour':     return `${secs} ${mins} * * * *`
    case 'nhours':   return `${secs} ${mins} */${n} * * *`
    case 'week':     return `${secs} ${mins} ${hours} * * ${dows}`
    case 'day':      return `${secs} ${mins} ${hours} * * *`
    default:         return '0 0 * * * *'
  }
}

/** "05 and 35" — an Oxford-comma-free list, because these are short. */
function listOf(values, fmt = pad) {
  const v = values.map(fmt)
  if (v.length === 1) return v[0]
  return `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`
}

/**
 * ":05 and :35" — the colon on EVERY entry, not just the first.
 *
 * "at :05 and 35" reads as a single time whose minutes ran together; the
 * repeated colon is what makes two separate marks on the clock.
 */
const colonList = (values) => listOf(values, (v) => `:${pad(v)}`)

const COUNT_WORD = ['', '', 'Twice', 'Three times', 'Four times', 'Five times', 'Six times']

/**
 * Cron → English, for the cell at rest.
 *
 * Hands an unmodellable expression straight back rather than describing it
 * wrongly: a reader seeing raw cron knows to open the text box, where a
 * confident-but-wrong sentence would send them away satisfied.
 */
export function describeCron(expr) {
  const s = parseCron(expr)
  if (!s) return typeof expr === 'string' ? expr.trim() : ''

  const offset = !(s.secs.length === 1 && s.secs[0] === 0)
  const secPart = offset ? `, at ${colonList(s.secs)} seconds` : ''

  switch (s.period) {
    case 'minute':
      // Several seconds in the same minute is not an offset, it is a faster
      // cadence — and saying "every minute" would understate an API bill the
      // reader is about to multiply.
      if (s.secs.length > 1) {
        const word = COUNT_WORD[s.secs.length] || `${s.secs.length} times`
        return `${word} a minute, at ${colonList(s.secs)} seconds`
      }
      return `Every minute${secPart}`
    case 'nminutes':
      return `Every ${s.n} minutes${secPart}`
    case 'hour':
      return s.mins.length === 1 && s.mins[0] === 0
        ? `Hourly, on the hour${secPart}`
        : `Hourly at ${colonList(s.mins)}${secPart}`
    case 'nhours':
      return `Every ${s.n} hours, at ${colonList(s.mins)}${secPart}`
    case 'week':
      return `Weekly on ${listOf(s.dows, (d) => DAY_NAMES[d])} at ${pad(s.hours[0])}:${pad(s.mins[0])}${secPart}`
    default: {
      const times = []
      for (const h of s.hours) for (const m of s.mins) times.push(`${pad(h)}:${pad(m)}`)
      if (times.length === 1) return `Daily at ${times[0]}${secPart}`
      const word = COUNT_WORD[times.length] || `${times.length} times`
      return `${word} daily at ${listOf(times, (t) => t)}${secPart}`
    }
  }
}

/**
 * The next `count` fire times, as Dates.
 *
 * UTC throughout, which is TCT — the server schedules in the container's clock
 * and every time in the app is already Torn City Time.
 */
export function nextRuns(expr, count = 4, from = new Date()) {
  const s = parseCron(expr)
  if (!s || count < 1) return []
  const f = buildCron(s).split(' ')
  const sec = expand(f[0], 0, 59)
  const min = expand(f[1], 0, 59)
  const hour = expand(f[2], 0, 23)
  const dow = expand(f[5], 0, 6)

  const matches = (value, field, max) => {
    if (field.star) return true
    if (field.step !== null) return value % field.step === 0
    return field.values.includes(value)
  }

  const secs = sec.values ?? [0]
  const cursor = new Date(from.getTime())
  cursor.setUTCSeconds(0, 0)

  const out = []
  // A whole week of minutes is the widest gap any sentence can produce.
  for (let i = 0; i < 60 * 24 * 8 && out.length < count; i += 1) {
    if (matches(cursor.getUTCMinutes(), min) &&
        matches(cursor.getUTCHours(), hour) &&
        matches(cursor.getUTCDay(), dow)) {
      for (const s2 of secs) {
        if (out.length >= count) break
        const hit = new Date(cursor.getTime())
        hit.setUTCSeconds(s2)
        if (hit > from) out.push(hit)
      }
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return out
}

/**
 * How crowded each minute of the hour already is (#756).
 *
 * This is the thing an admin is actually choosing against when they pick an
 * offset — `revives-sync` sits on :05/:35 to stay clear of the hourly jobs, and
 * `crime-occupancy` uses the seconds field for the same reason.
 *
 * ⚠️ Every-minute jobs are counted SEPARATELY. One of them occupies all sixty
 * and would flatten the chart, hiding exactly the quiet minutes it exists to
 * reveal.
 */
export function minuteLoad(expressions = []) {
  const counts = new Array(60).fill(0)
  let everyMinute = 0

  for (const expr of expressions) {
    const s = parseCron(expr)
    if (!s) continue
    if (s.period === 'minute') { everyMinute += 1; continue }
    if (s.period === 'nminutes') {
      for (let m = 0; m < 60; m += s.n) counts[m] += 1
      continue
    }
    for (const m of s.mins) counts[m] += 1
  }

  const busiest = Math.max(0, ...counts)
  return { counts, everyMinute, busiest, busiestMinute: counts.indexOf(busiest) }
}
