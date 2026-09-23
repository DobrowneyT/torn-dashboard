/**
 * Chain Watch payout and raffle (#773).
 *
 * The half of the spreadsheet that turns served hours into money. Every number
 * here is **derived from the event's current settings** against the sign-up
 * rows — never stamped onto a row when it was claimed.
 *
 * ⚠️ That is not a style preference. The sheet froze its bonus into a column
 * position and paid 59 slots where 31 were marked; deriving means leadership
 * can correct `bonus_hours` mid-event and the correction reaches hours already
 * served.
 */

/** Slots descending, then member id ascending. Stated, because it has to be stable. */
const ORDER = (a, b) => b.slots - a.slots || String(a.member_id).localeCompare(String(b.member_id))

/**
 * Is this served slot money?
 *
 * ⚠️ A flag is a question, not a verdict. An `absent` slot stays payable until a
 * leader says otherwise — #774 records what it saw and decides nothing. The two
 * things that DO withhold pay are a leader's explicit `unpaid`, and `abroad`,
 * which is not a judgment call: a watcher overseas could not have hit anything.
 */
export function isPaid(signup) {
  if (signup.pay_decision === 'unpaid') return false
  if (signup.pay_decision === 'paid') return true
  if (signup.flag === 'abroad') return false
  return signup.is_payable !== false
}

/** What the bonus multiplies, read off the event rather than assumed. */
const appliesTo = (event) => ({
  tickets: event?.bonus_applies_to === 'tickets' || event?.bonus_applies_to === 'both'
    || event?.bonus_applies_to == null,
  payout: event?.bonus_applies_to === 'payout' || event?.bonus_applies_to === 'both',
})

/**
 * One row per member with at least one slot, plus a computed total.
 *
 * ⚠️ The total is **computed from the rows**. The sheet's totals row reads 189.5
 * bonus slots — exactly half the slot count, a stray `/2` — where its own member
 * rows sum to 59. A total that is typed is a total that is wrong.
 */
export function payoutRows(event, signups = []) {
  const perSlot = Number(event?.payout_per_slot ?? 0)
  const mult = Number(event?.bonus_multiplier ?? 2)
  const applies = appliesTo(event)

  const byMember = new Map()
  for (const s of signups) {
    const id = String(s.member_id)
    if (!byMember.has(id)) {
      byMember.set(id, {
        member_id: id, member_name: s.member_name ?? id,
        slots: 0, bonusSlots: 0, unpaidSlots: 0, flagged: 0, awaiting: 0,
      })
    }
    const row = byMember.get(id)
    if (!isPaid(s)) {
      row.unpaidSlots += 1
      if (s.flag) row.flagged += 1
      continue
    }
    row.slots += 1
    if (s.is_bonus) row.bonusSlots += 1
    if (s.flag) { row.flagged += 1; if (!s.pay_decision) row.awaiting += 1 }
  }

  const rows = [...byMember.values()]
    .filter((r) => r.slots > 0 || r.unpaidSlots > 0)
    .map((r) => {
      // A bonus slot is worth `mult` of whatever it multiplies, so the extra is
      // `mult - 1` per bonus slot on top of the flat one.
      const extra = r.bonusSlots * (mult - 1)
      return {
        ...r,
        tickets: applies.tickets ? r.slots + extra : r.slots,
        // ⚠️ ONE payout number, and it is the one the link carries. The sheet
        // showed Warwinds 35,000,000 beside a link paying 34,500,000.
        payout: Math.round((r.slots + (applies.payout ? extra : 0)) * perSlot),
      }
    })
    .sort(ORDER)

  // Contiguous ticket ranges over the stable order above. ⚠️ A raffle whose
  // numbering reshuffles between renders is not a raffle.
  let next = 1
  for (const r of rows) {
    if (r.tickets > 0) {
      r.firstTicket = next
      r.lastTicket = next + r.tickets - 1
      next = r.lastTicket + 1
    } else {
      r.firstTicket = null
      r.lastTicket = null
    }
  }

  return {
    rows,
    totals: {
      slots: rows.reduce((n, r) => n + r.slots, 0),
      bonusSlots: rows.reduce((n, r) => n + r.bonusSlots, 0),
      tickets: next - 1,
      payout: rows.reduce((n, r) => n + r.payout, 0),
      awaiting: rows.reduce((n, r) => n + r.awaiting, 0),
      unpaidSlots: rows.reduce((n, r) => n + r.unpaidSlots, 0),
    },
  }
}

/** The faction-controls link, carrying exactly the number on the row. */
export function payLink(memberId, payout) {
  return 'https://www.torn.com/factions.php?step=your#/tab=controls'
    + `&addMoneyTo=${memberId}&money=${payout}`
}

/**
 * Does the raffle run?
 *
 * ⚠️ A dropped chain pays the slots but **not** the raffle (MonChoon,
 * 2026-09-22). That condition belongs on the sign-up page before anyone claims
 * an hour — a prize that turns out to have been conditional reads as leadership
 * withholding it, which is far more expensive than the raffle itself.
 */
export function raffleRuns(outcome) {
  return !(outcome?.state === 'ended' && outcome.dropped === true)
}

/** What the panel says about hours that never happened. */
export function unpayableNote(event, signups = [], outcome) {
  const end = outcome?.state === 'ended'
    ? outcome.endedAt
    : null
  const after = signups.filter((s) => s.is_payable === false).length
  if (!after) return null
  // ⚠️ Say it. Silently dropping sign-ups on hours that never happened looks
  // identical to a bug in the counting.
  //
  // db-time-safe: `end` is outcome.endedAt, an epoch NUMBER the server derived
  // from chain_samples — never the bare-offset timestamp text the API serves.
  const when = end ? new Date(end).toISOString().slice(0, 16).replace('T', ' ') : null
  return `${after} sign-up${after === 1 ? '' : 's'} fell after the chain ended`
    + (when ? ` (${when} TCT)` : '')
    + ' and are not paid.'
}
