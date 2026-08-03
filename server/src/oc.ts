// OC read surface: crimes history, slots, roster lookup, faction OC policy,
// live Torn crimes proxy, and the role-gated planner bundle.
import { TORN_API_COMMENT } from './tornComment.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'
import { claimPooledKey, EMPTY_POOL_MESSAGE } from './scraper/keyPool.js'

export interface OcDeps {
  db: pg.Pool
  tornBaseUrl: string
  /** Key-at-rest secret — server-side Torn reads claim from the pool (#98). */
  encryptionKey?: string
}

async function fetchLiveCrimes(deps: OcDeps): Promise<
  | { ok: true; payload: unknown }
  | { ok: false; status: number; error: string }
> {
  const claimed = await claimPooledKey(deps.db, deps.encryptionKey)
  if (!claimed) return { ok: false, status: 503, error: EMPTY_POOL_MESSAGE }
  const url = new URL('/v2/faction/crimes', deps.tornBaseUrl)
  url.searchParams.set('cat', 'available')
  url.searchParams.set('sort', 'ASC')
  url.searchParams.set('key', claimed.key)
  url.searchParams.set('comment', TORN_API_COMMENT)
  let data: any
  try {
    const resp = await fetch(url)
    if (!resp.ok) return { ok: false, status: 502, error: 'Torn API request failed' }
    data = await resp.json()
  } catch {
    return { ok: false, status: 502, error: 'Torn API request failed' }
  }
  if (data.error) return { ok: false, status: 502, error: `Torn API error: ${data.error.error}` }
  return { ok: true, payload: data }
}

async function fetchRoster(db: pg.Pool) {
  const res = await db.query(`
    SELECT member_id, member_name, tier, tier_override, is_current
    FROM members ORDER BY member_id
  `)
  return res.rows
}

export function registerOcRoutes(app: FastifyInstance, deps: OcDeps) {
  app.get('/api/crimes', { preHandler: requireAuth() }, async (req) => {
    const q = req.query as { limit?: string; offset?: string }
    const limit = clamp(q.limit, 1000, 2000)
    const offset = Math.max(0, Number(q.offset) || 0)
    const res = await deps.db.query(
      `SELECT * FROM crimes ORDER BY created_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
      [limit, offset]
    )
    return { crimes: res.rows }
  })

  app.get('/api/crimes/current', { preHandler: requireAuth() }, async (_req, reply) => {
    const live = await fetchLiveCrimes(deps)
    if (!live.ok) return reply.status(live.status).send({ error: live.error })
    return live.payload
  })

  app.get('/api/crimes/:id/slots', { preHandler: requireAuth() }, async (req) => {
    const { id } = req.params as { id: string }
    const res = await deps.db.query(
      `SELECT s.user_id,
              COALESCE(s.user_name, m.member_name) AS user_name,
              s."position", s.position_number, s.checkpoint_pass_rate
       FROM crime_slots s
       LEFT JOIN members m ON m.member_id = s.user_id
       WHERE s.crime_id = $1 AND s.user_id IS NOT NULL
       ORDER BY s.position_number NULLS LAST, s."position"`,
      [id]
    )
    return { slots: res.rows }
  })

  app.get('/api/members/roster', { preHandler: requireAuth() }, async () => {
    return { roster: await fetchRoster(deps.db) }
  })

  app.get('/api/oc-config', { preHandler: requireAuth() }, async () => {
    const res = await deps.db.query(
      `SELECT key, value FROM faction_settings
       WHERE key IN ('tier_requirements', 'cpr_requirements', 'payout_tickets', 'payout_mode')`
    )
    const settings = Object.fromEntries(res.rows.map((r) => [r.key, r.value]))
    return {
      tier_requirements: settings.tier_requirements ?? {},
      cpr_requirements: settings.cpr_requirements ?? {},
      payout_tickets: settings.payout_tickets ?? {},
      // Faction default payout mode (#134); absent → flat-weighted (the Settings
      // editor to write this lands in #136). Stored as a plain jsonb string.
      payout_mode: settings.payout_mode ?? null,
    }
  })

  // Everything the OC planner needs, in one role-gated call.
  app.get(
    '/api/oc-planner/data',
    { preHandler: requireRole('ocmanager', 'leadership', 'admin', 'visitor') },
    async (_req, reply) => {
      const live = await fetchLiveCrimes(deps)
      if (!live.ok) return reply.status(live.status).send({ error: live.error })

      const roster = await fetchRoster(deps.db)
      const t3Ids = roster
        .filter((m) => (m.tier_override ?? m.tier ?? 6) === 3)
        .map((m) => m.member_id)

      const t3Cpr: Record<string, Record<string, number>> = {}
      if (t3Ids.length > 0) {
        const cpr = await deps.db.query(
          `SELECT member_id, crime_name, position_label, cpr_value
           FROM member_cpr_v2 WHERE member_id = ANY($1)`,
          [t3Ids]
        )
        for (const row of cpr.rows) {
          ;(t3Cpr[row.member_id] ??= {})[`${row.crime_name}||${row.position_label}`] = Number(row.cpr_value)
        }
      }

      return { live_crimes: live.payload, roster, t3_cpr: t3Cpr }
    }
  )
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}
