// OC read surface: crimes history, slots, roster lookup, faction OC policy,
// live Torn crimes proxy, and the role-gated planner bundle.
import { TORN_API_COMMENT } from './tornComment.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'
import { claimPooledKey, EMPTY_POOL_MESSAGE } from './scraper/keyPool.js'
import { createProbabilityClient, normaliseKey } from './oc/probabilityClient.js'
import { matchRolesToPositions } from './oc/roleMatch.js'

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

  // ── OC Simulator (#390) ─────────────────────────────────────────────────
  //
  // Reads our MIRROR of tornprobability, never the live service. The browser
  // must not talk to it: it is one person's server on a non-standard port with
  // no SLA, and a member's machine has no business making that request.
  //
  // Gated to OC managers, leadership and admin, per MonChoon. Visitors are
  // included on the read for the same reason as the war-notes archive — they
  // demo the leads view and this only ever reads mirrored public data.
  const SIM_ROLES = ['ocmanager', 'leadership', 'admin', 'visitor'] as const

  app.get(
    '/api/oc-simulator/scenarios',
    { preHandler: requireRole(...SIM_ROLES) },
    async () => {
      const rows = await deps.db.query(
        `SELECT s.name, s.parameter_count, s.is_complete, s.observed_paths,
                s.diagram_valid, s.diagram_problems, s.fetched_at,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'position_id', r.position_id,
                           'role_name', r.role_name,
                           'weight', r.weight)
                         ORDER BY length(r.position_id), r.position_id)
                  FROM oc_scenario_roles r WHERE r.scenario_name = s.name
                ), '[]'::jsonb) AS roles,
                -- Endings travel with their resolution state. An ending we
                -- could not map keeps its row so the UI can say WHY, rather
                -- than silently pricing the crime on a subset of its outcomes.
                -- #440: the payout for each ending, joined through the derived
                -- node id. LEFT JOIN on purpose — an ending we mapped but have
                -- no observations for keeps its row with null money, which
                -- expectedValue() reports as an unpriced ending and therefore a
                -- lower bound. Dropping it would silently shrink the crime.
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                           'ending_key', e.ending_key, 'node_id', e.node_id,
                           'kind', e.kind, 'resolved', e.resolved, 'problem', e.problem,
                           'money_avg', st.money_avg, 'money_min', st.money_min,
                           'money_max', st.money_max, 'respect_avg', st.respect_avg,
                           'observations', st.n)
                         ORDER BY e.kind, e.ending_key)
                  FROM oc_scenario_endings e
                  LEFT JOIN oc_scenario_node_stats st
                    ON st.scenario_name = e.scenario_name AND st.node_id = e.node_id
                  WHERE e.scenario_name = s.name
                ), '[]'::jsonb) AS endings
           FROM oc_scenarios s
          ORDER BY s.name`
      )

      // #448: what this crime's ITEM rewards have been worth, from our own
      // completed runs, at today's market prices.
      //
      // ⚠️ The denominator is every successful run, not just the ones that
      // dropped items. Averaging only over runs with item rows would overstate
      // the reward of a crime that drops items occasionally — 3 drops worth
      // $30M across 10 runs is $3M a run, not $10M.
      //
      // ⚠️ CURRENT price, deliberately unlike Payout Management, which keeps the
      // stored snapshot because a saved week is a record of what happened. This
      // is a forecast, so it uses what the items are worth now — and MonChoon
      // wants re-running the simulation to pick up price movement.
      //
      // ⚠️ GREATEST(market_price, sell_price), not market_price alone. Some
      // illiquid items carry market_price = 0 because they rarely trade, while
      // sell_price is always defined — `enrichItemBreakdown` in the payout path
      // has handled this for a long time and the comment there says so. Pricing
      // on market alone would value exactly the rare, expensive drops at zero,
      // which is the opposite of the error worth risking.
      //
      // An item in neither state (absent from the catalogue) contributes
      // nothing and is COUNTED, rather than silently falling back to the stale
      // unit_value stored on the row at the time — a stale number presented as
      // a current one is the thing this whole feature is trying to avoid.
      const items = await deps.db.query(
        `WITH runs AS (
           SELECT crime_id, name FROM crimes WHERE status = 'Successful'
         ), per_run AS (
           SELECT r.name,
                  r.crime_id,
                  COALESCE(SUM(
                    GREATEST(COALESCE(i.market_price, 0), COALESCE(i.sell_price, 0)) * ri.quantity
                  ), 0) AS value_now,
                  COUNT(*) FILTER (
                    WHERE ri.item_id IS NOT NULL
                      AND COALESCE(i.market_price, 0) = 0
                      AND COALESCE(i.sell_price, 0) = 0
                  ) AS unpriced
             FROM runs r
             LEFT JOIN crime_reward_items ri ON ri.crime_id = r.crime_id
             LEFT JOIN items i ON i.id::text = ri.item_id
            GROUP BY r.name, r.crime_id
         )
         SELECT name,
                COUNT(*)::int          AS runs,
                AVG(value_now)::bigint AS avg_item_value,
                SUM(unpriced)::int     AS unpriced_item_rows
           FROM per_run GROUP BY name`
      )
      const itemsByName = new Map(items.rows.map((r) => [r.name, r]))

      // How often we actually spawn each crime. Measured, not modelled.
      //
      // ⚠️ Partly a record of past DECISIONS, not just capacity: a crime we
      // rarely ran because someone judged it not worth it will measure as rare
      // and, if ranked on, stay rare. The run count travels with the rate so a
      // thin sample can be shown as uncertain rather than treated as fact.
      const spawns = await deps.db.query(
        `SELECT name,
                COUNT(*)::int AS runs,
                MIN(created_at)::bigint AS first_at,
                MAX(created_at)::bigint AS last_at
           FROM crimes
          WHERE created_at IS NOT NULL
          GROUP BY name`
      )
      const spawnsByName = new Map(spawns.rows.map((r) => [r.name, r]))

      return {
        scenarios: rows.rows.map((s) => {
          const item = itemsByName.get(s.name)
          const spawn = spawnsByName.get(s.name)
          return {
            ...s,
            // null, not 0, for a crime we have never completed — "we have no
            // history" must not read as "it drops nothing".
            item_reward: item
              ? {
                  avg_value: Number(item.avg_item_value ?? 0),
                  runs: item.runs,
                  unpriced_rows: item.unpriced_item_rows ?? 0,
                }
              : null,
            spawn_history: spawn
              ? {
                  runs: spawn.runs,
                  first_at: spawn.first_at === null ? null : Number(spawn.first_at),
                  last_at: spawn.last_at === null ? null : Number(spawn.last_at),
                }
              : null,
          }
        }),
      }
    }
  )

  // Who on our roster can actually fill each role (#442).
  //
  // The simulator models a hypothetical crew; this connects it to the people we
  // have. Returns the CPR readings per role so the client can compute headcount
  // at any threshold without a round trip per slider tick.
  //
  // ⚠️ Every reading is an UPPER BOUND on availability. A member with the CPR
  // may already be in another crime — members cannot be in two OCs at once —
  // and this endpoint does not know that. The client must label it accordingly
  // until the occupancy half (#389 data) is wired in.
  app.get(
    '/api/oc-simulator/roster-cpr/:scenario',
    { preHandler: requireRole(...SIM_ROLES) },
    async (req, reply) => {
      const { scenario } = req.params as { scenario: string }

      const roles = await deps.db.query(
        'SELECT position_id, role_name FROM oc_scenario_roles WHERE scenario_name = $1',
        [scenario]
      )
      if (roles.rows.length === 0) {
        return reply.status(404).send({ error: `no mirrored roles for ${scenario}` })
      }

      // Torn's own labels for this crime's positions, and its position ids.
      const positions = await deps.db.query(
        'SELECT position_label, position_id FROM oc_crime_positions WHERE crime_name = $1',
        [scenario]
      )

      // Current members only — a leaver's CPR is not capacity we have.
      const cpr = await deps.db.query(
        // last_seen_at, not updated_at: the column records when the reading
        // was last OBSERVED, which is exactly what staleness should measure.
        `SELECT c.member_id, m.member_name, c.position_label, c.cpr_value,
                c.last_seen_at AS updated_at, c.observation_count
           FROM member_cpr_v2 c
           JOIN members m ON m.member_id = c.member_id
          WHERE c.crime_name = $1 AND m.is_current = true`,
        [scenario]
      )

      const matched = matchRolesToPositions(roles.rows, positions.rows)

      const byRole: Record<string, unknown[]> = {}
      for (const role of roles.rows) byRole[role.position_id] = []
      const readingsByLabel = new Map<string, typeof cpr.rows>()
      for (const row of cpr.rows) {
        const key = normaliseKey(row.position_label)
        const list = readingsByLabel.get(key) ?? []
        list.push(row)
        readingsByLabel.set(key, list)
      }

      for (const m of matched.matches) {
        const readings = readingsByLabel.get(normaliseKey(m.positionLabel)) ?? []
        byRole[m.positionId] = readings
          .map((r) => ({
            member_id: r.member_id,
            member_name: r.member_name,
            cpr: Number(r.cpr_value),
            updated_at: r.updated_at,
            observations: r.observation_count,
          }))
          .sort((a, b) => b.cpr - a.cpr)
      }

      const currentMembers = await deps.db.query(
        'SELECT count(*)::int AS n FROM members WHERE is_current = true'
      )

      return {
        scenario,
        readings: byRole,
        // ⚠️ Roles we could NOT join to a Torn position are reported, not
        // silently empty. An unmatched role would otherwise read as "nobody can
        // fill this", which is a very different and much more alarming claim
        // than "we could not look".
        unmatched_roles: matched.unmatched,
        conflicts: matched.conflicts,
        roster_size: currentMembers.rows[0]?.n ?? 0,
      }
    }
  )

  // Success chance for EVERY mirrored crime at one CPR (#444).
  //
  // The ranking screen needs a comparable success figure per crime, which means
  // one CalculateSuccess per crime — ~31 calls to a small third-party server.
  // Cached in memory keyed by (scenario, cpr): the mirror is static between
  // nightly runs, so the same CPR asked twice costs nothing.
  //
  // ⚠️ A FLAT CPR across every role is an assumption, not a measurement. It
  // ranks crimes by a crew that does not exist, and the client must state the
  // number it asked for. It is still the right default for comparison —
  // ranking each crime by a different crew would compare nothing.
  const successCache = new Map<string, number>()

  app.get(
    '/api/oc-simulator/ranking',
    { preHandler: requireRole(...SIM_ROLES) },
    async (req, reply) => {
      const q = req.query as { cpr?: string }
      const cpr = Number(q.cpr)
      if (!Number.isFinite(cpr) || cpr < 0 || cpr > 100) {
        return reply.status(400).send({ error: 'cpr must be a number between 0 and 100' })
      }

      const scenarios = await deps.db.query(
        `SELECT s.name, s.parameter_count,
                (SELECT count(*)::int FROM oc_scenario_roles r WHERE r.scenario_name = s.name) AS role_count
           FROM oc_scenarios s ORDER BY s.name`
      )

      const client = createProbabilityClient()
      const out: Array<Record<string, unknown>> = []

      for (const s of scenarios.rows) {
        // A crime whose mirrored roles disagree with its parameter count cannot
        // be given a defensible vector. Reported as unrankable rather than
        // ranked on a guess.
        if (s.role_count !== s.parameter_count) {
          out.push({ name: s.name, success: null, error: 'role count does not match the crime' })
          continue
        }

        const key = `${s.name}|${cpr}`
        const cached = successCache.get(key)
        if (cached !== undefined) {
          out.push({ name: s.name, success: cached, cached: true })
          continue
        }

        try {
          const res = await client.calculateSuccess(
            s.name,
            Array.from({ length: s.parameter_count }, () => cpr)
          )
          const success = Number(res.successChance)
          if (Number.isFinite(success)) {
            // Bounded so a long-lived process cannot grow this without limit.
            if (successCache.size > 2000) successCache.clear()
            successCache.set(key, success)
          }
          out.push({ name: s.name, success: Number.isFinite(success) ? success : null })
        } catch (e) {
          // One unreachable crime must not cost the whole table.
          out.push({
            name: s.name,
            success: null,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }

      return { cpr, crimes: out }
    }
  )

  // Success chance for a CPR vector.
  //
  // Proxied server-to-server rather than mirrored: this is a function of the
  // input vector, so there is nothing to cache — but it still must not be
  // called from the browser (CORS, and the member's IP).
  app.post(
    '/api/oc-simulator/calculate',
    { preHandler: requireRole(...SIM_ROLES) },
    async (req, reply) => {
      const body = (req.body ?? {}) as { scenario?: unknown; parameters?: unknown }
      const scenario = typeof body.scenario === 'string' ? body.scenario : null
      const parameters = Array.isArray(body.parameters) ? body.parameters.map(Number) : null

      if (!scenario || !parameters || parameters.length === 0) {
        return reply.status(400).send({ error: 'scenario and parameters are required' })
      }
      if (parameters.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) {
        return reply.status(400).send({ error: 'every CPR must be a number between 0 and 100' })
      }

      // The scenario must be one we have mirrored, and the vector must be the
      // length that crime actually takes. A wrong-length vector still returns
      // numbers from the upstream service — numbers describing a crime nobody
      // is running, which would look completely ordinary on the page.
      const known = await deps.db.query(
        'SELECT parameter_count FROM oc_scenarios WHERE name = $1',
        [scenario]
      )
      if (known.rows.length === 0) {
        return reply.status(404).send({ error: `unknown scenario: ${scenario}` })
      }
      const expected = Number(known.rows[0].parameter_count)
      if (parameters.length !== expected) {
        return reply.status(400).send({
          error: `${scenario} takes ${expected} roles, got ${parameters.length}`,
        })
      }

      try {
        const client = createProbabilityClient()
        return { ok: true, result: await client.calculateSuccess(scenario, parameters) }
      } catch (e) {
        // Degrade to a clear failure, not a zeroed result: a success chance of
        // 0 is a legitimate value and must never be manufactured by an outage.
        return reply.status(502).send({
          error: 'the probability service could not be reached',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }
  )
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}
