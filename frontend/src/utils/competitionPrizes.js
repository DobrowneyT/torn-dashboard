// Competition prize helpers (#239). Prizes are informational: a placement table
// of tagged slots (cash / text; item arrives later). These format slots for
// display and build the submit payload from the create-form rows.

// A single prize slot → display string. Cash is formatted with separators;
// text is verbatim.
export function formatPrize(slot) {
  if (!slot) return ''
  if (slot.kind === 'cash') return `$${Number(slot.amount).toLocaleString('en-US')}`
  if (slot.kind === 'text') return String(slot.text ?? '')
  return ''
}

// English ordinal for a placement (1 → "1st", 2 → "2nd", …).
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

// The rows a placement prize table renders: rank label + formatted prize.
export function prizeTableRows(competition) {
  const prizes = Array.isArray(competition?.prizes) ? competition.prizes : []
  return prizes.map((slot, i) => ({ place: ordinal(i + 1), prize: formatPrize(slot) }))
}

// Build the `prizes` payload from the create-form slot rows: coerce cash amounts
// to numbers, trim text, and drop blank slots so empty rows aren't submitted.
export function buildPrizes(slots) {
  const out = []
  for (const s of slots ?? []) {
    if (s.kind === 'cash') {
      const amount = Number(s.amount)
      if (s.amount !== '' && Number.isFinite(amount) && amount > 0) out.push({ kind: 'cash', amount })
    } else if (s.kind === 'text') {
      const text = String(s.text ?? '').trim()
      if (text) out.push({ kind: 'text', text })
    }
  }
  return out
}
