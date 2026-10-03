// Chase lists from a roll call: who is not turning up, and who might.
//
// MonChoon, 2026-10-03: two copy buttons on the War Room's Roll Call section —
// one for the people who are missing, one for the maybes — so a lead can paste
// a list into Discord and chase it instead of reading names off a table.
//
// ⚠️ The two lists are DISJOINT and that is the whole design. "Not on at the
// start" is not the same question as "not coming": somebody who said no to the
// start but yes to self-hospitalising is a different problem from somebody who
// said no to both. The first needs a nudge five minutes before the war; the
// second needs replacing. One combined list of "no" answers would mix the
// people worth pinging in with the people worth writing off.
//
//   MISSING  — did not respond at all, OR said no to the start and cannot
//              self-hospitalise (including "needs a merc" and the case where
//              they simply never answered the self-hosp question).
//   MAYBE    — said no to the start but YES to self-hospitalising. They can
//              put themselves in; the question is only whether they have.
//
// ⚠️ A non-responder counts as MISSING, not as unknown. A lead chasing a list
// before a war needs the silent ones on it — silence is the most common way
// somebody fails to turn up, and leaving them off makes the list look
// reassuringly short.

import { formatStats } from './statInput'

/** Torn profile, not an attack link. */
export const profileUrl = (id) => `https://www.torn.com/profiles.php?XID=${id}`

/**
 * ⚠️ `can_self_hospital` is NULL whenever `on_at_start` is true — the server
 * nulls it on write (`warRoomWrites.ts:595`), because the question only applies
 * to a "no". So it must never be read without checking `on_at_start` first, or
 * everybody who IS turning up looks like they answered "no" to self-hosp.
 */
function bucketFor(response) {
  if (!response) return 'missing'            // no response at all
  if (response.on_at_start) return null      // turning up; neither list
  if (response.can_self_hospital === true) return 'maybe'
  return 'missing'                           // no to both, needs a merc, or unanswered
}

/** Why this member is on the list, for the pasted line. */
function reasonFor(response) {
  if (!response) return 'no response'
  if (response.can_self_hospital === true) return 'can self-hosp'
  if (response.needs_merc) return 'needs merc'
  return 'not available'
}

/**
 * Split the roster into the two chase lists.
 *
 * `members` is the our-side roster (ideally already through `withBattleStats`,
 * so `bsp_total` is present); `responses` is the roll-call rows. Members are
 * matched by id as a NUMBER on both sides — the roster carries numeric ids and
 * the roll-call rows carry strings, and a mixed-type Set lookup silently misses
 * every single one, which would put the entire faction in `missing`.
 */
export function splitChaseLists(members = [], responses = []) {
  const byId = new Map()
  for (const r of responses ?? []) byId.set(Number(r?.member_id), r)

  const missing = []
  const maybe = []

  for (const m of members ?? []) {
    const response = byId.get(Number(m?.member_id))
    const bucket = bucketFor(response)
    if (!bucket) continue
    const entry = {
      member_id: m?.member_id,
      member_name: m?.member_name ?? String(m?.member_id ?? ''),
      bsp_total: m?.bsp_total ?? null,
      reason: reasonFor(response),
      responded: !!response,
      availability: response?.availability ?? null,
    }
    ;(bucket === 'maybe' ? maybe : missing).push(entry)
  }

  // ⚠️ Strongest first, unknown stats last. A lead working down a chase list
  // under time pressure wants the people who matter most at the top, and a
  // member we have never spied is not a weak member — sinking them in both
  // directions is the #351 rule this repo already follows for the roster sort.
  const byStatsThenName = (a, b) => {
    const av = a.bsp_total, bv = b.bsp_total
    if (av == null && bv == null) return a.member_name.localeCompare(b.member_name, undefined, { sensitivity: 'base' })
    if (av == null) return 1
    if (bv == null) return -1
    return bv - av || a.member_name.localeCompare(b.member_name, undefined, { sensitivity: 'base' })
  }
  missing.sort(byStatsThenName)
  maybe.sort(byStatsThenName)

  return { missing, maybe }
}

/**
 * One pasteable block.
 *
 * Plain text with one member per line, because the destination is Discord and
 * anything table-shaped collapses there. The header carries the count so the
 * person reading the paste knows whether they got the whole list.
 */
export function formatChaseList(entries = [], { title = 'Roll call' } = {}) {
  if (entries.length === 0) return `${title} (0) — nobody`
  const lines = entries.map((e) =>
    `${e.member_name} [${e.member_id}] · ${formatStats(e.bsp_total)} · ${e.reason} · ${profileUrl(e.member_id)}`
  )
  return [`${title} (${entries.length})`, ...lines].join('\n')
}
