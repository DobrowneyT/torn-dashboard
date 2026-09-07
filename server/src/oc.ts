// OC read surface: crimes history, slots, roster lookup, faction OC policy,
// live Torn crimes proxy, and the role-gated planner bundle.
import { TORN_API_COMMENT } from './tornComment.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth, requireRole } from './authz.js'
import { claimPooledKey, EMPTY_POOL_MESSAGE } from './scraper/keyPool.js'
import { createProbabilityClient, normaliseKey } from './oc/probabilityClient.js'
import { matchRolesToPositions } from './oc/roleMatch.js'
import {
  buildItemCatalog, priceNodeItems, catalogFreshness, EMPTY_CATALOG, type ItemDropInput,
} from './oc/itemPricing.js'
import { loadOcModel, type OcScenarioModel } from './oc/modelLoader.js'

/**
 * One assembled scenario: the committed model (#606) with this faction's own
 * observations overlaid.
 *
 * ⚠️ Shaped exactly like the rows the SQL used to return, so everything
 * downstream — item pricing, expectedValue, the client — is untouched by where
 * the data now comes from. The two `money` notions stay distinct: `money_avg`
 * on an ending is what WE observed; `reward` is what the model publishes.
 */
interface ScenarioEndingRow {
  ending_key: string
  node_id: string | null
  kind: string
  resolved: boolean
  starved: boolean
  problem: string | null
  money_avg: number | null
  money_min: number | null
  money_max: number | null
  respect_avg: number | null
  observations: number | null
  /** Item drops we have OBSERVED on this node (#441), priced below. */
  items?: ItemDropInput[] | null
  /** The model's published reward (#606), where Crimes Hub had one. ⚠️ A
   *  different claim from `money_avg`, and the client must tell them apart. */
  reward: unknown
  item_value_avg?: number | null
  item_value_unmatched?: string[]
}

interface ScenarioRow {
  name: string
  parameter_count: number
  is_complete: boolean
  diagram_valid: boolean
  diagram_problems: unknown
  observed_paths: number | null
  fetched_at: string | null
  ending_map_residual: number | null
  ending_map_confident: boolean | null
  ending_map_money_residual: number | null
  ending_map_money_confident: boolean | null
  roles: Array<{ position_id: string; role_name: string; weight: number }>
  endings: ScenarioEndingRow[]
}
import { DEFAULT_PAYOUT_MODE, isPayoutMode } from './payoutModes.js'

export interface OcDeps {
  db: pg.Pool
  tornBaseUrl: string
  /** Key-at-rest secret — server-side Torn reads claim from the pool (#98). */
  encryptionKey?: string
  /**
   * The OC scenario model (#606). Defaults to the dataset committed in the
   * image, which is what every tenant runs.
   *
   * ⚠️ Injectable so tests can supply a small fixture. The alternative —
   * asserting against the real committed dataset — would couple the whole suite
   * to its exact contents, so a routine model refresh when Torn ships a game
   * update would break tests that have nothing to do with the change. Torn adds
   * crimes; the suite should not care.
   */
  ocModel?: Map<string, OcScenarioModel>
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
    -- Past members are kept (callers read is_current for history); Fallen
    -- accounts are not — they can never fill an OC slot.
    FROM members WHERE is_fallen = false ORDER BY member_id
  `)
  return res.rows
}

export function registerOcRoutes(app: FastifyInstance, deps: OcDeps) {
  /** The model this server runs on. Read through a function so an injected
   *  fixture is honoured everywhere, not just in the listing. */
  const ocModel = () => deps.ocModel ?? loadOcModel()
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
      // Faction default payout mode (#134), written by the Settings editor
      // (#136) as a plain jsonb string.
      //
      // #587: this used to return null when unset, and each consumer guessed a
      // different meaning for it — Payout Management fell through to
      // flat-weighted (a mode nobody had chosen) while the tier UI stayed
      // optimistically tiered, so a faction could see tier machinery and be
      // paid flat-weighted. The absent case is resolved here, once, so every
      // consumer reads the same answer. Equal is the honest default: it is the
      // only mode that needs neither a tier table nor a ticket policy to be
      // correct for a faction that has configured nothing.
      payout_mode: isPayoutMode(settings.payout_mode) ? settings.payout_mode : DEFAULT_PAYOUT_MODE,
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
      // ⚠️ #606: the MODEL comes from the committed dataset, not from
      // per-tenant tables. Only our OWN OBSERVATIONS are queried here.
      //
      // The mirror populated those tables only where somebody had enabled the
      // `oc-scenarios-mirror` job, so on 2026-09-06 three of five live tenants
      // held ZERO scenarios and their Simulator was silently empty — an empty
      // table looks exactly like a crime with no data. Scenario structure is
      // Torn game data, identical for every faction, so it belongs in the image
      // where it cannot be present on some tenants and absent on others.
      //
      // ⚠️ Queried INDEPENDENTLY of oc_scenarios, not joined through it. Keying
      // observations off the mirror's rows would reproduce the very bug this
      // replaces: a tenant with no mirror rows would get no observations
      // either, even though its own crime history is perfectly intact.
      // ⚠️ #606 slice 3: node stats now come from the MODEL, not from
      // `oc_scenario_node_stats`. They were always tornprobability's global
      // aggregates — the mirror wrote them straight from the upstream feed —
      // so they are the same for every faction and belong in the image for
      // exactly the reason the scenario structure above does.
      //
      // This is what made dropping the mirror table safe. Doing the migration
      // without carrying them would have silently stripped the per-node
      // payouts, E(x) and success figures the Simulator renders, and an empty
      // stats map looks identical to a node nobody has run.
      const statsBy = new Map<string, Map<string, Record<string, unknown>>>()
      for (const m of ocModel().values()) {
        if (m.nodeStats.length === 0) continue
        const byNode = new Map<string, Record<string, unknown>>()
        for (const n of m.nodeStats) {
          byNode.set(String(n.nodeId), {
            scenario_name: m.name,
            node_id: n.nodeId,
            n: n.n,
            money_min: n.money.min,
            money_max: n.money.max,
            money_avg: n.money.avg,
            respect_avg: n.respect.avg,
            items: n.items,
          })
        }
        statsBy.set(m.name, byNode)
      }

      // ⚠️ #606 slice 3 rehomed these. `ending_map_*` are OURS — derived by the
      // maintainer probe sweep (#471/#473) against a tenant's own data — so
      // they stay in the tenant database rather than moving into the image,
      // per MonChoon's "certain aspects will be scoped to the faction of
      // interest". They now live in `oc_scenario_quality`, which has no
      // dependency on the dropped mirror tables.
      //
      // ⚠️ `observed_paths` and `fetched_at` are NOT carried over, and an
      // earlier comment here wrongly called them ours. Both were written by
      // the mirror job straight from tornprobability's feed — `observed_paths`
      // is how many paths THEY observed, `fetched_at` is when WE last fetched
      // from them. With the mirror gone neither has a writer, so keeping them
      // would have meant showing a number that could only ever go stale.
      //
      // A tenant with no rows simply has no quality figures, which is correct:
      // it has run no probe sweep to derive them from.
      const derivedRows = await deps.db.query(
        `SELECT scenario_name AS name, ending_map_residual,
                ending_map_confident, ending_map_money_residual,
                ending_map_money_confident
           FROM oc_scenario_quality`
      )
      const derivedBy = new Map(derivedRows.rows.map((r) => [r.name, r]))

      // The model is the FLOOR; observations are an overlay. A faction that has
      // never run a crime still gets every scenario, role and ending — it just
      // has no money on them.
      const rows = {
        rows: [...ocModel().values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => {
            const derived = derivedBy.get(m.name) ?? {}
            const stats = statsBy.get(m.name)
            return {
              name: m.name,
              parameter_count: m.parameterCount,
              is_complete: m.isComplete,
              diagram_valid: m.diagramValid,
              diagram_problems: m.diagramProblems,
              // From the MODEL now (#606 slice 3): tornprobability's own path
              // count is global game data, so it ships in the image.
              observed_paths: m.observedPaths,
              // ⚠️ Always null since the mirror was deleted, and deliberately
              // kept in the shape rather than removed. It meant "when we last
              // fetched from tornprobability", and with no fetcher there is no
              // honest value — null says "unknown", where a build timestamp
              // would assert a freshness the data does not have. The field
              // stays so an older client reading it sees absent, not missing.
              fetched_at: null,
              ending_map_residual: (derived as any).ending_map_residual ?? null,
              ending_map_confident: (derived as any).ending_map_confident ?? null,
              ending_map_money_residual: (derived as any).ending_map_money_residual ?? null,
              ending_map_money_confident: (derived as any).ending_map_money_confident ?? null,
              // ⚠️ `length` first, then lexical — the ordering the SQL used.
              // A plain sort puts P10 between P1 and P2, which silently
              // reorders every role slider on a six-position crime.
              roles: [...m.roles]
                .sort((a, b) =>
                  a.positionId.length - b.positionId.length ||
                  a.positionId.localeCompare(b.positionId))
                .map((r) => ({ position_id: r.positionId, role_name: r.roleName, weight: r.weight })),
              // Endings keep their resolution state so the UI can say WHY one
              // could not be mapped, rather than silently pricing the crime on
              // a subset of its outcomes. An ending we mapped but have no
              // observations for keeps its row with null money, which
              // expectedValue() reports as unpriced and therefore a lower bound.
              endings: [...m.endings]
                .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
                .map((e) => {
                  const st = (e.nodeId ? stats?.get(e.nodeId) : undefined) as any
                  return {
                    ending_key: e.key,
                    node_id: e.nodeId,
                    kind: e.kind,
                    resolved: e.resolved,
                    starved: e.starved,
                    problem: e.problem,
                    // #606: which ending this one shares a terminal with, so the
                    // Simulator can say why two rows carry the same payout
                    // rather than leaving it looking like a duplicate row.
                    alias_of: e.aliasOf ?? null,
                    money_avg: st?.money_avg ?? null,
                    money_min: st?.money_min ?? null,
                    money_max: st?.money_max ?? null,
                    respect_avg: st?.respect_avg ?? null,
                    observations: st?.n ?? null,
                    items: st?.items ?? null,
                    // #606: the published reward, where Crimes Hub had one.
                    // ⚠️ Distinct from money_avg, which is what WE have observed.
                    // Two different claims about the same ending, and the client
                    // must be able to tell them apart.
                    reward: e.reward,
                  }
                }),
            } as ScenarioRow
          }),
      }

      // #441 follow-up: price each ending's observed item drops at CURRENT
      // market prices, same convention as #448's crime-level average
      // (GREATEST(market_price, sell_price) below in itemPricing.ts). This is
      // what turns an ending that pays in items (Window of Opportunity, and
      // everything paysInItems() flags) from "unpriced" into a real E(x).
      // ⚠️ #609 slice 7: prices are REFUSED when the catalogue has gone stale,
      // never silently used. Withholding is expressed as an EMPTY catalogue so
      // it travels the path #441 already built — every drop comes back in
      // `item_value_unmatched` — rather than through a second, parallel notion
      // of "unpriced" that the client would have to learn.
      const itemCatalogRows = await deps.db.query(
        'SELECT name, market_price, sell_price, last_updated FROM items'
      )
      const catalogAsOf = itemCatalogRows.rows.reduce<string | null>((newest, r) => {
        const v = r.last_updated == null ? null : String(r.last_updated)
        if (!v) return newest
        return newest === null || Date.parse(v) > Date.parse(newest) ? v : newest
      }, null)
      const itemPrices = catalogFreshness(catalogAsOf)
      const itemCatalog = itemPrices.fresh ? buildItemCatalog(itemCatalogRows.rows) : EMPTY_CATALOG
      for (const s of rows.rows) {
        for (const e of s.endings ?? []) {
          // ⚠️ `?? 0`, and priceNodeItems returns null for n <= 0. An ending we
          // have never observed must come back unpriced, not priced at zero.
          const priced = priceNodeItems(e.items, e.observations ?? 0, itemCatalog)
          e.item_value_avg = priced ? priced.value : null
          e.item_value_unmatched = priced ? priced.unmatched : []
          delete e.items
        }
      }

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

      // #585: which crimes spawn which, from our own `previous_crime_id`
      // history. Torn has been telling us this since the first scraper run and
      // nothing downstream has ever read it.
      //
      // ⚠️ The join is on the CHILD's previous_crime_id, so this counts real
      // observed spawns, not inferences. Verified across the fleet: every
      // successful parent spawned exactly one child (124/124 Stacking the Deck,
      // 34/34 Lock Stock, 8/8 Manifest Cruelty, 7/7 Gone Fission) and no failed,
      // expired or planning parent ever did. The relationship is deterministic
      // on success, which is why the client can treat an edge as fact rather
      // than as a probability to model.
      //
      // ⚠️ Per-tenant, and no tenant sees the whole picture — at the time of
      // writing ascension had observed no chains at all, Forge and Mayhem only
      // No Reserve, and capacityx alone had all five edges. The client folds
      // these together with a known-chains table for exactly that reason; this
      // query is the half that can notice Torn changing the game.
      const chains = await deps.db.query(
        `SELECT p.name AS parent, c.name AS child, COUNT(*)::int AS observations
           FROM crimes p
           JOIN crimes c ON c.previous_crime_id = p.crime_id::text
          GROUP BY p.name, c.name
          ORDER BY observations DESC`
      )

      return {
        // Says whether the numbers below can be trusted, and why not when they
        // cannot. A client that ignores this shows zeroes; one that reads it
        // can say "prices unavailable" instead, which is the difference #609
        // asks for.
        item_prices: itemPrices,
        chains: chains.rows,
        scenarios: rows.rows.map((s) => {
          // ⚠️ Withheld under the same rule as the ending prices above. This
          // one is computed in SQL against the same table, so leaving it
          // untouched would have the page report a confident crime-level
          // average beside endings that all say "unpriced" — two answers to
          // one question, and the wrong one looks authoritative.
          const item = itemPrices.fresh ? itemsByName.get(s.name) : null
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

      // #606: roles come from the committed model. ⚠️ The 404 message changes
      // meaning with it — "not mirrored" described a per-tenant gap that could
      // differ between factions, which is exactly the state this removed.
      const scenarioModel = ocModel().get(scenario)
      if (!scenarioModel || scenarioModel.roles.length === 0) {
        return reply.status(404).send({ error: `unknown scenario: ${scenario}` })
      }
      const roles = {
        rows: [...scenarioModel.roles]
          .sort((a, b) =>
            a.positionId.length - b.positionId.length || a.positionId.localeCompare(b.positionId))
          .map((r) => ({ position_id: r.positionId, role_name: r.roleName })),
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
          WHERE c.crime_name = $1 AND m.is_current = true AND m.is_fallen = false`,
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
        'SELECT count(*)::int AS n FROM members WHERE is_current = true AND is_fallen = false'
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

      // #606: every scenario, from the committed model — so this answers the
      // same for every faction rather than only for those whose mirror ran.
      const scenarios = {
        rows: [...ocModel().values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => ({
            name: m.name,
            parameter_count: m.parameterCount,
            role_count: m.roles.length,
          })),
      }

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
      const known = ocModel().get(scenario)
      if (!known) {
        return reply.status(404).send({ error: `unknown scenario: ${scenario}` })
      }
      const expected = Number(known.parameterCount)
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
