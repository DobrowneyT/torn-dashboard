// The faction Hall of Fame board (#872).
//
// ⚠️ Read-only and open to any authenticated session. It is a
// bragging-rights board; gating it to leadership would defeat the purpose.
//
// ⚠️ Each tenant's board contains its OWN members only. A member's HoF data is
// public in Torn so there is no consent question, but this stack serves five
// factions and a roster bleed would be a real bug. The join to `members` is
// what enforces it — the snapshot table alone is not scoped.
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { requireAuth } from './authz.js'
import { HOF_CATEGORIES, buildBoard } from './memberHof.js'

export function registerMemberHofRoutes(app: FastifyInstance, db: pg.Pool) {
  app.get('/api/members/hof', { preHandler: requireAuth() }, async () => {
    const { rows } = await db.query(
      // The NEWEST snapshot per member. DISTINCT ON is the cheap way to say
      // that in Postgres and keeps the whole board to one query.
      //
      // ⚠️ `fetched_at` converted to epoch ms IN SQL — this stack serves
      // timestamptz with a bare two-digit offset that `new Date()` reads as
      // NaN (#140). The client never meets that string.
      `SELECT DISTINCT ON (s.member_id)
              s.member_id, m.member_name, s.hof, s.snapshot_date,
              extract(epoch from s.fetched_at) * 1000 AS fetched_ms
         FROM member_hof_snapshots s
         JOIN members m ON m.member_id = s.member_id
        WHERE m.is_current = true AND m.is_fallen = false
        ORDER BY s.member_id, s.snapshot_date DESC`
    )

    // ⚠️ Before the job's first run there are genuinely no rows. That is an
    // empty state, not an error — a tenant that joined today has nothing until
    // the sweep runs, and a 404 would make that look broken.
    const categories = HOF_CATEGORIES.map((category) => ({
      category,
      rows: buildBoard(rows as any, category),
    })).filter((c) => c.rows.length > 0)

    const newest = rows.reduce<number | null>((acc, r: any) => {
      const ms = r.fetched_ms === null ? null : Number(r.fetched_ms)
      return ms != null && (acc == null || ms > acc) ? ms : acc
    }, null)

    return {
      memberCount: rows.length,
      fetchedMs: newest,
      snapshotDate: rows.length > 0
        ? ((rows[0] as any).snapshot_date instanceof Date
            ? (rows[0] as any).snapshot_date.toISOString().slice(0, 10)
            : (rows[0] as any).snapshot_date)
        : null,
      categories,
    }
  })
}
