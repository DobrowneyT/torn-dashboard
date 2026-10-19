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
import { BONUS_CHAIN_HITS, REPEATING_CHAIN_HITS, WIN_RESULTS } from '../../events/bingo.js'

/**
 * Each rule: members who have done it in the window, with evidence.
 *
 * Parameters: $1 window start (epoch s), $2 window end (epoch s), $3 our
 * faction id, $4 event id, $5 the event's Chain Watch event id (or null),
 * $6 bonus chain counts, $7 repeating chain counts, $8 the square's params
 * (jsonb), $9 the results that count as wins.
 */
/**
 * ⚠️ Every rule is sent all nine parameters, and Postgres refuses a parameter
 * a statement never uses ("could not determine data type"). This prefix types
 * and uses them all, so each rule names only what it needs.
 */
const PARAMS_CTE = `WITH params AS (SELECT $1::bigint, $2::bigint, $3::bigint, $4::bigint, $5::bigint,
  $6::int[], $7::int[], $8::jsonb, $9::text[]) `

/** Our member's outgoing WINS inside the window. */
const WINS = `
  FROM faction_attacks
 WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2 AND result = ANY($9)`

export const RULE_SQL: Record<string, string> = {
  ranked_war_attack: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id)) AS evidence
      FROM faction_attacks
     WHERE is_ranked_war AND attacker_faction_id = $3 AND started BETWEEN $1 AND $2
     GROUP BY 1`,
  respect_at_least: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'respect', max(respect_gain)) AS evidence
      FROM faction_attacks
     WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2
       AND respect_gain >= ($8->>'min')::numeric
       AND (chain IS NULL OR chain <> ALL($6::int[]))
     GROUP BY 1`,
  repeating_chain: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'chain', min(chain)) AS evidence
      FROM faction_attacks
     WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2 AND respect_gain > 0
       AND chain = ANY($7::int[])
     GROUP BY 1`,
  // MonChoon (2026-10-19): hit counts are WINS only.
  wins_over: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('wins', count(*)) AS evidence
    ${WINS}
     GROUP BY 1
    HAVING count(*) > ($8->>'count')::int`,
  // The nth win minus the (n-COUNT+1)th: the span of COUNT consecutive wins.
  wins_in_window: `
    SELECT member_id, jsonb_build_object('seconds', min(span), 'attack_id', min(attack_id)) AS evidence
      FROM (SELECT attacker_id::text AS member_id, attack_id,
                   started - lag(started, greatest(($8->>'count')::int - 1, 0))
                     OVER (PARTITION BY attacker_id ORDER BY started, attack_id) AS span
            ${WINS}) x
     WHERE span IS NOT NULL AND span <= ($8->>'seconds')::int
     GROUP BY 1`,
  retal: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id)) AS evidence
    ${WINS} AND retaliation_modifier > 1
     GROUP BY 1`,
  // ⚠️ Early Discharge is NOT in any attack data Torn returns. This rule is
  // "abroad + hospitalized" only; the card's ED condition stays a proof square.
  overseas_hosp: `
    SELECT attacker_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id)) AS evidence
      FROM faction_attacks
     WHERE attacker_faction_id = $3 AND started BETWEEN $1 AND $2
       AND overseas_modifier > 1 AND result = 'Hospitalized'
     GROUP BY 1`,
  hit_over: `
    SELECT member_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'hit', max(biggest_hit)) AS evidence
      FROM event_attack_log_parsed p
     WHERE event_id = $4 AND outgoing AND member_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.hit_damages) d WHERE d > ($8->>'min')::int)
     GROUP BY 1`,
  hit_between: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id)) AS evidence
      FROM event_attack_log_parsed p
     WHERE p.event_id = $4 AND p.outgoing AND p.member_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.hit_damages) d WHERE d BETWEEN ($8->>'min')::int AND ($8->>'max')::int)
     GROUP BY 1`,
  hit_exact: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id)) AS evidence
      FROM event_attack_log_parsed p
     WHERE p.event_id = $4 AND p.outgoing AND p.member_id IS NOT NULL
       AND ($8->>'value')::int = ANY(p.hit_damages)
     GROUP BY 1`,
  mug_over: `
    SELECT member_id::text AS member_id, jsonb_build_object('attack_id', min(attack_id), 'mug', max(mug_amount)) AS evidence
      FROM event_attack_log_parsed
     WHERE event_id = $4 AND outgoing AND member_id IS NOT NULL AND mug_amount > ($8->>'min')::numeric
     GROUP BY 1`,
  // MonChoon (2026-10-19): only our own faction is excluded, not the wider family.
  mugged_for_1: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id)) AS evidence
      FROM event_attack_log_parsed p
      JOIN faction_attacks a ON a.attack_id = p.attack_id
     WHERE p.event_id = $4 AND NOT p.outgoing AND p.member_id IS NOT NULL AND p.mug_amount = 1
       AND a.attacker_faction_id IS DISTINCT FROM $3
     GROUP BY 1`,
  bounties_at_least: `
    SELECT member_id::text AS member_id, jsonb_build_object('bounties', count(*)) AS evidence
      FROM event_attack_log_parsed
     WHERE event_id = $4 AND outgoing AND member_id IS NOT NULL AND bounty_amount IS NOT NULL
     GROUP BY 1
    HAVING count(*) >= ($8->>'count')::int`,
  // Someone hospitalizes a member and claims a bounty — seen in OUR member's
  // log of that attack — and a member later beats them. MonChoon: both inside
  // the event window.
  avenge_bounty: `
    SELECT o.attacker_id::text AS member_id,
           jsonb_build_object('attack_id', min(o.attack_id), 'claimer', min(c.attacker_id)) AS evidence
      FROM event_attack_log_parsed p
      JOIN faction_attacks c ON c.attack_id = p.attack_id
      JOIN faction_attacks o ON o.defender_id = c.attacker_id AND o.started > c.started
     WHERE p.event_id = $4 AND NOT p.outgoing AND p.bounty_amount IS NOT NULL
       AND c.attacker_faction_id IS DISTINCT FROM $3
       AND o.attacker_faction_id = $3 AND o.started <= $2 AND o.result = ANY($9)
     GROUP BY 1`,
  // ⚠️ Revitalize procs at most once, at the end of a win (MonChoon,
  // 2026-10-19), so the square is a STREAK: COUNT of the member's attacks in a
  // row, each with a proc. Gaps-and-islands over the archived logs.
  revitalize_streak: `
    SELECT member_id::text AS member_id, jsonb_build_object('streak', max(n)) AS evidence
      FROM (SELECT member_id, grp, count(*) AS n
              FROM (SELECT member_id, proc,
                           row_number() OVER (PARTITION BY member_id ORDER BY started, attack_id)
                         - row_number() OVER (PARTITION BY member_id, proc ORDER BY started, attack_id) AS grp
                      FROM (SELECT p.member_id, p.started, p.attack_id,
                                   EXISTS (SELECT 1 FROM event_attack_log_effects e
                                            WHERE e.attack_id = p.attack_id AND e.actor_id = p.member_id
                                              AND e.effect ILIKE '%revital%') AS proc
                              FROM event_attack_log_parsed p
                             WHERE p.event_id = $4 AND p.outgoing AND p.member_id IS NOT NULL) s) t
             WHERE proc
             GROUP BY member_id, grp) runs
     GROUP BY member_id
    HAVING max(n) >= ($8->>'count')::int`,
  loot_from: `
    SELECT p.member_id::text AS member_id, jsonb_build_object('attack_id', min(p.attack_id), 'from', min(a.defender_id)) AS evidence
      FROM event_attack_log_effects e
      JOIN event_attack_log_parsed p ON p.attack_id = e.attack_id AND e.actor_id = p.member_id
      JOIN faction_attacks a ON a.attack_id = e.attack_id
     WHERE p.event_id = $4 AND p.outgoing AND e.effect = 'loot'
       AND a.defender_id = ANY (SELECT jsonb_array_elements_text($8->'ids')::int)
     GROUP BY 1`,
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
      `SELECT idx, rule, params FROM event_bingo_tiles WHERE event_id = $1 AND kind = 'auto' AND rule IS NOT NULL`, [ev.id])
    for (const t of tiles) {
      const sql = RULE_SQL[t.rule]
      if (!sql) continue
      const { rows: done } = await db.query(PARAMS_CTE + sql, [
        Number(ev.from_s), Number(ev.to_s), ourFid, Number(ev.id),
        ev.chain_event_id == null ? null : Number(ev.chain_event_id),
        BONUS_CHAIN_HITS, REPEATING_CHAIN_HITS, t.params ?? {}, WIN_RESULTS,
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
