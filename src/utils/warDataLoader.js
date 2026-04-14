/**
 * War Data Loader
 * Read operations for war-related tables via Supabase anon client.
 * Write operations go through adminApi.js (Edge Function).
 */

import { supabase } from './supabase'

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
