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
// Short badge text for the war type, e.g. "Termed 5k" / "Race → 25k" / "Real".
export function warTypeBadge(notes) {
  if (!notes?.war_type) return null
  const base = WAR_TYPE_LABELS[notes.war_type] ?? notes.war_type
  if (notes.war_type === 'termed' && notes.termed_score) return `${base} ${formatScore(notes.termed_score)}`
  if (notes.war_type === 'race' && notes.race_target_score) return `${base} → ${formatScore(notes.race_target_score)}`
  return base
}

function formatScore(n) {
  const num = Number(n)
  if (!Number.isFinite(num)) return String(n)
  if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}k`
  return String(num)
}
