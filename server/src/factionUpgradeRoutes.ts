// Faction upgrades panel (#458).
//
// Read-only and open to any authenticated session — this is mirrored Torn
// state with nothing private in it and no writes of any kind.
//
// ⚠️ Serves the LATEST snapshot, deliberately. `faction_upgrade_snapshots` keeps
// one row per day so the calendar can honestly show what Steadfast was worth on
// a past date (#395); this panel answers "what are we running right now", which
// is always the newest row.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth } from './authz.js'
import { readUpgradesView } from './factionUpgrades.js'

export function registerFactionUpgradeRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/faction/upgrades', { preHandler: requireAuth() }, async () => {
    const { rows } = await db.query(
      // ⚠️ `fetched_at` converted to epoch ms IN SQL. This stack installs a
      // process-wide parser that serves timestamptz as `...+00` with a bare
      // two-digit offset, which `new Date()` reads as NaN (#140). Doing the
      // conversion here means the client never has to know that.
      `SELECT snapshot_date,
              extract(epoch from fetched_at) * 1000 AS fetched_ms,
              payload
         FROM faction_upgrade_snapshots
        ORDER BY snapshot_date DESC
        LIMIT 1`
    )

    // ⚠️ Before the scraper's first run there is genuinely no row. That is an
    // empty state for the panel to render, not an error — a faction that just
    // joined the stack has nothing to show until 02:10 tomorrow, and a 404
    // would make that look broken.
    if (rows.length === 0) {
      return {
        snapshotDate: null, fetchedMs: null,
        state: null, active: [], inactive: [], inactiveState: null, core: [],
      }
    }

    const row = rows[0]
    return {
      // `snapshot_date` is a DATE, which pg gives us as a JS Date at UTC
      // midnight; the ISO day is what it means and all the client wants.
      snapshotDate: row.snapshot_date instanceof Date
        ? row.snapshot_date.toISOString().slice(0, 10)
        : row.snapshot_date,
      fetchedMs: row.fetched_ms === null ? null : Number(row.fetched_ms),
      ...readUpgradesView(row.payload),
    }
  })
}
