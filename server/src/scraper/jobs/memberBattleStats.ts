// Daily battle-stats sweep for OUR OWN members (#348).
//
// Runs three passes, best source first, and never downgrades a member who
// already has a better figure (see shouldReplace):
//
//   1. Torn, per member, with that member's OWN key. Exact and current.
//      /v2/user?selections=battlestats is self-only — no {id} variant — so
//      this is the only way to get an exact figure, and it needs Limited
//      access, which is our enrolment floor.
//   2. TornStats faction spy report for OUR faction, for anyone pass 1 missed
//      (no enrolled key, or their key failed).
//   3. BSP's prediction for whoever is still unknown.
//
// Daily is plenty: battle stats move slowly, and pass 1 costs one Torn call
// per enrolled member.
import type { JobDeps } from './itemsSync.js'
import { resolveSpyProviders } from '../../spyFetch.js'
import {
  parseTornBattleStats, parseTornStatsSpy, parseBspStats, storeBattleStats,
} from '../../memberBattleStats.js'

const BATTLE_STATS_PATH = '/v2/user?selections=battlestats'

export async function memberBattleStatsJob(deps: JobDeps) {
  const { db, pool, client } = deps
  let torn = 0
  let tornstats = 0
  let bsp = 0
  let failed = 0

  // Current roster only — no point spending calls on people who have left.
  const roster = await db.query(
    'SELECT member_id FROM members WHERE is_current = true AND is_fallen = false'
  )
  const rosterIds = new Set(roster.rows.map((r: any) => String(r.member_id)))
  if (rosterIds.size === 0) return { rows: 0, details: { note: 'empty roster' } }

  // ── Pass 1: each member's own key ─────────────────────────────────────
  const keys = (await pool.listKeys()).filter((k) => rosterIds.has(String(k.member_id)))
  const covered = new Set<string>()
  for (const { member_id, key } of keys) {
    try {
      const stats = parseTornBattleStats(await client.fetch(BATTLE_STATS_PATH, key))
      if (stats.total == null) { failed += 1; continue }
      if (await storeBattleStats(db, member_id, stats, 'torn')) torn += 1
      covered.add(String(member_id))
    } catch (err) {
      // One revoked key must not cost the rest of the roster its stats. The
      // member simply falls through to the spy passes below.
      failed += 1
      await storeBattleStats(
        db, member_id,
        { strength: null, defense: null, speed: null, dexterity: null, total: null },
        'torn',
        { lastError: err instanceof Error ? err.message : String(err) }
      ).catch(() => {})
    }
  }

  const remaining = [...rosterIds].filter((id) => !covered.has(id))
  const providers = await resolveSpyProviders(db, deps.spy ?? {})

  // ── Pass 2: TornStats spies for OUR faction ───────────────────────────
  if (remaining.length > 0 && providers.tsKey) {
    const usRes = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const us = Number(usRes.rows[0]?.torn_faction_id)
    if (us) {
      try {
        const base = deps.spy?.tornStatsBaseUrl ?? 'https://www.tornstats.com'
        const resp = await fetch(`${base}/api/v2/${providers.tsKey}/spy/faction/${us}`)
        const payload: any = resp.ok ? await resp.json() : null
        const entries = payload?.faction?.members
        if (entries && typeof entries === 'object') {
          for (const k of Object.keys(entries)) {
            const entry = entries[k]
            const id = String(entry?.id ?? k)
            if (!remaining.includes(id)) continue
            const parsed = parseTornStatsSpy(entry)
            if (!parsed) continue
            if (await storeBattleStats(db, id, parsed.stats, 'tornstats', { spyAt: parsed.spyAt })) {
              tornstats += 1
            }
            covered.add(id)
          }
        }
      } catch {
        // TornStats down — BSP covers whoever is left.
      }
    }
  }

  // ── Pass 3: BSP for whoever is still unknown ──────────────────────────
  const stillMissing = [...rosterIds].filter((id) => !covered.has(id))
  if (stillMissing.length > 0 && providers.bspKey) {
    const base = deps.spy?.bspBaseUrl ?? 'http://www.lol-manager.com'
    for (let i = 0; i < stillMissing.length; i++) {
      const id = stillMissing[i]
      try {
        const resp = await fetch(`${base}/api/battlestats/${providers.bspKey}/${id}/TornForge`)
        const stats = parseBspStats(await resp.json())
        if (stats && await storeBattleStats(db, id, stats, 'bsp')) bsp += 1
      } catch {
        // Per-member best-effort — an unreachable prediction just stays blank.
      }
      // BSP rate courtesy, matching the war-room spy fetch.
      if (i < stillMissing.length - 1) await new Promise((r) => setTimeout(r, 30))
    }
  }

  return {
    rows: torn + tornstats + bsp,
    details: { torn, tornstats, bsp, failed, roster: rosterIds.size },
  }
}
