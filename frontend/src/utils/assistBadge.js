/**
 * What the Dibs badge should say and do when an assist request is active
 * (#523).
 *
 * MonChoon's call (2026-08-21): don't add a second indicator next to Dibs —
 * conserve the row's horizontal space and let the SAME badge morph. While a
 * target has a live assist request, the badge shows just the kind (the badge
 * stays icon-short; who asked and how long ago live in the title/tooltip) and
 * becomes a link straight to that target's attack page — no claim/release
 * action while it's active. Dibs underneath is untouched: a target can be
 * both dibbed AND have an active assist; this only decides which one the ONE
 * badge shows right now (assist wins, because it's the more urgent of the
 * two).
 *
 * One seam, deliberately, mirroring dibsButtonState/paint's own split: this
 * is the state → view-model half; the caller (WarRoomViewV2's Dibs cell, the
 * userscript's equivalent) does the pure paint. A follow-up visual-only pass
 * on the assist badge is meant to touch the paint side alone.
 */
import { dibsButtonState } from './dibsButton.js'
import { fmtAgo } from './time.js'

/**
 * `icon` is a Lucide icon name, not a rendered glyph — this file has no JSX
 * and cannot import a component, so it hands back a name the caller (a real
 * <CloudFog/> etc. here, an inlined matching SVG in the userscript, which has
 * no npm imports at all) resolves on its own side. Picked to match Lucide's
 * shipped shapes exactly (verified against the installed lucide-react
 * version): a literal smoke cloud, a literal water drop, and the standard
 * life-preserver "get help" glyph — not decorative substitutes.
 */
export const ASSIST_KIND_META = {
  smoke: { icon: 'cloud-fog', label: 'Smoke' },
  tear: { icon: 'droplet', label: 'Tear gas' },
  help: { icon: 'life-buoy', label: 'Help' },
}

export function attackUrl(targetId) {
  const id = Number(targetId)
  return Number.isFinite(id) && id > 0 ? `https://www.torn.com/page.php?sid=attack&user2ID=${id}` : null
}

/** The two row shapes: `{requester_id, requester_name, kind, created_at}` (REST) and a userscript-style index entry. */
function assistHolder(assist) {
  if (!assist) return null
  const id = assist.requester_id ?? assist.by
  if (id === null || id === undefined) return null
  return {
    id,
    name: assist.requester_name ?? assist.name ?? null,
    kind: assist.kind,
    at: assist.created_at ?? assist.at ?? null,
    wanted: assistCount(assist.wanted),
  }
}

/**
 * How many of a thing are still being asked for (#591).
 *
 * ⚠️ Anything unusable becomes 1, never 0. A row from before the column
 * existed has no `wanted`, and a "×0" badge would read as "nobody is asking" —
 * the exact opposite of what a live row means. One is the honest floor: the
 * row exists, so at least one is outstanding.
 */
function assistCount(raw) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * @param {object|null} dib - the row `dibsButtonState` already understands.
 * @param {object|null} assist - a live assist row for this target, or null.
 * @param {number|string} targetId - needed only to build the attack-page href.
 * @param {number|string} currentUserId
 * @param {{isAdmin?: boolean}} [opts]
 * @returns {{mode: 'dibs'|'assist', label: string, icon?: string, href: string|null, tone: string, title?: string, action: string|null, mine: boolean, taken: boolean}}
 */
export function assistBadgeState(dib, assist, targetId, currentUserId, opts = {}) {
  const held = assistHolder(assist)
  if (held) {
    const meta = ASSIST_KIND_META[held.kind] ?? { icon: 'life-buoy', label: held.kind ?? 'Assist' }
    const mine = String(held.id) === String(currentUserId)
    const who = mine ? 'you' : (held.name ?? 'someone')
    return {
      mode: 'assist',
      // `label` stays readable text (fallback for any caller that just prints
      // it); `icon` is the Lucide name a caller with real icons renders
      // instead — see ASSIST_KIND_META's own note on why this can't just be
      // a component reference.
      // A count of one says nothing worth saying — "Smoke ×1" is noise on the
      // overwhelming majority of requests, so the multiple only appears when
      // there IS one.
      label: held.wanted > 1 ? `${meta.label} ×${held.wanted}` : meta.label,
      icon: meta.icon,
      wanted: held.wanted,
      href: attackUrl(targetId),
      tone: 'assist',
      title: held.wanted > 1
        ? `${meta.label} requested by ${who} · ${held.wanted} still needed · ${fmtAgo(held.at)}`
        : `${meta.label} requested by ${who} · ${fmtAgo(held.at)}`,
      action: null,
      mine,
      taken: true,
    }
  }
  return { mode: 'dibs', href: null, ...dibsButtonState(dib, currentUserId, opts) }
}
