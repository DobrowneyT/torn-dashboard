// #774 — who was around, and who was in the air.
//
// ⚠️ **Poll the roster, not the watchers.** Sampling each signed-up member
// individually costs one Torn call PER MEMBER; `/v2/faction/members` returns
// `last_action` AND the whole `status` object — which is where
// `plane_image_type` lives — for everybody in ONE call. So the cost is the same
// whether two people signed up or forty.
//
// ⚠️ And it records who WAS awake at 04:00 and did not sign up, which is the
// recruiting list for tomorrow night's empty slots. Watching only the watchers
// throws that away for no saving.
//
// `member_daily_stats.last_action_timestamp` exists but is written once a day
// and cannot answer "was this person around at 04:00". That is why this series
// exists at all.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { latchDeparture } from '../../chain/travelLatch.js'

interface RosterMember {
  id: number | string
  last_action?: { timestamp?: number | null } | null
  status?: { state?: string | null; description?: string | null; plane_image_type?: string | null } | null
}

export async function activitySampleJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch('/v2/faction/members', claimed.key)
  const roster: RosterMember[] = data?.members ?? []
  if (roster.length === 0) {
    // An empty roster is a bad response, not a faction that vanished. Writing
    // it would record everybody as un-sampled for this minute.
    throw new Error('Torn returned an empty roster — refusing to record an empty sample')
  }

  // The previous reading per member, for the take-off edge. One query, not one
  // per member: DISTINCT ON is the cheap way to the latest row of each series.
  //
  // ⚠️ **Both timestamps are converted to epoch ms BY POSTGRES, never by
  // `new Date()`.** `src/db.ts` installs a process-wide `setTypeParser` for
  // timestamptz so the tenant API can serve PostgREST-shaped strings, which
  // means a column arrives as `2026-09-25T00:25:41.074+00` — a bare two-digit
  // offset, not ISO-8601. `new Date()` rejects it outright and returns an
  // Invalid Date, `.getTime()` on that is NaN, and `NaN == null` is false, so
  // the NaN flows straight through `latchDeparture` into
  // `new Date(NaN).toISOString()`, which THROWS `RangeError: Invalid time
  // value`.
  //
  // That is not hypothetical. This job ran fine for a day, latched its first
  // departure at 2026-09-25 00:25:41, and threw on the very next run five
  // minutes later — then on all 477 runs after it, because the bad row stays
  // the latest row and nothing new can be written. `globalDb.ts` carries the
  // same warning about the same trap; this is the second time it has been
  // walked into, which is why the rule is now "format in SQL", with no
  // exceptions.
  const prev = await db.query(
    `SELECT DISTINCT ON (member_id) member_id, status_state,
            extract(epoch from travel_departed_at) * 1000 AS departed_ms,
            extract(epoch from sampled_at) * 1000 AS sampled_ms
       FROM member_activity_samples
      ORDER BY member_id, sampled_at DESC`,
  )
  const lastSeen = new Map<string, { state: string | null; sampledAt: number; departedAt: number | null }>()
  for (const r of prev.rows) {
    lastSeen.set(String(r.member_id), {
      state: r.status_state,
      sampledAt: Number(r.sampled_ms),
      departedAt: r.departed_ms == null ? null : Number(r.departed_ms),
    })
  }

  const now = Date.now()
  const values: unknown[] = []
  const tuples: string[] = []
  let travelling = 0

  for (const m of roster) {
    const id = String(m.id)
    const state = m.status?.state ?? null
    // ⚠️ The rule lives in travelLatch.ts, stated once in words. Without its
    // freshness guard the first sample after a gap reads a member who left
    // hours ago as having just taken off, and a lead waits on the wrong ETA.
    const departedAt = latchDeparture(lastSeen.get(id) ?? null, { state, sampledAt: now })
    if (state === 'Traveling') travelling += 1

    // ⚠️ `isFinite`, not `!= null`. The blast radius is what makes this worth
    // stating: every member goes in ONE insert, so a single unusable value does
    // not spoil one member's row — it throws, and the whole roster's sample is
    // lost. It cost 94 members two days of sampling. A value we cannot
    // represent is recorded as "we do not know", which is what it is.
    const base = values.length
    values.push(id, m.last_action?.timestamp ?? null, state,
      m.status?.description ?? null, m.status?.plane_image_type ?? null,
      Number.isFinite(departedAt) ? new Date(departedAt as number).toISOString() : null)
    tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::timestamptz)`)
  }

  await db.query(
    `INSERT INTO member_activity_samples
       (member_id, last_action_epoch, status_state, status_description, plane_image_type, travel_departed_at)
     VALUES ${tuples.join(', ')}`,
    values,
  )

  return { rows: roster.length, details: { members: roster.length, travelling } }
}
