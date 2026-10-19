// The Discord bot's view of OCs (#1019, PRD #1018).
//
// Choonbot's OC board used to call Torn itself with a key of its own and judge
// CPR against a table copied out of an old config. It now reads this: the
// faction's joinable crimes and roster as the dashboard last fetched them, with
// the names, item names and each seat's published minimum CPR filled in.
//
// ⚠️ **No Torn calls here.** The crimes come from `crime-occupancy` (every
// minute) and the roster from `activity-sample` (every few minutes) — both keep
// their whole response in `torn_live_snapshots`. The payload says how old each
// is, so the bot can say so rather than present stale status as current.
//
// ⚠️ **Torn's shape, deliberately.** `crimes` and `members` are Torn's own
// objects with fields ADDED, never renamed, so the bot's alert rules — months
// of tuning, with tests — run unchanged on them. `findings` is where the
// dashboard's own suggestions arrive (#1020 onwards).
//
// ⚠️ Time leaves as epoch milliseconds for the dashboard's own stamps; Torn's
// fields (`ready_at`, `until`, `joined_at`) stay in Torn's epoch SECONDS.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { bearerFrom, tokenMatches } from './fleetMetricsAuth.js'
import { readSnapshot, SNAPSHOT_CRIMES, SNAPSHOT_MEMBERS } from './tornSnapshots.js'

/** Only these can still be joined, left, or held up by a missing member. */
const ACTIVE = new Set(['Recruiting', 'Planning'])

type CprRequirements = Record<string, { positions?: Record<string, number> }>

/** "Muscle #2" → "Muscle". */
const baseLabel = (label: string) => label.replace(/\s*#\d+\s*$/, '')

/**
 * The published minimum for one seat, or null when the faction has none.
 *
 * ⚠️ From `faction_settings.cpr_requirements` — what leadership sets in
 * Settings and the tier requirements already use — matched on the numbered
 * label first ("Picklock #2"), then the bare role ("Picklock"). The bot's old
 * fallback was a flat 75 for anything unlisted; an unlisted seat is now simply
 * not judged, because a bar nobody chose is not a bar.
 */
export function requiredCpr(reqs: CprRequirements, crimeName: string, label: string): number | null {
  const positions = reqs?.[crimeName]?.positions
  if (!positions || !label) return null
  const exact = positions[label]
  if (Number.isFinite(Number(exact)) && exact != null) return Number(exact)
  const base = positions[baseLabel(label)]
  return base != null && Number.isFinite(Number(base)) ? Number(base) : null
}

export async function collectOcWatch(db: pg.Pool, nowMs: number = Date.now()) {
  const [crimesSnap, membersSnap] = await Promise.all([
    readSnapshot<any[]>(db, SNAPSHOT_CRIMES),
    readSnapshot<any[]>(db, SNAPSHOT_MEMBERS),
  ])
  const reqRow = await db.query(`SELECT value FROM faction_settings WHERE key = 'cpr_requirements'`)
  const reqs: CprRequirements = reqRow.rows[0]?.value ?? {}

  const crimes = (crimesSnap?.payload ?? []).filter((c) => ACTIVE.has(c?.status))
  const roster = membersSnap?.payload ?? []

  // Names: the roster snapshot first (current), then the members table.
  const names = new Map<string, string>()
  for (const m of roster) if (m?.id != null && m?.name) names.set(String(m.id), String(m.name))
  const userIds = new Set<string>()
  const itemIds = new Set<string>()
  for (const c of crimes) {
    for (const s of c.slots ?? []) {
      if (s?.user?.id != null) userIds.add(String(s.user.id))
      if (s?.item_requirement?.id != null) itemIds.add(String(s.item_requirement.id))
    }
  }
  const missingNames = [...userIds].filter((id) => !names.has(id))
  if (missingNames.length) {
    const { rows } = await db.query(
      'SELECT member_id, member_name FROM members WHERE member_id = ANY($1)', [missingNames])
    for (const r of rows) if (r.member_name) names.set(String(r.member_id), r.member_name)
  }

  const itemNames = new Map<string, string>()
  const armoury = new Map<string, number>()
  if (itemIds.size) {
    const ids = [...itemIds]
    const [it, inv] = await Promise.all([
      db.query('SELECT id::text AS id, name FROM items WHERE id::text = ANY($1)', [ids]),
      db.query('SELECT id, available FROM inventory_items WHERE id = ANY($1)', [ids]),
    ])
    for (const r of it.rows) itemNames.set(r.id, r.name)
    for (const r of inv.rows) armoury.set(String(r.id), Number(r.available ?? 0))
  }

  const enriched = crimes.map((c) => ({
    ...c,
    slots: (c.slots ?? []).map((s: any) => {
      const label = s?.position_info?.label ?? s?.position ?? ''
      return {
        ...s,
        position_label: label,
        required_cpr: requiredCpr(reqs, c.name, label),
        user: s?.user ? { ...s.user, name: names.get(String(s.user.id)) ?? null } : s?.user ?? null,
        item_requirement: s?.item_requirement
          ? {
              ...s.item_requirement,
              name: itemNames.get(String(s.item_requirement.id)) ?? null,
              // How many the faction armoury holds right now (inventory sync, hourly).
              armoury_available: armoury.get(String(s.item_requirement.id)) ?? null,
            }
          : s?.item_requirement ?? null,
      }
    }),
  }))

  return {
    server_now: nowMs,
    crimes_fetched_at: crimesSnap?.fetchedAt ?? null,
    members_fetched_at: membersSnap?.fetchedAt ?? null,
    crimes: enriched,
    members: roster,
    // #1020+: the dashboard's own suggestions (swaps, joined too low, idle).
    findings: [] as unknown[],
  }
}

export function registerOcWatchInternalRoutes(app: FastifyInstance, db: pg.Pool, expectedToken: string) {
  app.get('/api/internal/oc-watch', async (req, reply) => {
    const presented = bearerFrom(req.headers.authorization)
    // One message for a missing token and a wrong one — see chainWatchInternal.
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    return collectOcWatch(db)
  })
}
