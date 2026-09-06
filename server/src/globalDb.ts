/**
 * The tenant's read-only view of the shared `global` database (#608/#609).
 *
 * ⚠️ **Optional by design, and that is the whole architecture.** The #608 audit
 * chose "tenants read `global` directly" over the admin container pushing to
 * tenants or tenants pulling from it, because it makes #609's hardest
 * constraint — *killing the admin container leaves every tenant fully
 * functional* — true by construction rather than by careful engineering.
 *
 * For that to hold, every function here must degrade to `null` rather than
 * throw, and every caller must have something sensible to do with `null`. A
 * tenant with no `GLOBAL_DATABASE_URL`, or one whose global database is
 * unreachable, is a tenant that works exactly as it did before this existed.
 *
 * ⚠️ The connection uses `app_global_ro`, which has SELECT and nothing else
 * (see db/grants.mjs). A tenant physically cannot write here: a shared table
 * corrupted by one faction would be read by all of them, which is a worse
 * failure than the per-tenant duplication this replaces.
 */
import type pg from 'pg'

export interface FleetMeta {
  schemaVersion: number
  ocModelVersion: string | null
  ocModelBuiltAt: string | null
  itemsSyncedAt: string | null
}

/**
 * How stale the item catalogue may be before a tenant stops trusting it.
 *
 * ⚠️ Centralising `items-sync` trades five-fold redundancy for one key. Today
 * every tenant fetches from its own hourly re-verified pool (#309) and survives
 * any single key dying; fed by one key, prices quietly stop updating and every
 * faction keeps valuing payouts off a stale table. That is the same silent
 * decay that ran for months in July (#123/#124) before anyone noticed.
 *
 * Six hours is comfortably longer than the sync cadence and far shorter than a
 * market moves meaningfully. Past it, callers must report prices as unavailable
 * and fall back to the tenant's own pool — never carry on with the old numbers.
 * Absent beats confidently wrong, the same rule as `item_value_unmatched`
 * (#441) and unpriced endings (#473).
 */
export const ITEMS_STALE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * Read the fleet metadata row, or null if the global database is unavailable.
 *
 * Never throws. An unreachable control plane is an expected state, not an
 * error: it is what this design promises will not take a tenant down.
 */
export async function readFleetMeta(globalDb: pg.Pool | undefined): Promise<FleetMeta | null> {
  if (!globalDb) return null
  try {
    const res = await globalDb.query(
      `SELECT schema_version, oc_model_version, oc_model_built_at, items_synced_at
         FROM fleet_meta WHERE id = 1`
    )
    const row = res.rows[0]
    if (!row) return null
    return {
      schemaVersion: Number(row.schema_version),
      ocModelVersion: row.oc_model_version ?? null,
      ocModelBuiltAt: row.oc_model_built_at ? new Date(row.oc_model_built_at).toISOString() : null,
      itemsSyncedAt: row.items_synced_at ? new Date(row.items_synced_at).toISOString() : null,
    }
  } catch {
    return null
  }
}

/**
 * Are the shared item prices fresh enough to use?
 *
 * ⚠️ Returns false for a NULL `items_synced_at`, not true. "Never synced" and
 * "synced long ago" are the same answer to the only question that matters —
 * may I price a payout with this? — and defaulting the unknown case to "yes"
 * is exactly how a silent mis-valuation happens.
 */
export function itemsAreFresh(meta: FleetMeta | null, now = Date.now()): boolean {
  if (!meta?.itemsSyncedAt) return false
  const at = Date.parse(meta.itemsSyncedAt)
  if (!Number.isFinite(at)) return false
  return now - at <= ITEMS_STALE_AFTER_MS
}
