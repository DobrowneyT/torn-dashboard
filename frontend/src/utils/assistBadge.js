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

/**
 * Which kind the one badge shows when several are outstanding (#617).
 *
 * ⚠️ Order is meaning, not taste. `help` is a PERSON needed in a fight that is
 * already going badly; smoke and tear are consumables that improve the odds.
 * If a target needs a body and a smoke, the body is the one a lead scanning
 * the board has to see. Every live kind still reaches them — the ones this
 * order loses from the glyph are spelled out in the title.
 */
const KIND_PRIORITY = ['help', 'smoke', 'tear']

/**
 * How many of a thing are still being asked for (#591).
 *
 * ⚠️ Reads 0 as 0 since #617, where the old shape could not. Under #523 the
 * row's existence WAS the request, so a missing or zero `wanted` meant a row
 * written before the column existed and 1 was the honest floor — "×0" would
 * have read as "nobody is asking" about a row that by definition meant someone
 * was. Now the count IS the request: a kind at zero is nobody asking, and the
 * caller must be able to tell that from one still outstanding.
 */
function assistCount(raw) {
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Collapse a counts row to the one kind the badge shows, plus everything live.
 *
 * Accepts the #617 per-target row (`{help_wanted, smoke_raised_at, …}`) and
 * the userscript's own index entry shape.
 */
function assistHolder(assist) {
  if (!assist) return null
  const live = KIND_PRIORITY
    .map(kind => ({
      kind,
      wanted: assistCount(assist[`${kind}_wanted`]),
      at: assist[`${kind}_raised_at`] ?? null,
    }))
    .filter(k => k.wanted > 0)
  if (live.length === 0) return null
  // KIND_PRIORITY order is preserved by the map above, so the first survivor
  // is the highest-priority live kind.
  return { ...live[0], live }
}

/** "Smoke ×2" / "Help" — the count only when there is more than one. */
function kindPhrase({ kind, wanted }) {
  const meta = ASSIST_KIND_META[kind] ?? { label: kind ?? 'Assist' }
  return wanted > 1 ? `${meta.label} ×${wanted}` : meta.label
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
    // ⚠️ #617: no requester on the row any more, so no "requested by …". That
    // is MonChoon's call ("drop the name, show the count only") and it follows
    // from the model rather than from taste: a count is the sum of everyone
    // who asked, so there is no one person to name, and naming the first or
    // the last would be picking one arbitrarily and printing it as fact.
    //
    // When several kinds are live the badge still shows ONE (the row has no
    // horizontal space for more — the #523 constraint is unchanged); the title
    // carries the rest, so nothing is hidden from someone who looks.
    const others = held.live.filter(k => k.kind !== held.kind)
    const detail = [
      `${kindPhrase(held)} requested`,
      // Not lowercased: the kind names are the badge's own labels, and
      // "also Smoke ×3" matches what the glyph would say if it had room.
      ...others.map(k => `also ${kindPhrase(k)}`),
      fmtAgo(held.at),
    ]
    return {
      mode: 'assist',
      // `label` stays readable text (fallback for any caller that just prints
      // it); `icon` is the Lucide name a caller with real icons renders
      // instead — see ASSIST_KIND_META's own note on why this can't just be
      // a component reference.
      // A count of one says nothing worth saying — "Smoke ×1" is noise on the
      // overwhelming majority of requests, so the multiple only appears when
      // there IS one.
      label: kindPhrase(held),
      icon: meta.icon,
      wanted: held.wanted,
      /** Every live kind, highest-priority first — for callers with room to show more than one. */
      kinds: held.live,
      href: attackUrl(targetId),
      tone: 'assist',
      title: detail.join(' · '),
      action: null,
      mine: false,
      taken: true,
    }
  }
  return { mode: 'dibs', href: null, ...dibsButtonState(dib, currentUserId, opts) }
}
