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
      const attacker = raw.attacker ?? {}
      const defender = raw.defender ?? {}
      const mods = raw.modifiers ?? {}
      const attackerFactionId = attacker.faction?.id ?? null
      const defenderFactionId = defender.faction?.id ?? null
      noteFaction(attacker.faction)
      noteFaction(defender.faction)
      await db.query(
        `INSERT INTO faction_attacks (attack_id, started, ended, attacker_id, attacker_name,
           attacker_faction_id, attacker_faction_name, defender_id, defender_name,
           defender_faction_id, defender_faction_name, result,
           respect_gain, chain, is_ranked_war, fair_fight, war_modifier, chain_modifier,
           warlord_modifier, is_incoming)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (attack_id) DO UPDATE SET
           ended = EXCLUDED.ended, result = EXCLUDED.result,
           attacker_faction_name = EXCLUDED.attacker_faction_name,
           defender_faction_name = EXCLUDED.defender_faction_name,
           respect_gain = EXCLUDED.respect_gain, chain = EXCLUDED.chain,
           is_ranked_war = EXCLUDED.is_ranked_war, fair_fight = EXCLUDED.fair_fight,
           war_modifier = EXCLUDED.war_modifier, chain_modifier = EXCLUDED.chain_modifier,
           warlord_modifier = EXCLUDED.warlord_modifier, is_incoming = EXCLUDED.is_incoming`,
        [raw.id, raw.started ?? null, raw.ended ?? null, attacker.id ?? null, attacker.name ?? null,
         attackerFactionId, attacker.faction?.name ?? null, defender.id ?? null, defender.name ?? null,
         defenderFactionId, defender.faction?.name ?? null,
         raw.result ?? null, raw.respect_gain ?? 0, raw.chain ?? 0, raw.is_ranked_war ?? false,
         mods.fair_fight ?? 1, mods.war ?? 1, mods.chain ?? 1, mods.warlord ?? 1,
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
