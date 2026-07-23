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
// real leadership/admin. In the SPA the `isLeadership` flag is also true for
// read-only visitors (they see the leadership layout), so visitors must be
// excluded explicitly — war notes include a leads-only private note.
export function canSeeWarNotes({ isWarLead, isLeadership, isVisitor }) {
  return Boolean(isWarLead || (isLeadership && !isVisitor))
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
