// #965 — cross the automatic bingo squares.
//
// ⚠️ **Zero Torn calls.** Every rule reads what the dashboard already stores:
// attacks-sync's `faction_attacks`, the event's attack-log archive (#973/#974),
// Chain Watch sign-ups and the activity sampler. So it runs often and costs
// nothing; a square crosses within minutes of the data landing.
//
// ⚠️ **Only inside the event's window**, and only for squares the card marks
// `auto` with a rule. A pending proof request for a square the data then
// confirms is approved rather than duplicated.
import type pg from 'pg'
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { BONUS_CHAIN_HITS, REPEATING_CHAIN_HITS } from '../../events/bingo.js'

/**
 * Each rule: members who have done it in the window, with evidence.
 *
 * Parameters: $1 window start (epoch s), $2 window end (epoch s), $3 our
 * faction id, $4 event id, $5 the event's Chain Watch event id (or null).
 */
/**
 * ⚠️ Every rule is sent all seven parameters, and Postgres refuses a parameter
 * a statement never uses ("could not determine data type"). This prefix
 * types and uses them all, so each rule names only what it needs.
 */
const PARAMS_CTE = `WITH params AS (SELECT $1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::int[], $7::int[]) `

export const RULE_SQL: Record<string, string> = {
  ranked_war_attack: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id)) AS evidence
      FROM faction_attacks
     WHERE is_ranked_war AND attacker_faction_id = $3 AND started BETWEEN $1 AND $2
     GROUP BY 1`,
  respect_over_10: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'respect', max(respect_gain)) AS evidence
      FROM faction_attacks
     WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2 AND respect_gain > 10
       AND (chain IS NULL OR chain <> ALL($6::int[]))
     GROUP BY 1`,
  repeating_chain: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'chain', min(chain)) AS evidence
      FROM faction_attacks
     WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2 AND respect_gain > 0
       AND chain = ANY($7::int[])
     GROUP BY 1`,
  hit_over_10000: `
    SELECT member_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'hit', max(biggest_hit)) AS evidence
      FROM event_attack_log_parsed p
     WHERE event_id = $4 AND outgoing AND member_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.hit_damages) d WHERE d > 10000)
     GROUP BY 1`,
  hit_1310_1340: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id)) AS evidence
      FROM event_attack_log_parsed p
     WHERE p.event_id = $4 AND p.outgoing AND p.member_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.hit_damages) d WHERE d BETWEEN 1310 AND 1340)
     GROUP BY 1`,
  // ⚠️ "Faction family" is wider than our faction, and the dashboard does not
  // know the family. Our own faction is excluded here; a family mug still
  // crosses, and leadership can un-cross it.
  mugged_for_1: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id)) AS evidence
      FROM event_attack_log_parsed p
      JOIN faction_attacks a ON a.attack_id = p.attack_id
     WHERE p.event_id = $4 AND NOT p.outgoing AND p.member_id IS NOT NULL AND p.mug_amount = 1
       AND a.attacker_faction_id IS DISTINCT FROM $3
     GROUP BY 1`,
  bounties_over_50: `
    SELECT member_id::text AS member_id, jsonb_build_object('bounties', count(*)) AS evidence
      FROM event_attack_log_parsed
     WHERE event_id = $4 AND outgoing AND member_id IS NOT NULL AND bounty_amount IS NOT NULL
     GROUP BY 1
    HAVING count(*) > 50`,
  // Taking part means an hour you signed up for has begun, and leadership has
  // not marked it unpaid.
  chain_watch: `
    SELECT member_id AS member_id, jsonb_build_object('hours', count(*)) AS evidence
      FROM chain_watch_signups
     WHERE $5::bigint IS NOT NULL AND event_id = $5 AND removed_at IS NULL
       AND hour_start <= now() AND pay_decision IS DISTINCT FROM 'unpaid'
     GROUP BY 1`,
  travel: `
    SELECT member_id AS member_id, jsonb_build_object('seen', min(sampled_at)::text, 'state', min(status_state)) AS evidence
      FROM member_activity_samples
     WHERE sampled_at BETWEEN to_timestamp($1) AND to_timestamp($2)
       AND status_state IN ('Traveling', 'Abroad')
     GROUP BY 1`,
}

export async function eventBingoJob({ db }: JobDeps): Promise<RunResult> {
  // Events with bingo on that have started and are live, or ended within a
  // day (late scrapes still land).
  const { rows: events } = await db.query(
    `SELECT e.id, e.chain_event_id,
            extract(epoch FROM e.starts_at)::bigint AS from_s,
            extract(epoch FROM least(coalesce(e.ended_at, now()), now()))::bigint AS to_s
       FROM faction_events e
       JOIN event_bingo_cards b ON b.event_id = e.id AND b.enabled
      WHERE e.starts_at <= now()
        AND (e.ended_at IS NULL OR e.ended_at > now() - interval '1 day')`)
  if (events.length === 0) return { rows: 0, details: { events: 0 } }

  const ourFid = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id ?? 0)
  let crossed = 0
  let confirmed = 0

  for (const ev of events) {
    const { rows: tiles } = await db.query(
      `SELECT idx, rule FROM event_bingo_tiles WHERE event_id = $1 AND kind = 'auto' AND rule IS NOT NULL`, [ev.id])
    for (const t of tiles) {
      const sql = RULE_SQL[t.rule]
      if (!sql) continue
      const { rows: done } = await db.query(PARAMS_CTE + sql, [
        Number(ev.from_s), Number(ev.to_s), ourFid, Number(ev.id),
        ev.chain_event_id == null ? null : Number(ev.chain_event_id),
        BONUS_CHAIN_HITS, REPEATING_CHAIN_HITS,
      ])
      for (const d of done) {
        const memberId = String(d.member_id)
        // A waiting proof request the data now confirms: approve it.
        const up = await db.query(
          `UPDATE event_bingo_marks
              SET status = 'approved', reviewed_at = now(), evidence = $4,
                  review_note = coalesce(review_note, 'Confirmed automatically')
            WHERE event_id = $1 AND idx = $2 AND member_id = $3 AND status = 'pending'`,
          [ev.id, t.idx, memberId, d.evidence])
        if (up.rowCount) { confirmed += up.rowCount; continue }
        const ins = await db.query(
          `INSERT INTO event_bingo_marks (event_id, idx, member_id, status, source, evidence, reviewed_at)
           VALUES ($1, $2, $3, 'approved', 'auto', $4, now())
           ON CONFLICT (event_id, idx, member_id) WHERE status IN ('pending', 'approved') DO NOTHING`,
          [ev.id, t.idx, memberId, d.evidence])
        crossed += ins.rowCount ?? 0
      }
    }
  }
  return { rows: crossed + confirmed, details: { events: events.length, crossed, confirmed } }
}
