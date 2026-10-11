// One member's war score, from our own attack ledger (#943).
//
// ⚠️ **BOTH figures come from `faction_attacks`, never one from each source.**
// Torn's war report carries a contribution score and so does our ledger, and
// the two drift — a hit landing either side of the window boundary, a scrape
// that missed a row. Taking `raw` from Torn and `normalised` from here would
// print a pair whose *difference* is meaningless, and that difference is the
// whole point of showing both: it is what the member lost to bonus caps.
//
// ⚠️ **A fourth implementation of "what counts as a hit" is what this file is
// trying not to be.** The rules live in `frontend/src/utils/
// warPayoutCalculations.js` because that is where payouts are computed, and
// every payout this faction has ever run used them. `war-member-score-parity.
// test.ts` runs both over the same rows and fails when they disagree, which is
// the only thing that makes the duplication survivable — the bot cannot run
// browser JS, so the numbers have to exist twice.
//
// ⚠️ `started` is epoch SECONDS here, as everywhere in `faction_attacks`.

/**
 * Chain lengths Torn awards a bonus hit on.
 *
 * ⚠️ Must equal `BONUS_HITS` in `warPayoutCalculations.js`. The parity test
 * asserts the sets are identical rather than trusting this copy.
 */
export const BONUS_HIT_CHAINS = new Set([
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
])

/** What a bonus hit's respect is capped to when normalising. */
export const BONUS_HIT_CAP = 10

/**
 * Results that score.
 *
 * ⚠️ `Special` is NOT here, and that is deliberate — see the note on
 * `WIN_RESULTS` in `warPayoutCalculations.js`. Adding it would silently change
 * what people are paid.
 */
export const SCORING_RESULTS = new Set([
  'Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted',
])

export interface ScoreAttackRow {
  attacker_id?: number | string | null
  attacker_faction_id?: number | string | null
  result?: string | null
  respect_gain?: number | string | null
  chain?: number | string | null
  is_ranked_war?: boolean | null
}

export interface MemberWarScore {
  /** Respect as Torn awarded it, bonus hits at full value. */
  raw: number
  /** Respect with bonus hits capped — the basis every payout uses. */
  normalised: number
  /** `raw - normalised`. Always >= 0. */
  bonus_reduction: number
  /** Scoring hits counted. */
  hits: number
  /** How many of those were bonus hits. */
  bonus_hits: number
}

/**
 * One member's score over a set of attack rows.
 *
 * ⚠️ **Returns `null` for a member with no scoring hits, not a zeroed object.**
 * "Scored nothing" and "we have no attack rows for this war" are different
 * facts, and the report renders them differently — the formatter's whole
 * design principle. A caller that wants zeros can ask for them; one that is
 * handed zeros cannot get the distinction back.
 */
export function scoreMemberWar(
  attacks: ScoreAttackRow[], memberId: number | string, ourFactionId: number | string,
): MemberWarScore | null {
  const me = Number(memberId)
  const us = Number(ourFactionId)
  if (!Number.isFinite(me) || !Number.isFinite(us)) return null

  let raw = 0
  let normalised = 0
  let hits = 0
  let bonusHits = 0

  for (const a of attacks) {
    if (Number(a.attacker_id) !== me) continue
    // ⚠️ **Our faction's hit, not merely this member's.** The page filters on
    // `attacker_faction_id === OUR_FACTION_ID` and so must this, or a row where
    // the member appears under another faction would score here and not there.
    //
    // ⚠️ Compared numerically. The page uses a strict `!==` against a Number,
    // so a faction id arriving as the STRING "10739" scores zero there and
    // correctly here — a latent divergence this slice records rather than
    // fixes, and one the parity fixture deliberately does not mask, because
    // `faction_attacks.attacker_faction_id` is an integer column and real rows
    // never take that path.
    if (Number(a.attacker_faction_id) !== us) continue
    // ⚠️ Outgoing only, and decided by the ATTACKER's faction rather than an
    // `is_incoming` flag. The server table has no such column; the page
    // derives it. Same rule, one source.
    if (!isRankedWarHit(a)) continue
    if (!SCORING_RESULTS.has(a.result ?? '')) continue

    const rawRespect = Number.parseFloat(String(a.respect_gain ?? 0)) || 0
    const chain = Number(a.chain) || 0
    const isBonus = BONUS_HIT_CHAINS.has(chain)
    const capped = isBonus ? Math.min(rawRespect, BONUS_HIT_CAP) : rawRespect

    raw += rawRespect
    normalised += capped
    hits += 1
    if (isBonus) bonusHits += 1
  }

  if (hits === 0) return null

  return {
    // ⚠️ Rounded to 2dp at the edge, not accumulated rounded. Respect is
    // numeric(10,4) and summing 300 rounded values drifts visibly from the
    // total the payout sheet shows.
    raw: round2(raw),
    normalised: round2(normalised),
    bonus_reduction: round2(raw - normalised),
    hits,
    bonus_hits: bonusHits,
  }
}

/**
 * ⚠️ The ranked-war flag is read loosely on purpose. `faction_attacks.
 * is_ranked_war` is a real boolean, but the same rows reach the page as JSON
 * where it may arrive as `1` or `"true"`, and the parity test drives both
 * implementations from one fixture.
 */
function isRankedWarHit(a: ScoreAttackRow): boolean {
  const v = a.is_ranked_war as unknown
  return v === true || v === 1 || v === 'true'
}

const round2 = (n: number) => Math.round(n * 100) / 100
