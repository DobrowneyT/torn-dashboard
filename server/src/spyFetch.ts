// Spy-stat enrichment core (#100/#139). Extracted from the war-room-setup
// fetch-spies route so both the manual endpoint and the weekly war-lifecycle
// automation share one code path. TornStats faction spies first (they carry a
// real capture time → ts_spy_at), BSP for anyone TornStats didn't cover;
// bsp_* holds whichever source's values, spy_source records the provenance.
import type pg from 'pg'
import { createSecretStore } from './secrets.js'
import {
  fetchTornStatsFaction, readTornStatsFaction, fetchBspStats, BSP_SPACING_MS,
} from './spyProviders.js'

export interface SpyProviderDeps {
  encryptionKey?: string
  tornStatsApiKey?: string
  bspApiKey?: string
  tornStatsBaseUrl?: string
  bspBaseUrl?: string
}

export interface SpyProviders {
  tsKey: string | null
  bspKey: string | null
  tornStatsBaseUrl?: string
  bspBaseUrl?: string
}

/**
 * Resolve spy-stat provider keys: the faction's own stored secrets (#105, set
 * in Global Admin) take precedence over the deprecated operator-wide env vars.
 * Base URLs are injectable for the test fixture.
 */
export async function resolveSpyProviders(db: pg.Pool, deps: SpyProviderDeps): Promise<SpyProviders> {
  let tsKey = deps.tornStatsApiKey ?? null
  let bspKey = deps.bspApiKey ?? null
  if (deps.encryptionKey) {
    try {
      const store = createSecretStore({ db, encryptionKey: deps.encryptionKey })
      tsKey = (await store.get('tornstats_api_key')) ?? tsKey
      bspKey = (await store.get('bsp_api_key')) ?? bspKey
    } catch {
      // Malformed at-rest key — fall back to env.
    }
  }
  return { tsKey, bspKey, tornStatsBaseUrl: deps.tornStatsBaseUrl, bspBaseUrl: deps.bspBaseUrl }
}

export type SpyFetchResult =
  | { ok: true; fetched: number; tornstats: number; bsp: number; requested: number }
  | { ok: false; reason: 'no_provider' | 'no_members' }

/**
 * Fill spy stats for a set of war-room member ids. Writes bsp_* / spy_source /
 * ts_spy_at on war_room_state_v2 and returns per-source counts. Free of HTTP
 * framing and WS broadcasting — the caller decides how to report/broadcast.
 */
export async function fetchSpiesForMembers(args: {
  db: pg.Pool
  memberIds: number[]
  providers: SpyProviders
}): Promise<SpyFetchResult> {
  const { db, providers } = args
  const ids = args.memberIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length === 0) return { ok: false, reason: 'no_members' }
  const { tsKey, bspKey } = providers
  if (!tsKey && !bspKey) return { ok: false, reason: 'no_provider' }

  const ourId = Number(
    (await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0].torn_faction_id
  )
  const nowIso = new Date().toISOString()
  let tornstatsFilled = 0
  let needBsp = ids.slice()

  // ── Pass 1: TornStats faction spies ───────────────────────────────────
  const enemySample = await db.query(
    `SELECT faction_id FROM war_room_state_v2
     WHERE member_id = ANY($1) AND faction_id <> $2 AND deleted_at IS NULL LIMIT 1`,
    [ids, ourId]
  )
  const enemyFactionId = enemySample.rows[0]?.faction_id ?? null

  if (tsKey && enemyFactionId) {
    const cfg = await db.query('SELECT tornstats_max_age_days FROM war_room_config_v2 WHERE id = 1')
    const maxAgeDays = Number(cfg.rows[0]?.tornstats_max_age_days ?? 0)
    const minTimestamp = maxAgeDays > 0
      ? Math.floor((Date.now() - maxAgeDays * 86_400_000) / 1000)
      : 0

    // ⚠️ Fetch and parse live in `spyProviders.ts` so the Book of Grudges can
    // use the same "TornStats first, BSP for the rest" logic against its own
    // table (#889 slice 5). Only the WRITE below is war-room-specific.
    const spies = await fetchTornStatsFaction(
      tsKey, enemyFactionId, providers.tornStatsBaseUrl
    )
    const readings = readTornStatsFaction(spies, new Set(ids), minTimestamp)

    for (const [id, r] of readings) {
      await db.query(
        `UPDATE war_room_state_v2 SET
           bsp_total = $2, bsp_str = $3, bsp_spd = $4, bsp_def = $5, bsp_dex = $6,
           bsp_fetched_at = $7, spy_source = 'tornstats', ts_spy_at = $8, updated_at = now()
         WHERE member_id = $1`,
        [id, r.total, r.str, r.spd, r.def, r.dex, nowIso, r.spiedAt?.toISOString() ?? null]
      )
    }
    tornstatsFilled = readings.size
    needBsp = ids.filter((id) => !readings.has(id))
  }

  // ── Pass 2: BSP for the rest ──────────────────────────────────────────
  let bspFilled = 0
  if (bspKey) {
    for (let i = 0; i < needBsp.length; i++) {
      const id = needBsp[i]
      // Per-member best-effort — a dead BSP row just stays unspied.
      const r = await fetchBspStats(bspKey, id, providers.bspBaseUrl)
      if (r) {
        await db.query(
          `UPDATE war_room_state_v2 SET
             bsp_total = $2, bsp_str = $3, bsp_spd = $4, bsp_def = $5, bsp_dex = $6,
             bsp_fetched_at = $7, spy_source = 'bsp', ts_spy_at = NULL, updated_at = now()
           WHERE member_id = $1`,
          [id, r.total, r.str, r.spd, r.def, r.dex, nowIso]
        )
        bspFilled += 1
      }
      if (i < needBsp.length - 1) await new Promise((res) => setTimeout(res, BSP_SPACING_MS))
    }
  }

  return { ok: true, fetched: tornstatsFilled + bspFilled, tornstats: tornstatsFilled, bsp: bspFilled, requested: ids.length }
}
