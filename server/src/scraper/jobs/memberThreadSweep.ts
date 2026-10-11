// Queue membership notes for the Discord member threads (#942).
//
// ⚠️ **Decides nothing itself.** `memberThreads.planThreadWork` holds every
// rule; this reads rows, hands them over, and writes what comes back. The rules
// are about what gets written permanently into somebody's thread, so they live
// where they can be tested without a database.
import type pg from 'pg'
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { planThreadWork } from '../../memberThreads.js'

/** `faction_settings` key holding the moment this faction started being watched. */
export const INSTALL_KEY = 'member_threads_installed_at'

/**
 * When this faction started being watched, in epoch ms — stamping it on first
 * run and returning null that one time.
 *
 * ⚠️ **The first run must queue NOTHING.** It is the run that establishes the
 * watermark, and the roster sitting there at that moment is ~94 people whose
 * real join dates nobody recorded. Returning null rather than `now()` is what
 * makes "queue nothing this pass" explicit instead of relying on a comparison
 * that would be true-ish by a few milliseconds.
 */
export async function installedAt(db: pg.Pool): Promise<number | null> {
  const res = await db.query(
    `SELECT (extract(epoch from (value #>> '{}')::timestamptz) * 1000)::bigint AS ms
       FROM faction_settings WHERE key = $1`,
    [INSTALL_KEY],
  )
  const ms = res.rows[0]?.ms
  if (ms != null) return Number(ms)
  await db.query(
    `INSERT INTO faction_settings (key, value, updated_at)
     VALUES ($1, to_jsonb(now()::text), now())
     ON CONFLICT (key) DO NOTHING`,
    [INSTALL_KEY],
  )
  return null
}

export async function memberThreadSweepJob({ db }: JobDeps): Promise<RunResult> {
  const installed = await installedAt(db)
  // First run: the watermark is now set, and this pass deliberately does nothing.
  if (installed === null) return { rows: 0, details: { installed: true } }

  // ⚠️ Epoch ms in SQL, never a timestamptz crossing into JS. Postgres serves a
  // bare two-digit offset that `new Date` reads as NaN (#140).
  const stints = await db.query(
    `SELECT s.id, s.member_id,
            m.member_name,
            (extract(epoch from s.joined_at) * 1000)::bigint AS joined_at,
            (extract(epoch from s.left_at)   * 1000)::bigint AS left_at
       FROM member_faction_stints s
       LEFT JOIN members m ON m.member_id = s.member_id
      WHERE s.joined_at > to_timestamp($1 / 1000.0)
         OR s.left_at   > to_timestamp($1 / 1000.0)
      ORDER BY s.id`,
    [installed],
  )

  const existing = await db.query(
    `SELECT member_id, kind, subject FROM member_thread_outbox`,
  )
  const queued = new Set(
    existing.rows.map((r: any) => `${r.member_id}|${r.kind}|${r.subject}`),
  )

  const work = planThreadWork({
    stints: stints.rows.map((r: any) => ({
      id: Number(r.id),
      member_id: r.member_id,
      member_name: r.member_name,
      joined_at: Number(r.joined_at),
      left_at: r.left_at == null ? null : Number(r.left_at),
    })),
    installedAt: installed,
    queued,
  })

  let inserted = 0
  for (const row of work) {
    // ⚠️ `ON CONFLICT DO NOTHING` as well as the in-memory check: two sweeps
    // overlapping would otherwise race past the Set and write a second join
    // note. The unique index is the real guarantee; the Set only saves work.
    const res = await db.query(
      `INSERT INTO member_thread_outbox (member_id, kind, subject, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, kind, subject) DO NOTHING`,
      [row.member_id, row.kind, row.subject, JSON.stringify(row.payload)],
    )
    inserted += res.rowCount ?? 0
  }

  return { rows: inserted, details: { considered: work.length } }
}
