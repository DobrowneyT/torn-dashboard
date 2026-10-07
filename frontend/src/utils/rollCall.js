// Pure helpers for the War Room roll call + war summary. Kept side-effect-free
// so they're unit-testable (see src/utils/__tests__/rollCall.test.js).

// Members get 1 hour before war start before the roll-call gate auto-releases —
// by then strategy is locked and the survey is moot.
export const ROLL_CALL_LEAD_TIME_SEC = 3600

export const AVAILABILITY_OPTIONS = [
  { value: '1_2h',        label: '1–2 Hours Late' },
  { value: '3_5h',        label: '3–5 Hours Late' },
  { value: '6_plus',      label: '6+ Hours Late' },
  { value: 'unavailable', label: 'Will not be available at all' },
]

export function availabilityLabel(v) {
  if (v === 'on_time') return 'On time'
  return AVAILABILITY_OPTIONS.find(o => o.value === v)?.label ?? '—'
}

/**
 * A member's roll-call answer, as one short token for a narrow column (#793).
 *
 * ⚠️ Seven states, not six. A member can answer "not on at start" and never
 * pick how late — `RollCallOverlay` submits `availability || null` — so
 * `late` is a real answer and must not render as `na`. They DID respond, and
 * a lead chasing non-responders would chase them for nothing.
 *
 * ⚠️ Ordered most-available first, so ascending puts the people you can count
 * on at the top. `na` is deliberately last in the list but is NOT ranked with
 * the others — see `rollCallRank`.
 */
export const ROLL_CALL_STATES = [
  { key: 'here',        short: 'Here',        full: 'On at the start' },
  { key: '1_2h',        short: '1-2',         full: '1–2 hours late' },
  { key: '3_5h',        short: '3-5',         full: '3–5 hours late' },
  { key: '6_plus',      short: '6+',          full: '6+ hours late' },
  { key: 'late',        short: 'Late',        full: 'Late — did not say how long' },
  { key: 'unavailable', short: 'Unavailable', full: 'Will not be available at all' },
  { key: 'na',          short: 'N/A',         full: 'No roll-call response' },
]

const BY_KEY = new Map(ROLL_CALL_STATES.map(s => [s.key, s]))

/** Which of the seven states a roll-call row represents. Null row → 'na'. */
export function rollCallState(row) {
  if (!row) return 'na'
  if (row.on_at_start === true) return 'here'
  const a = row.availability
  if (a === '1_2h' || a === '3_5h' || a === '6_plus' || a === 'unavailable') return a
  // ⚠️ Responded, not on at start, no duration given. Distinct from 'na'.
  return 'late'
}

/** The short token for the column, e.g. `3-5`. */
export function rollCallLabel(row) {
  return BY_KEY.get(rollCallState(row))?.short ?? 'N/A'
}

/** The full wording, for a tooltip — `1-2` means nothing on its own. */
export function rollCallTitle(row) {
  return BY_KEY.get(rollCallState(row))?.full ?? 'No roll-call response'
}

/**
 * Sortable rank — lower is more available.
 *
 * ⚠️ Returns `null` for a member who never responded. That is not "the worst
 * availability", it is unknown, and parking it at either end of the order
 * asserts something untrue about those members. Callers sink nulls in BOTH
 * directions, the rule `ff` and the member-stat columns already follow.
 */
export function rollCallRank(row) {
  const key = rollCallState(row)
  if (key === 'na') return null
  const i = ROLL_CALL_STATES.findIndex(s => s.key === key)
  return i === -1 ? null : i
}

/**
 * Comparator shared by the roster column and the results table (#793).
 *
 * ⚠️ One ordering, used twice. Two orderings of the same seven states will
 * drift, and the one that drifts is the one nobody is looking at.
 */
export function compareRollCall(a, b, dir = 1) {
  const ar = rollCallRank(a)
  const br = rollCallRank(b)
  if (ar === null && br === null) return 0
  if (ar === null) return 1
  if (br === null) return -1
  return dir * (ar - br)
}

// Tally roll-call responses by whether the member will be on at the war start,
// so leadership can see at a glance how many are confirmed online. `total` is
// the count of definite yes/no answers.
export function rollCallTally(rows = []) {
  let yes = 0
  let no = 0
  for (const r of rows) {
    if (r?.on_at_start === true) yes += 1
    else if (r?.on_at_start === false) no += 1
  }
  return { yes, no, total: yes + no }
}

// Torn City Time == UTC. Render a war start like "Fri 20:00 TCT (26/06)".
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function formatTct(unixSec) {
  if (!unixSec) return '—'
  const d = new Date(unixSec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${DOW[d.getUTCDay()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} TCT (${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)})`
}

export function formatCountdown(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  if (!unixSec) return ''
  const diff = unixSec - nowSec
  if (diff <= 0) return 'started'
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (d > 0) return `in ${d}d ${h}h`
  if (h > 0) return `in ${h}h ${m}m`
  return `in ${m}m`
}

// War notes are stored as newline-delimited text (#141) — one point per line —
// but edited as a list and rendered as bullets. These convert between the two:
// backward-compatible, since any existing free-text note is just its lines.

/** Text (one point per line) → trimmed, non-empty point list. */
export function notePointsFromText(text) {
  return String(text ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** Point list → newline-delimited text for storage (drops blanks). */
export function notePointsToText(points) {
  return (points ?? [])
    .map((p) => String(p ?? '').trim())
    .filter((p) => p.length > 0)
    .join('\n')
}

// Who may view/edit the War Notes & roll-call results panel: war leaders and
// leadership/admin.
//
// ⚠️ This used to exclude the read-only `visitor` role explicitly, because the
// SPA set `isLeadership` true for visitors as well — they saw the leadership
// layout — and war notes include a leads-only private note. #922 removed the
// role (2026-10-06), so `isLeadership` no longer has that second meaning.
export function canSeeWarNotes({ isWarLead, isLeadership }) {
  return Boolean(isWarLead || isLeadership)
}

// Per-war overlay dismissal (#167). Persist "this browser cleared the roll-call
// gate for war N" — because the member submitted OR a leader chose to bypass —
// so a tab switch, re-mount, or a transient-empty refresh can't re-trip the
// blocking overlay for someone who's already dealt with it. Keyed by war id.
const ROLL_CALL_DISMISS_KEY = 'warRoomRollCallDismissed'

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function isRollCallDismissed(warId, storage = defaultStorage()) {
  if (!warId || !storage) return false
  try {
    const map = JSON.parse(storage.getItem(ROLL_CALL_DISMISS_KEY) || '{}')
    return map[String(warId)] === true
  } catch { return false }
}

export function markRollCallDismissed(warId, storage = defaultStorage()) {
  if (!warId || !storage) return
  try {
    const map = JSON.parse(storage.getItem(ROLL_CALL_DISMISS_KEY) || '{}')
    map[String(warId)] = true
    storage.setItem(ROLL_CALL_DISMISS_KEY, JSON.stringify(map))
  } catch { /* ignore quota / serialization */ }
}

// The blocking gate is active only when there's a current war, the member
// hasn't responded, and we're still more than the lead-time before kickoff.
export function rollCallGateActive({ currentWar, mySubmitted, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!currentWar || !currentWar.startAt) return false
  if (mySubmitted) return false
  return nowSec < currentWar.startAt - ROLL_CALL_LEAD_TIME_SEC
}

// Validate a roll-call answer object before submit. Q2/Q3 are only required
// when the member will NOT be on at the start.
export function validateRollCall(a) {
  if (typeof a?.on_at_start !== 'boolean') {
    return { ok: false, error: 'Please answer whether you’ll be on at the start.' }
  }
  if (a.on_at_start) return { ok: true }
  if (typeof a.can_self_hospital !== 'boolean') {
    return { ok: false, error: 'Please answer the self-hospital question.' }
  }
  if (!a.availability || a.availability === 'on_time') {
    return { ok: false, error: 'Please choose when you’ll be available.' }
  }
  return { ok: true }
}

const WAR_TYPE_LABELS = { real: 'Real', termed: 'Termed', race: 'Race' }
// Short badge text for the war type. Termed shows both agreed scores
// (ours–theirs), e.g. "Termed 15.5k–7.2k" / "Race → 25k" / "Real".
export function warTypeBadge(notes) {
  if (!notes?.war_type) return null
  const base = WAR_TYPE_LABELS[notes.war_type] ?? notes.war_type
  if (notes.war_type === 'termed' && (notes.termed_score_us != null || notes.termed_score_them != null)) {
    return `${base} ${formatScore(notes.termed_score_us)}–${formatScore(notes.termed_score_them)}`
  }
  if (notes.war_type === 'race' && notes.race_target_score != null) return `${base} → ${formatScore(notes.race_target_score)}`
  return base
}

function formatScore(n) {
  if (n == null) return '?'
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}k`
  return String(num)
}
