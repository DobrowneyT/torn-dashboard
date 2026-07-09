// Faction attacks sync — port of scripts/faction_attacks_update.py
// (incremental forward update). Cursor starts at the newest stored attack's
// `started` (inclusive overlap — the upsert makes re-seen rows idempotent),
// pages ASC until a page comes back under 100 rows.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const PAGE_FULL = 100

export async function attacksSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const us = Number(config.rows[0].torn_faction_id)

  const newest = await db.query('SELECT max(started) AS ts FROM faction_attacks')
  let from = newest.rows[0].ts != null ? Number(newest.rows[0].ts) : 0

  let rows = 0
  let pages = 0
  for (;;) {
    const data = await client.fetch(`/v2/faction/attacks?limit=100&sort=ASC&from=${from}`, claimed.key)
    const attacks: any[] = data.attacks ?? []
    pages += 1
    if (attacks.length === 0) break

    for (const raw of attacks) {
      const attacker = raw.attacker ?? {}
      const defender = raw.defender ?? {}
      const mods = raw.modifiers ?? {}
      const attackerFactionId = attacker.faction?.id ?? null
      const defenderFactionId = defender.faction?.id ?? null
      await db.query(
        `INSERT INTO faction_attacks (attack_id, started, ended, attacker_id, attacker_name,
           attacker_faction_id, defender_id, defender_name, defender_faction_id, result,
           respect_gain, chain, is_ranked_war, fair_fight, war_modifier, chain_modifier,
           warlord_modifier, is_incoming)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (attack_id) DO UPDATE SET
           ended = EXCLUDED.ended, result = EXCLUDED.result,
           respect_gain = EXCLUDED.respect_gain, chain = EXCLUDED.chain,
           is_ranked_war = EXCLUDED.is_ranked_war, fair_fight = EXCLUDED.fair_fight,
           war_modifier = EXCLUDED.war_modifier, chain_modifier = EXCLUDED.chain_modifier,
           warlord_modifier = EXCLUDED.warlord_modifier, is_incoming = EXCLUDED.is_incoming`,
        [raw.id, raw.started ?? null, raw.ended ?? null, attacker.id ?? null, attacker.name ?? null,
         attackerFactionId, defender.id ?? null, defender.name ?? null, defenderFactionId,
         raw.result ?? null, raw.respect_gain ?? 0, raw.chain ?? 0, raw.is_ranked_war ?? false,
         mods.fair_fight ?? 1, mods.war ?? 1, mods.chain ?? 1, mods.warlord ?? 1,
         defenderFactionId === us]
      )
      rows += 1
    }

    if (attacks.length < PAGE_FULL) break
    from = attacks[attacks.length - 1].started ?? from
  }

  return { rows, details: { pages } }
}
