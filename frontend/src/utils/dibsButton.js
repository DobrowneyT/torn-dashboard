/**
 * What the dibs control should say and do (#509).
 *
 * One definition for both surfaces. The War Room and the Torn userscript show
 * the same control, and the two disagreeing about whether a click releases a
 * claim is the kind of thing that only shows up mid-war — the userscript
 * mirrors this function verbatim, because a userscript is one file with no
 * build step and cannot import it.
 *
 * ⚠️ `isAdmin` is a UI affordance ONLY. The server decides: the DELETE handler
 * releases any claim for an admin and filters to `claimed_by = you` for
 * everyone else, so a non-admin who forces the click changes nothing. Never
 * let this flag become the actual guard.
 */

/** The two row shapes: `{claimed_by, claimed_name}` (REST) and `{by, name}` (script). */
function holder(dib) {
  if (!dib) return null
  const id = dib.claimed_by ?? dib.by
  if (id === null || id === undefined) return null
  return { id, name: dib.claimed_name ?? dib.name ?? null }
}

export function dibsButtonState(dib, currentUserId, { isAdmin = false } = {}) {
  const held = holder(dib)
  if (!held) {
    return { label: 'Dibs', action: 'claim', mine: false, taken: false, tone: 'free' }
  }

  if (String(held.id) === String(currentUserId)) {
    // ⚠️ Release is the SAME control, not a second one. The old War Room put a
    // separate "Release" link beside the name, which is a second thing to aim
    // at in the middle of a chain for an action that is simply the inverse of
    // the one that got you here.
    return { label: '✓ Yours', action: 'release', mine: true, taken: true, tone: 'mine' }
  }

  // Someone else's. An admin can take it off them — that has always been true
  // server-side and was exposed as the Release link; it stays, as a click on
  // the badge itself. For everyone else the control is inert, not hidden:
  // knowing WHO holds a target is the point.
  return {
    label: held.name ?? 'Claimed',
    action: isAdmin ? 'release' : 'none',
    mine: false,
    taken: true,
    tone: 'taken',
    title: isAdmin ? `Held by ${held.name ?? 'someone'} — click to release (admin)` : `Held by ${held.name ?? 'someone'}`,
  }
}
