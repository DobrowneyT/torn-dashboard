// Per-member Torn event start windows (#459).
//
// Each Torn player picks a personal event start hour; during an event their
// 48-hour window opens at that time. `GET /v2/user/calendar` returns it:
//
//   { "calendar": { "start_time": "11:30 TCT" } }
//
// ⚠️ Every call here uses **that member's own key**, never a pooled one. The
// endpoint answers for the CALLER, so a rotating key would report the key
// owner's hour under every member's name — the whole faction showing one time,
// which looks entirely plausible and is entirely wrong.
//
// ⚠️ Only members who opted into the calendar scope are touched at all. That is
// enforced in the query (`listCalendarScopedKeys`), not here, so there is one
// place to get it right rather than one per caller.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

export async function memberEventWindowsJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const keys = await pool.listCalendarScopedKeys()
  if (keys.length === 0) {
    return { rows: 0, details: { note: 'nobody has opted into the calendar scope' } }
  }

  let written = 0
  let failed = 0

  for (const { member_id, key } of keys) {
    let startTime: string | null = null
    try {
      const data = await client.fetch('/v2/user/calendar', key)
      const raw = data?.calendar?.start_time
      startTime = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
    } catch {
      // One member's bad key must not end the run for everyone else. The next
      // run retries them, and a persistently failing key surfaces through the
      // key pool's own error handling rather than being re-diagnosed here.
      failed++
      continue
    }

    // ⚠️ A member who has not set a start time has no row, rather than a row
    // saying "unknown". The UI shows a dash for both, but only one of them is
    // something we are storing about a person.
    if (startTime === null) {
      await db.query('DELETE FROM member_event_settings WHERE member_id = $1', [member_id])
      continue
    }

    await db.query(
      `INSERT INTO member_event_settings (member_id, start_time, fetched_at)
       VALUES ($1, $2, now())
       ON CONFLICT (member_id) DO UPDATE SET
         start_time = EXCLUDED.start_time, fetched_at = now()`,
      [member_id, startTime]
    )
    written++
  }

  // Anyone who withdrew since the last run still has a row until something
  // deletes it. The withdrawal endpoint deletes immediately; this is the
  // backstop for a row whose consent vanished by another route (key removed,
  // member left), so stored data never outlives its permission.
  const orphaned = await db.query(
    `DELETE FROM member_event_settings
      WHERE member_id NOT IN (
        SELECT member_id FROM member_secrets WHERE calendar_scope_at IS NOT NULL
      )`
  )

  return {
    rows: written,
    details: { written, failed, considered: keys.length, orphans_removed: orphaned.rowCount ?? 0 },
  }
}
