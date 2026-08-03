// Competition prize helpers (#239). Prizes are informational: a placement table
// of tagged slots (cash / text; item arrives later). These format slots for
// display and build the submit payload from the create-form rows.

// A single prize slot → display string. Cash is formatted with separators;
// text is verbatim.
export function formatPrize(slot) {
  if (!slot) return ''
  if (slot.kind === 'cash') return `$${Number(slot.amount).toLocaleString('en-US')}`
  if (slot.kind === 'text') return String(slot.text ?? '')
  if (slot.kind === 'item') return `${slot.qty ?? 1}x ${slot.name ?? `#${slot.item_id}`}`
  return ''
}

// English ordinal for a placement (1 → "1st", 2 → "2nd", …).
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

// The rows a prize table renders. Placement: rank label + prize per slot. Flat
// (#240): a single "Everyone" row for the one shared prize.
export function prizeTableRows(competition) {
  const prizes = Array.isArray(competition?.prizes) ? competition.prizes : []
  if (competition?.prize_kind === 'flat') {
    return prizes.length ? [{ place: 'Everyone', prize: formatPrize(prizes[0]) }] : []
  }
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
    } else if (s.kind === 'item') {
      // #241: only submit the id + quantity; the server stamps the canonical
      // name. A slot with no item picked is dropped.
      const itemId = Number(s.item_id)
      if (Number.isInteger(itemId) && itemId > 0) {
        const qty = Math.max(1, Math.floor(Number(s.qty) || 1))
        out.push({ kind: 'item', item_id: itemId, qty })
      }
    }
  }
  return out
}

// Build the full prize payload for the create form: the chosen distribution
// mode plus its slots. Flat (#240) awards one prize to everyone, so its payload
// is capped to a single slot; placement keeps every slot.
export function buildPrizePayload(prizeKind, slots) {
  const kind = prizeKind === 'flat' ? 'flat' : 'placement'
  const prizes = buildPrizes(slots)
  return { prize_kind: kind, prizes: kind === 'flat' ? prizes.slice(0, 1) : prizes }
}
