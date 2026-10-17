// #974 — runs the parser over archived logs and stores what it read.
//
// ⚠️ Idempotent and re-runnable over the whole archive: one parsed row per
// attack (upserted) and its effect rows replaced wholesale, in one
// transaction. A log is due when it has never been parsed, or was parsed by an
// older PARSER_VERSION — which is how the treat parser (#975) will re-read
// everything archived before it existed.
import type pg from 'pg'
import { parseAttackLog, PARSER_VERSION } from './attackLogParser.js'

/** Most logs parsed per call — keeps one archiver run short. */
export const PARSE_BATCH = 500

export async function parsePendingLogs(db: pg.Pool, us: number, limit = PARSE_BATCH): Promise<number> {
  const due = await db.query(
    `SELECT l.attack_id, l.event_id, l.raw, a.attacker_id, a.defender_id, a.attacker_faction_id,
            a.defender_faction_id, a.started
       FROM event_attack_logs l
       JOIN faction_attacks a ON a.attack_id = l.attack_id
       LEFT JOIN event_attack_log_parsed p ON p.attack_id = l.attack_id
      WHERE l.status = 'archived' AND (p.attack_id IS NULL OR p.parser_version < $1)
      ORDER BY l.attack_id
      LIMIT $2`,
    [PARSER_VERSION, limit],
  )
  for (const r of due.rows) {
    const outgoing = Number(r.attacker_faction_id) === us
    const attacker = r.attacker_id == null ? null : Number(r.attacker_id)
    const defender = r.defender_id == null ? null : Number(r.defender_id)
    const p = parseAttackLog(r.raw, {
      attacker_id: attacker, defender_id: defender, outgoing,
      member_id: outgoing ? attacker : defender,
    })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO event_attack_log_parsed
           (attack_id, event_id, parser_version, member_id, outgoing, mug_amount, respect, damage_dealt,
            damage_taken, hits, misses, hit_damages, biggest_hit, started, bounty_amount, parsed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
         ON CONFLICT (attack_id) DO UPDATE SET
           parser_version = EXCLUDED.parser_version, member_id = EXCLUDED.member_id,
           outgoing = EXCLUDED.outgoing, mug_amount = EXCLUDED.mug_amount, respect = EXCLUDED.respect,
           damage_dealt = EXCLUDED.damage_dealt, damage_taken = EXCLUDED.damage_taken, hits = EXCLUDED.hits,
           misses = EXCLUDED.misses, hit_damages = EXCLUDED.hit_damages, biggest_hit = EXCLUDED.biggest_hit,
           started = EXCLUDED.started, bounty_amount = EXCLUDED.bounty_amount, parsed_at = now()`,
        [r.attack_id, r.event_id, PARSER_VERSION, outgoing ? attacker : defender, outgoing, p.mug_amount,
          p.respect, p.damage_dealt, p.damage_taken, p.hits, p.misses, p.hit_damages, p.biggest_hit, r.started, p.bounty_amount],
      )
      await client.query('DELETE FROM event_attack_log_effects WHERE attack_id = $1', [r.attack_id])
      for (const e of p.effects) {
        await client.query(
          `INSERT INTO event_attack_log_effects (attack_id, seq, event_id, actor_id, effect, text, started)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.attack_id, e.seq, r.event_id, e.actor_id, e.effect, e.text, r.started],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
  return due.rows.length
}
