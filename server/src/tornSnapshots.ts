// The latest full Torn response from the jobs that already poll it (#1019).
//
// ⚠️ A cache of what was fetched anyway, never a reason to fetch. Readers get
// the payload with its age and decide for themselves how stale is too stale.
import type pg from 'pg'

export const SNAPSHOT_CRIMES = 'faction_crimes_available'
export const SNAPSHOT_MEMBERS = 'faction_members'

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient

export async function storeSnapshot(db: Queryable, kind: string, payload: unknown): Promise<void> {
  await db.query(
    `INSERT INTO torn_live_snapshots (kind, payload, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (kind) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [kind, JSON.stringify(payload ?? null)])
}

/** The payload and when it was fetched (epoch ms), or null when never stored. */
export async function readSnapshot<T = unknown>(db: Queryable, kind: string): Promise<{ payload: T; fetchedAt: number } | null> {
  const { rows } = await db.query(
    `SELECT payload, (extract(epoch FROM fetched_at) * 1000)::bigint AS at FROM torn_live_snapshots WHERE kind = $1`,
    [kind])
  return rows[0] ? { payload: rows[0].payload as T, fetchedAt: Number(rows[0].at) } : null
}
