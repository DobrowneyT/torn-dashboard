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
  // 'Unknown', null, or a value Torn adds later: the member IS revivable, we
  // just cannot say by whom. Report the weaker claim rather than promising a
  // hired reviver will work.
  return 'friends'
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
      title: 'Revivable by anyone — a hired reviver can bring them up',
      tone: 'good',
    })
  } else if (audience === 'friends') {
    const known = member?.revive_setting === REVIVE_FRIENDS
    flags.push({
      key: 'revive-friends',
      glyph: '💉',
      title: known
        ? 'Revivable by their friends & faction ONLY — a hired reviver cannot'
        : 'Revivable, but their revive setting is unknown — a hired reviver may not work',
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

  return flags
}
