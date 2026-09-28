/**
 * War Data Loader
 * Read operations for war-related tables via the faction API.
 * Write operations go through adminApi.js (Edge Function).
 */

import { apiGet } from './apiClient'
import {
  BONUS_HITS, WIN_RESULTS, LOSS_RESULTS, ASSIST_RESULT, isWarAttack,
} from './warPayoutCalculations'
import { getFactionId } from './factionIdentity'

/**
 * Load faction lookup rows for a given set of IDs.
 * Returns a Map<id, { id, name, tag }> for easy use in components.
 *
 * @param {Iterable<number>} factionIds
 * @returns {Promise<Map<number, {id:number, name:string, tag:string|null}>>}
 */
export async function loadFactionsByIds(factionIds) {
  const ids = [...new Set([...factionIds].filter(Boolean).map(Number))]
  if (ids.length === 0) return new Map()

  const { factions } = await apiGet(`/api/factions?ids=${ids.join(',')}`)
  const map = new Map()
  for (const row of factions || []) map.set(Number(row.id), row)
  return map
}

/**
 * Load ranked wars, newest first.
 *
 * @param {number} limit - Max wars to fetch
 * @param {number} offset - Pagination offset (0-indexed)
 * @returns {Promise<Array>}
 */
export async function loadWars(limit = 5, offset = 0) {
  const { wars } = await apiGet(`/api/wars?limit=${limit}&offset=${offset}`)
  return wars || []
}

/**
 * Load the total count of ranked wars (for pagination).
 *
 * @returns {Promise<number>}
 */
export async function loadWarsCount() {
  const { total } = await apiGet('/api/wars?limit=5&offset=0')
  return Number(total) || 0
}

/**
 * Load a single war by ID.
 *
 * @param {number} warId
 * @returns {Promise<object|null>}
 */
export async function loadWar(warId) {
  const { war } = await apiGet(`/api/wars/${warId}`)
  return war
}

/**
 * Load per-member contributions for a war.
 * Returns both our faction members and opponent members.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadWarContributions(warId) {
  const { contributions } = await apiGet(`/api/wars/${warId}/contributions`)
  return contributions || []
}

/**
 * Build a live leaderboard for an ongoing (or just-ended) ranked war by
 * aggregating faction_attacks rows in the war's [start_at, end_at] window
 * directly — the war_member_contributions table is only populated after a
 * war is fully reported by Torn (often hours after a win/forfeit), so this
 * is the only way to show a current scoreboard while a war is still live.
 *
 * The leaderboard is seeded from the roster (is_current = true) so every
 * faction member appears with 0 score / 0 attacks even if they haven't
 * landed a war hit yet. This lets a member look themselves up and see
 * exactly how far they are from the base-share threshold — the original
 * "only show people with score" behaviour made non-participants invisible.
 *
 * Scoring rules match the existing termed-war payout math in
 * warPayoutCalculations.calculateCutoffScores:
 *   - filter to OUR faction's outgoing ranked-war wins only
 *   - cap respect_gain at 10 for chain-bonus hits (10, 25, 50, 100, ...) —
 *     matches Torn's flat-score-per-hit rule in termed wars and prevents
 *     bonus-milestone outliers from skewing the leaderboard
 *
 * Returned rows match the shape of `loadWarContributions` so the existing
 * ContributionsModal renderer can consume them unchanged; `level` is null
 * (the members table doesn't store it; war_room_state_v2 has it only while
 * the war room polls and isn't reliable here).
 */
export async function loadLiveContributionsFromAttacks(war) {
  if (!war?.start_at) return []
  const OUR_FACTION_ID = getFactionId() // tenant faction, resolved at runtime (#249)

  // Seed: every current faction member starts at 0. Fall back gracefully
  // if the roster read fails so the leaderboard still works in
  // attack-only mode.
  const agg = new Map()
  try {
    const { roster } = await apiGet('/api/members/roster')
    for (const m of roster || []) {
      if (!m.is_current) continue
      const id = Number(m.member_id)
      if (!id) continue
      agg.set(id, {
        member_id:   id,
        member_name: m.member_name,
        level:       null,
        attacks:     0,
        assists:     0,
        losses:      0,
        score:       0,
        score_raw:   0,
        faction_id:  OUR_FACTION_ID,
      })
    }
  } catch (e) {
    console.warn('[live leaderboard] roster seed failed; continuing attack-only:', e)
  }

  // The window endpoint returns all attacks in [start_at, end_at]; the
  // war-win filters below (ours, outgoing, ranked, win results) stay
  // client-side to keep the scoring rules next to the payout math.
  const windowAttacks = await loadFactionAttacksByWindow(war.start_at, war.end_at)

  // ⚠️ **Torn only sets `is_ranked_war` on attacks that SCORED.** Measured on
  // the live Damage Inc war: of 2,714 outgoing assists in the window, `0` carry
  // the flag — and the same for all 1,236 losses. Filtering on it therefore
  // dropped 100% of both, which is why the columns read zero for everybody.
  //
  // The fix is the one the payout code already uses: `isWarAttack` falls back
  // to WHO WAS ATTACKED when the flag is absent. 2,713 of those 2,714 assists
  // are against the opponent faction, so the scope is exact.
  const opponentFactionIds = new Set(
    [Number(war.opponent_id)].filter((id) => Number.isFinite(id) && id > 0))

  const all = windowAttacks.filter((a) =>
    Number(a.attacker_faction_id) === OUR_FACTION_ID &&
    a.is_incoming === false &&
    isWarAttack(a, opponentFactionIds)
  )

  // Aggregate per attacker with bonus-hit cap. If an attacker isn't in the
  // members seed (mid-war joiner, recently left, or members table was stale),
  // create their row on the fly using the attack's attacker_name.
  for (const a of all) {
    const id = Number(a.attacker_id)
    if (!id) continue
    const result = a.result || ''
    // ⚠️ **Wins stay on the STRICT flag, deliberately.** Score has to agree with
    // `calculateCutoffScores`, which tests `is_ranked_war` directly — so a win
    // counted here but not there would show a member a score their payout does
    // not match. Measured, the two scopes differ by 3 hits in 1,869 (opponent
    // scope catches a few at the war boundary that Torn never flagged), and a
    // 0.16% disagreement with payout is worth more than those 3 hits.
    //
    // Assists and losses have no such constraint: they score nothing, so there
    // is no payout number for them to disagree with, and the flag is never set
    // on them anyway.
    const isWin = WIN_RESULTS.has(result) && a.is_ranked_war === true
    // ⚠️ Anything Torn reports that is none of the three — a result type added
    // after this was written — is counted in NO column rather than guessed
    // into one. A wrong column reads as fact; an absent one reads as a gap.
    if (!isWin && result !== ASSIST_RESULT && !LOSS_RESULTS.has(result)) continue
    const raw = parseFloat(a.respect_gain) || 0
    const chain = Number(a.chain) || 0
    const score = BONUS_HITS.has(chain) ? Math.min(raw, 10) : raw
    let row = agg.get(id)
    if (!row) {
      row = {
        member_id:   id,
        member_name: a.attacker_name,
        level:       null,
        attacks:     0,
        assists:     0,
        losses:      0,
        score:       0,
        score_raw:   0,
        faction_id:  OUR_FACTION_ID,
      }
      agg.set(id, row)
    }
    // Prefer the live attack's name (catches mid-war renames) over the
    // possibly-stale members.member_name.
    row.member_name = a.attacker_name ?? row.member_name
    if (isWin) {
      row.attacks += 1
      row.score     += score   // bonus-capped — what payout shares are computed from
      row.score_raw += raw     // uncapped — what Torn reports as the war score
    } else if (result === ASSIST_RESULT) {
      row.assists += 1
    } else {
      row.losses += 1
    }
  }

  // Sort: score desc, then name asc for stable display of all the 0-score
  // members at the bottom.
  return [...agg.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (a.member_name || '').localeCompare(b.member_name || '')
  })
}

/**
 * Load all faction attacks within a war's timestamp window.
 * Pages through the server-side window endpoint (faction_attacks is the
 * largest table — the API enforces pagination; a war window is bounded).
 *
 * Includes regular attacks, assists, and incoming attacks so the
 * payout formula can weight them independently.
 *
 * @param {number} startAt - War start Unix timestamp
 * @param {number} endAt   - War end Unix timestamp (0 or null = ongoing)
 * @returns {Promise<Array>}
 */
export async function loadFactionAttacksByWindow(startAt, endAt) {
  const PAGE_SIZE = 1000
  const all = []
  let offset = 0

  while (true) {
    const to = endAt && endAt > 0 ? endAt : 0
    const { attacks } = await apiGet(
      `/api/attacks?from=${startAt}&to=${to}&limit=${PAGE_SIZE}&offset=${offset}`
    )
    if (!attacks || attacks.length === 0) break
    all.push(...attacks)
    if (attacks.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}

/**
 * Load all incoming revives stored against a ranked war.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadFactionRevivesByWar(warId) {
  const { revives } = await apiGet(`/api/wars/${warId}/revives`)
  return revives || []
}

/**
 * Load saved payouts for a specific war (newest first).
 * Includes the associated member records.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadWarPayouts(warId) {
  const { payouts } = await apiGet(`/api/wars/${warId}/payouts`)
  return payouts || []
}

/**
 * Load the most recent saved payout for a war (if any).
 *
 * @param {number} warId
 * @returns {Promise<object|null>}
 */
export async function loadLatestWarPayout(warId) {
  const payouts = await loadWarPayouts(warId)
  return payouts[0] || null
}


/**
 * Load recent war payouts across all wars (for the View History panel).
 *
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
export async function loadRecentWarPayouts(limit = 20) {
  const { payouts } = await apiGet(`/api/war-payouts?limit=${limit}`)
  return payouts || []
}
