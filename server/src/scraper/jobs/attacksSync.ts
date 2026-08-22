// Faction attacks sync — port of scripts/faction_attacks_update.py
// (incremental forward update). Cursor starts at the newest stored attack's
// `started` (inclusive overlap — the upsert makes re-seen rows idempotent),
// pages ASC until a page comes back under 100 rows.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const PAGE_FULL = 100
// Transient Torn errors (#247): too-many-requests (5) / IP-block (8). Hitting
// one part-way through the backlog is a soft stop, not a failure — the rows
// already upserted stay, and the next run resumes from the newest stored attack.
const RATE_LIMIT_CODES = new Set([5, 8])

export async function attacksSyncJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const config = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const us = Number(config.rows[0].torn_faction_id)

  const newest = await db.query('SELECT max(started) AS ts FROM faction_attacks')
  let from = newest.rows[0].ts != null ? Number(newest.rows[0].ts) : 0

  let rows = 0
  let pages = 0
  let rateLimited = false
  // The v2 attack payload carries each side's faction {id, name} inline. We
  // collect the distinct names across the run and upsert the `factions` lookup
  // at the end, so opposing-faction labels populate for free — no per-faction
  // /basic call. Iterating ASC means the newest name wins on a rename. The
  // hourly factions-sync still fills tags (absent from this payload) and any
  // faction we've never fought.
  const factionNames = new Map<number, string>()
  const noteFaction = (f: unknown) => {
    const faction = (f ?? {}) as { id?: unknown; name?: unknown }
    const id = Number(faction.id)
    if (Number.isFinite(id) && id > 0 && typeof faction.name === 'string' && faction.name) {
      factionNames.set(id, faction.name)
    }
  }
  for (;;) {
    let data: any
    try {
      data = await client.fetch(`/v2/faction/attacks?limit=100&sort=ASC&from=${from}`, claimed.key)
    } catch (err) {
      // A rate limit mid-backlog: stop here as a success — earlier pages are
      // already committed and the next run continues from max(started).
      if (err instanceof TornApiError && RATE_LIMIT_CODES.has(err.tornCode)) { rateLimited = true; break }
      throw err
    }
    const attacks: any[] = data.attacks ?? []
    pages += 1
    if (attacks.length === 0) break

    for (const raw of attacks) {
      // attacker is nullable (a stealthed attack has none) — raw.attacker ?? {}
      // must stay, or a NOT NULL write would start rejecting those rows.
      const attacker = raw.attacker ?? {}
      const defender = raw.defender ?? {}
      const mods = raw.modifiers ?? {}
      const attackerFactionId = attacker.faction?.id ?? null
      const defenderFactionId = defender.faction?.id ?? null
      noteFaction(attacker.faction)
      noteFaction(defender.faction)
      // chain is stored as Torn sends it, null included (#544) — see the
      // migration note; 0 is a real chain position, not "none".
      await db.query(
        `INSERT INTO faction_attacks (attack_id, code, started, ended,
           attacker_id, attacker_name, attacker_level, attacker_faction_id, attacker_faction_name,
           defender_id, defender_name, defender_level, defender_faction_id, defender_faction_name,
           result, respect_gain, respect_loss, chain,
           is_ranked_war, is_interrupted, is_stealthed, is_raid, is_territory_war, territory_war_id,
           finishing_hit_effects,
           fair_fight, war_modifier, chain_modifier, warlord_modifier,
           retaliation_modifier, group_modifier, overseas_modifier,
           is_incoming)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
         ON CONFLICT (attack_id) DO UPDATE SET
           code = EXCLUDED.code, ended = EXCLUDED.ended, result = EXCLUDED.result,
           attacker_level = EXCLUDED.attacker_level, defender_level = EXCLUDED.defender_level,
           attacker_faction_name = EXCLUDED.attacker_faction_name,
           defender_faction_name = EXCLUDED.defender_faction_name,
           respect_gain = EXCLUDED.respect_gain, respect_loss = EXCLUDED.respect_loss,
           chain = EXCLUDED.chain,
           is_ranked_war = EXCLUDED.is_ranked_war, is_interrupted = EXCLUDED.is_interrupted,
           is_stealthed = EXCLUDED.is_stealthed, is_raid = EXCLUDED.is_raid,
           is_territory_war = EXCLUDED.is_territory_war, territory_war_id = EXCLUDED.territory_war_id,
           finishing_hit_effects = EXCLUDED.finishing_hit_effects,
           fair_fight = EXCLUDED.fair_fight, war_modifier = EXCLUDED.war_modifier,
           chain_modifier = EXCLUDED.chain_modifier, warlord_modifier = EXCLUDED.warlord_modifier,
           retaliation_modifier = EXCLUDED.retaliation_modifier, group_modifier = EXCLUDED.group_modifier,
           overseas_modifier = EXCLUDED.overseas_modifier, is_incoming = EXCLUDED.is_incoming`,
        [raw.id, raw.code ?? null, raw.started ?? null, raw.ended ?? null,
         attacker.id ?? null, attacker.name ?? null, attacker.level ?? null,
         attackerFactionId, attacker.faction?.name ?? null,
         defender.id ?? null, defender.name ?? null, defender.level ?? null,
         defenderFactionId, defender.faction?.name ?? null,
         raw.result ?? null, raw.respect_gain ?? 0, raw.respect_loss ?? 0, raw.chain ?? null,
         raw.is_ranked_war ?? false, raw.is_interrupted ?? false, raw.is_stealthed ?? false,
         raw.is_raid ?? false, raw.is_territory_war ?? false, raw.territory_war_id ?? null,
         raw.finishing_hit_effects ? JSON.stringify(raw.finishing_hit_effects) : null,
         mods.fair_fight ?? 1, mods.war ?? 1, mods.chain ?? 1, mods.warlord ?? 1,
         mods.retaliation ?? 1, mods.group ?? 1, mods.overseas ?? 1,
         defenderFactionId === us]
      )
      rows += 1
    }

    if (attacks.length < PAGE_FULL) break
    from = attacks[attacks.length - 1].started ?? from
  }

  // Upsert the collected faction names. Name only — tag isn't in this payload,
  // so ON CONFLICT leaves any tag that factions-sync already resolved intact.
  for (const [id, name] of factionNames) {
    await db.query(
      `INSERT INTO factions (id, name, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [id, name]
    )
  }

  return { rows, details: { pages, rate_limited: rateLimited, factions: factionNames.size } }
}
