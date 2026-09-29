// The Discord bot's view of a war's overview (#811).
//
// One read-only endpoint, called by `torn-discord-bot` for `/rw-overview`, so
// the embed in Discord and the page at /war-overview are the same facts.
//
// ⚠️ **The numbers come from `warOverview/summary.ts`, never from SQL.** A
// third implementation of "what counts as an attack" is exactly what this repo
// has been paying for all week; the SQL here selects rows and nothing else,
// and `test/war-overview-parity.test.ts` holds the TS port level with the page.
//
// ⚠️ **Time leaves here as epoch milliseconds**, and `faction_attacks.started`
// / `faction_revives.timestamp` are already epoch SECONDS in the database.
// Postgres serves timestamptz with a bare two-digit offset ("...-05") which
// `new Date` parses to NaN and Python's `datetime.fromisoformat` rejects — the
// trap that took the chain sampler down for two days. Only the war window's
// own bounds need converting, and that happens in SQL.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { bearerFrom, tokenMatches } from './fleetMetricsAuth.js'
import { summariseWindow, factionKey, NO_FACTION_ID } from './warOverview/summary.js'
import { buildChart } from './warOverview/series.js'

/** How many wars the picker offers. Enough for a season, not the whole history. */
export const RECENT_WARS = 25

export interface WarOverviewQuery {
  war?: string
  mode?: string
  member?: string
  /** '1'/'true' → restrict to us + the opponent, excluding (no faction). */
  warring_only?: string
  /** '1'/'true' → include the pre-binned series for the bot's chart. */
  chart?: string
}

const truthy = (v: string | undefined) => v === '1' || v === 'true'

export async function collectWarOverview(
  db: pg.Pool, q: WarOverviewQuery,
): Promise<Record<string, unknown>> {
  const usRes = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
  const ourFactionId = Number(usRes.rows[0]?.torn_faction_id ?? 0)

  // ⚠️ Epoch ms for every timestamp the bot will render, computed in SQL. The
  // war's own start/end are already epoch seconds; `updated_at` is a
  // timestamptz and must not cross as text.
  const warsRes = await db.query(
    `SELECT id, opponent_id, opponent_name, start_at, end_at, our_score, opponent_score,
            is_termed,
            (extract(epoch from updated_at) * 1000)::bigint AS updated_ms
       FROM ranked_wars
      ORDER BY start_at DESC
      LIMIT $1`,
    [RECENT_WARS],
  )
  const wars = warsRes.rows.map((w: any) => ({
    id: Number(w.id),
    opponent_id: w.opponent_id == null ? null : Number(w.opponent_id),
    opponent_name: w.opponent_name ?? null,
    start_at: Number(w.start_at),
    end_at: w.end_at == null ? null : Number(w.end_at),
    our_score: Number(w.our_score ?? 0),
    opponent_score: Number(w.opponent_score ?? 0),
    // ⚠️ Passed through rather than acted on. `is_termed` is set BY HAND from
    // the RW History page, so it is a label the bot may print and must not gate
    // on — an untoggled real war is indistinguishable from a termed one here.
    is_termed: !!w.is_termed,
    updated_ms: w.updated_ms == null ? null : Number(w.updated_ms),
  }))

  // No war asked for: the picker's payload, so the bot can offer a choice.
  if (!q.war) return { server_now: Date.now(), our_faction_id: ourFactionId, wars }

  const warId = Number(q.war)
  const war = wars.find((w) => w.id === warId)
  if (!war) return { server_now: Date.now(), our_faction_id: ourFactionId, wars, error: 'no such war' }

  const fromTs = war.start_at
  // ⚠️ A live war has no end. Counting to "now" is what the page does, and the
  // alternative — refusing — would make the command useless mid-war, which is
  // when a lead most wants it.
  const toTs = war.end_at || Math.floor(Date.now() / 1000)

  const [attacksRes, revivesRes] = await Promise.all([
    db.query(
      `SELECT started, result, chain, respect_gain,
              attacker_id, attacker_name, attacker_faction_id,
              defender_id, defender_name, defender_faction_id
         FROM faction_attacks
        WHERE started >= $1 AND started <= $2`,
      [fromTs, toTs],
    ),
    db.query(
      `SELECT timestamp, result, target_id, target_faction_id,
              reviver_id, reviver_faction_id, reviver_faction_name
         FROM faction_revives
        WHERE timestamp >= $1 AND timestamp <= $2`,
      [fromTs, toTs],
    ),
  ])
  const attacks = attacksRes.rows
  const revives = revivesRes.rows

  // ⚠️ `warring_only` must exclude (no faction) as well as third parties. It is
  // the filterable id 0, and there are six figures' worth of faction-less
  // defender rows on the live box — leaving them in is most of the noise the
  // flag exists to remove.
  const selectedFactionIds = truthy(q.warring_only)
    ? new Set<number>([ourFactionId, ...(war.opponent_id ? [war.opponent_id] : [])])
    : null

  const mode = q.mode === 'member' ? 'member' : 'faction'
  const memberId = q.member ? Number(q.member) : null

  // Our side's participants, for the bot's member autocomplete. Named from the
  // attack rows themselves so a mid-war rename or a since-departed member still
  // resolves — the members table would answer neither.
  const members = new Map<number, string>()
  for (const a of attacks) {
    if (Number(a.attacker_faction_id) === ourFactionId && a.attacker_id) {
      members.set(Number(a.attacker_id), a.attacker_name ?? String(a.attacker_id))
    }
    if (Number(a.defender_faction_id) === ourFactionId && a.defender_id) {
      if (!members.has(Number(a.defender_id))) {
        members.set(Number(a.defender_id), a.defender_name ?? String(a.defender_id))
      }
    }
  }

  const summary = summariseWindow({
    attacks, revives, fromTs, toTs, ourFactionId, selectedFactionIds, mode, memberId,
  })

  // ⚠️ Opt-in. The series are small but not free, and the summary-only path is
  // the common one — `/rw-overview summary_only:true`, and every autocomplete
  // keystroke, which must stay cheap.
  const factionNames: Record<number, string> = {}
  if (war.opponent_id && war.opponent_name) factionNames[war.opponent_id] = war.opponent_name
  for (const r of revives) {
    const fid = factionKey(r.reviver_faction_id)
    if (fid && r.reviver_faction_name && !factionNames[fid]) {
      factionNames[fid] = r.reviver_faction_name
    }
  }
  const chart = truthy(q.chart)
    ? buildChart({ attacks, revives, fromTs, toTs, ourFactionId,
                   selectedFactionIds, mode, memberId, factionNames })
    : null

  // Which factions took part, so the bot can name them and the chart can colour
  // them. ⚠️ Revivers are NOT here: the page keeps them out of the faction
  // filter because being revived by a stranger is not something you choose.
  const factionCounts = new Map<number, number>()
  for (const a of attacks) {
    for (const fid of [a.attacker_faction_id, a.defender_faction_id]) {
      const k = factionKey(fid)
      if (k === ourFactionId) continue
      factionCounts.set(k, (factionCounts.get(k) ?? 0) + 1)
    }
  }

  return {
    server_now: Date.now(),
    our_faction_id: ourFactionId,
    war,
    wars,
    mode,
    member_id: memberId,
    member_name: memberId != null ? (members.get(memberId) ?? null) : null,
    warring_only: truthy(q.warring_only),
    window: { from_ms: fromTs * 1000, to_ms: toTs * 1000 },
    summary,
    chart,
    members: [...members.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    factions: [...factionCounts.entries()]
      .map(([id, events]) => ({ id, events, is_no_faction: id === NO_FACTION_ID }))
      .sort((a, b) => b.events - a.events),
  }
}

export function registerWarOverviewInternalRoutes(
  app: FastifyInstance, db: pg.Pool, expectedToken: string,
) {
  app.get('/api/internal/war-overview', async (req, reply) => {
    const presented = bearerFrom(req.headers.authorization)
    // ⚠️ One message for a missing token and a wrong one, matching the other
    // internal routes. Distinguishing them tells a prober which half they have
    // already solved.
    if (presented === null || !tokenMatches(presented, expectedToken)) {
      return reply.status(401).send({ error: 'Authentication required' })
    }
    return collectWarOverview(db, req.query as WarOverviewQuery)
  })
}
