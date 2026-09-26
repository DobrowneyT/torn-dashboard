/**
 * War Room per-member flags (#339).
 *
 * The flags column is scanned, not read — a lead sweeps it looking for who is
 * reachable right now. So it carries only things that change a decision, and
 * every glyph has to mean one unambiguous thing.
 */

import { isOverdosed as statusOverdosed } from './memberNotes'
import { overdosedByDrugCooldown } from './warRoomMemberStats'

/**
 * Torn's three revive privacy settings, verbatim from the API enum
 * (`ReviveSetting`: Everyone | Friends & faction | No one | Unknown).
 */
export const REVIVE_EVERYONE = 'Everyone'
export const REVIVE_FRIENDS = 'Friends & faction'
export const REVIVE_NO_ONE = 'No one'

/**
 * Who can actually revive this member right now?
 *
 * Returns 'anyone' | 'friends' | null.
 *
 * The distinction matters because we hire OUTSIDE revivers. A target set to
 * "Friends & faction" is revivable in Torn's sense — `is_revivable` is true —
 * but not by anyone we can pay, so treating the boolean alone as "we can get
 * them up" would send a lead chasing a revive that cannot happen. Conversely
 * on the enemy side it is real intel: their own faction can bring them back.
 *
 * `is_revivable` stays the gate (it reflects whether a revive is possible at
 * all this moment); revive_setting only says by whom.
 */
export function reviveAudience(member) {
  if (!member?.is_revivable) return null
  const setting = member.revive_setting
  if (setting === REVIVE_NO_ONE) return null
  if (setting === REVIVE_FRIENDS) return 'friends'
  if (setting === REVIVE_EVERYONE) return 'anyone'
  // 'Unknown', null, or a value Torn adds later.
  //
  // Treat this as 'anyone' (#342). Torn reports Unknown when it will not
  // disclose the preference — which is the normal case for an ENEMY, i.e. most
  // of the roster. `is_revivable` is already computed from OUR vantage point,
  // so a true there means a revive is possible; the missing piece is only the
  // stated preference. Degrading to 'friends' here painted the entire enemy
  // roster muted and buried the real distinction.
  return 'anyone'
}

/**
 * Is this member overdosed, by either detector?
 *
 * Two independent signals with different blind spots, so the flag ORs them:
 *   • hospital status says "Overdosed" (#199) — certain, but only until they
 *     are released;
 *   • drug cooldown over 10h (#336) — survives release, but our-roster only,
 *     since it needs the member's own key.
 */
export function isOverdosedAnySource(member, stats) {
  return Boolean(statusOverdosed(member) || overdosedByDrugCooldown(stats))
}

/**
 * The flags to render, in scan order, as [{ key, glyph, title, tone }].
 *
 * Order is deliberate: the two that change what you do next (they're abroad;
 * they can be revived) come first, then the ones that merely colour the
 * picture.
 *
 * `is_in_oc` is intentionally absent — a member being in an organised crime
 * has no bearing on whether they can be hit or revived, and it was crowding
 * the column (#339).
 */
/**
 * The order the Flags column sorts in.
 *
 * ⚠️ Severity, not alphabet. Sorting the glyphs or the keys by name would put
 * "early discharge" above "overdosed", and the whole point of grouping this
 * column is to find the people who are out of action — so the ordering has to
 * mean something rather than just be consistent.
 *
 * ⚠️ A member carries several flags at once, so the sort keys on their MOST
 * significant one. Somebody flying AND overdosed belongs with the overdosed.
 */
export const FLAG_SORT_ORDER = [
  'od',              // out of action, and for far longer than a hospital stay
  'flying',          // cannot be hit, cannot hit, and not coming back soon
  'wall',            // committed elsewhere
  'revive-anyone',   // actionable: we can get them up
  'revive-friends',  // less actionable: only their own side can
  'ed',              // a detail about a hospital stay, not a state
]

/**
 * A sortable rank for a member's flags — lower sorts first.
 *
 * Returns `null` when a member has no flags at all. ⚠️ That is not rank zero
 * and not the bottom rank: the caller sinks unflagged members in BOTH
 * directions, the same rule `ff` follows, so that reversing the sort still
 * shows the interesting rows first instead of a screen of blanks.
 */
export function flagRank(flags) {
  let best = null
  for (const f of flags ?? []) {
    const i = FLAG_SORT_ORDER.indexOf(f.key)
    if (i === -1) continue
    if (best === null || i < best) best = i
  }
  return best
}

export function memberFlags(member, { isFlying = false, stats = null } = {}) {
  const flags = []

  if (isFlying) {
    flags.push({ key: 'flying', glyph: '✈', title: 'Flying / abroad', tone: 'info' })
  }

  const audience = reviveAudience(member)
  if (audience === 'anyone') {
    flags.push({
      key: 'revive-anyone',
      glyph: '💉',
      title: 'Revivable',
      tone: 'good',
    })
  } else if (audience === 'friends') {
    // Only ever reached when Torn explicitly states the restriction, which in
    // practice means our own members: we can see their real setting.
    flags.push({
      key: 'revive-friends',
      glyph: '💉',
      title: 'Revivable by friends & faction only',
      tone: 'muted',
    })
  }

  if (member?.has_early_discharge) {
    flags.push({ key: 'ed', glyph: '⚡', title: 'Early discharge available', tone: 'info' })
  }

  if (isOverdosedAnySource(member, stats)) {
    flags.push({
      key: 'od',
      glyph: '☠',
      title: 'Overdosed — out of action well beyond a normal hospital stay',
      tone: 'bad',
    })
  }

  if (member?.is_on_wall) {
    flags.push({ key: 'wall', glyph: '🛡', title: 'Defending a territory wall', tone: 'info' })
  }

  // #528 Part 2's loadout flag lived here, moved out (MonChoon, 2026-08-23):
  // the shield icon next to the member's name (LoadoutShieldIcon.jsx) shows
  // the same observation, and having it in both places was redundant rather
  // than complementary. See warRoomLoadout.js for the formatting helpers,
  // still used by the shield icon.

  return flags
}
