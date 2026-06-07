/**
 * War Data Loader
 * Read operations for war-related tables via Supabase anon client.
 * Write operations go through adminApi.js (Edge Function).
 */

import { supabase } from './supabase'
import { BONUS_HITS, WIN_RESULTS } from './warPayoutCalculations'

const OUR_FACTION_ID = 10739

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

  const { data, error } = await supabase
    .from('factions')
    .select('id, name, tag')
    .in('id', ids)

  if (error) throw error
  const map = new Map()
  for (const row of data || []) map.set(Number(row.id), row)
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
  const { data, error } = await supabase
    .from('ranked_wars')
    .select('*')
    .order('start_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw error
  return data || []
}

/**
 * Load the total count of ranked wars (for pagination).
 *
 * @returns {Promise<number>}
 */
export async function loadWarsCount() {
  const { count, error } = await supabase
    .from('ranked_wars')
    .select('*', { count: 'exact', head: true })

  if (error) throw error
  return count || 0
}

/**
 * Load a single war by ID.
 *
 * @param {number} warId
 * @returns {Promise<object|null>}
 */
export async function loadWar(warId) {
  const { data, error } = await supabase
    .from('ranked_wars')
    .select('*')
    .eq('id', warId)
    .single()

  if (error) throw error
  return data
}

/**
 * Load per-member contributions for a war.
 * Returns both our faction members and opponent members.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadWarContributions(warId) {
  const { data, error } = await supabase
    .from('war_member_contributions')
    .select('*')
    .eq('war_id', warId)
    .order('score', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Build a live leaderboard for an ongoing (or just-ended) ranked war by
 * aggregating faction_attacks rows in the war's [start_at, end_at] window
 * directly — the war_member_contributions table is only populated after a
 * war is fully reported by Torn (often hours after a win/forfeit), so this
 * is the only way to show a current scoreboard while a war is still live.
 *
 * The leaderboard is seeded from `members` (is_current = true) so every
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

  // Seed: every current faction member starts at 0. Fall back gracefully
  // if the members table read fails so the leaderboard still works in
  // attack-only mode.
  const agg = new Map()
  try {
    const { data: members, error } = await supabase
      .from('members')
      .select('member_id, member_name')
      .eq('is_current', true)
    if (!error && members) {
      for (const m of members) {
        const id = Number(m.member_id)
        if (!id) continue
        agg.set(id, {
          member_id:   id,
          member_name: m.member_name,
          level:       null,
          attacks:     0,
          score:       0,
          faction_id:  OUR_FACTION_ID,
        })
      }
    }
  } catch (e) {
    console.warn('[live leaderboard] members seed failed; continuing attack-only:', e)
  }

  // Page through faction_attacks in the war window.
  const PAGE_SIZE = 1000
  const all = []
  let offset = 0
  while (true) {
    let q = supabase
      .from('faction_attacks')
      .select('attacker_id, attacker_name, respect_gain, chain')
      .eq('attacker_faction_id', OUR_FACTION_ID)
      .eq('is_ranked_war', true)
      .eq('is_incoming', false)
      .in('result', [...WIN_RESULTS])
      .gte('started', war.start_at)
      .range(offset, offset + PAGE_SIZE - 1)

    if (war.end_at && war.end_at > 0) q = q.lte('started', war.end_at)

    const { data, error } = await q
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  // Aggregate per attacker with bonus-hit cap. If an attacker isn't in the
  // members seed (mid-war joiner, recently left, or members table was stale),
  // create their row on the fly using the attack's attacker_name.
  for (const a of all) {
    const id = Number(a.attacker_id)
    if (!id) continue
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
        score:       0,
        faction_id:  OUR_FACTION_ID,
      }
      agg.set(id, row)
    }
    // Prefer the live attack's name (catches mid-war renames) over the
    // possibly-stale members.member_name.
    row.member_name = a.attacker_name ?? row.member_name
    row.attacks += 1
    row.score   += score
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
 * Queries faction_attacks (daily-scraped, no war_id FK) filtered by
 * started >= startAt AND started <= endAt.
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
    let query = supabase
      .from('faction_attacks')
      .select('*')
      .gte('started', startAt)
      .order('started', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (endAt && endAt > 0) {
      query = query.lte('started', endAt)
    }

    const { data, error } = await query
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}

/**
 * Load all incoming revives stored against a ranked war (faster than a
 * window query thanks to the (rw_id, timestamp) index on faction_revives).
 * Pages through PostgREST's default 1000-row response cap.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadFactionRevivesByWar(warId) {
  const PAGE_SIZE = 1000
  const all = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('faction_revives')
      .select('*')
      .eq('rw_id', warId)
      .order('timestamp', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all.push(...data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return all
}

/**
 * Load saved payouts for a specific war (newest first).
 * Includes the associated member records.
 *
 * @param {number} warId
 * @returns {Promise<Array>}
 */
export async function loadWarPayouts(warId) {
  const { data, error } = await supabase
    .from('war_payouts')
    .select('*, war_payout_members(*)')
    .eq('war_id', warId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data || []
}

/**
 * Load the most recent saved payout for a war (if any).
 *
 * @param {number} warId
 * @returns {Promise<object|null>}
 */
export async function loadLatestWarPayout(warId) {
  const { data, error } = await supabase
    .from('war_payouts')
    .select('*, war_payout_members(*)')
    .eq('war_id', warId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') throw error  // PGRST116 = no rows found
  return data || null
}


/**
 * Load recent war payouts across all wars (for the View History panel).
 *
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
export async function loadRecentWarPayouts(limit = 20) {
  const { data, error } = await supabase
    .from('war_payouts')
    .select('*, war_payout_members(*)')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data || []
}
