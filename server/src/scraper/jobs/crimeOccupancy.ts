// #389 — observed OC occupancy.
//
// Torn reports when a member JOINED a crime and who occupies it right now. It
// never reports when someone LEFT. Everything downstream of that gap has been
// inference: crime status, execution time, and the absence of a slot row,
// assembled into a guessed departure. Four passes at that inference (#168,
// #262, #389, #392) each found a real defect and the payout stayed wrong,
// because the case that matters — a member moved to a different crime before
// the first executes — is the one where every guess has to be right at once.
//
// So this job stops guessing. Once a minute it asks what the crimes look like
// now and writes down what it saw. A stint's end is the last poll that still
// saw the member in the slot, which is accurate to the poll interval and is
// honestly a lower bound rather than a derived fact.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

/**
 * One page is enough.
 *
 * MonChoon: "we will NEVER have more than 100 active crimes open at a time."
 * `cat=all` returns up to 100, newest first, which is exactly the working set.
 * This is deliberately NOT crimes-sync's paginated backlog sweep — that job
 * walks history from the oldest unexecuted crime and runs every 30 minutes.
 * Occupancy needs the opposite: the current picture, cheaply, often.
 */
const CRIMES_PATH = '/v2/faction/crimes?cat=all'

interface Slot {
  position_id?: number | string | null
  position?: string | null
  user?: { id?: number | string | null; joined_at?: number | null } | null
}
interface Crime {
  id: number | string
  slots?: Slot[]
}

/** An occupancy observation: one member, in one slot, at poll time. */
export interface Observation {
  crimeId: string
  memberId: string
  positionId: string | null
  tornJoinedAt: number | null
}

/** Flatten a crimes payload into the (crime, member, slot) triples occupied now. */
export function observationsFrom(crimes: Crime[]): Observation[] {
  const out: Observation[] = []
  for (const crime of crimes ?? []) {
    for (const slot of crime.slots ?? []) {
      const user = slot.user
      if (!user || user.id == null) continue
      out.push({
        crimeId: String(crime.id),
        memberId: String(user.id),
        // position_id identifies the seat; a member moved between seats in one
        // crime genuinely left the seat they held, so it ends that stint.
        positionId: slot.position_id != null ? String(slot.position_id) : null,
        tornJoinedAt: user.joined_at != null ? Number(user.joined_at) : null,
      })
    }
  }
  return out
}

/**
 * Reconcile one poll against the stored stints.
 *
 * Exported for the tests, which drive it directly rather than through the
 * scraper scheduler — the reconciliation is the whole risk surface here and it
 * deserves to be exercised without a cron in the way.
 */
export async function applyPoll(
  dbc: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> },
  crimes: Crime[],
  nowSec: number
): Promise<{ crimesSeen: number; slotsSeen: number; opened: number; closed: number }> {
  const observations = observationsFrom(crimes)

  // The crimes we actually looked at this poll. Everything below is scoped to
  // these ids, and that scoping is the single most important line in the file
  // — see the note on the close step.
  const observedCrimeIds = [...new Set((crimes ?? []).map((c) => String(c.id)))]

  let opened = 0

  for (const o of observations) {
    // Extend the open stint if there is one, otherwise start one. A single
    // statement so a concurrent run cannot interleave between the check and
    // the write; the partial unique index makes the conflict target exact.
    const res = await dbc.query(
      `INSERT INTO crime_occupancy
         (crime_id, member_id, position_id, torn_joined_at, first_seen_at, last_seen_at, closed)
       VALUES ($1, $2, $3, $4, $5, $5, false)
       ON CONFLICT (crime_id, member_id, COALESCE(position_id, '')) WHERE NOT closed
       DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         -- Torn's joined_at can arrive late (a slot seen before the payload
         -- carries it). Fill it in, but never overwrite a value we already
         -- have: the first reading is the one closest to the actual join.
         torn_joined_at = COALESCE(crime_occupancy.torn_joined_at, EXCLUDED.torn_joined_at),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [o.crimeId, o.memberId, o.positionId, o.tornJoinedAt, nowSec]
    )
    if (res.rows[0]?.inserted) opened += 1
  }

  // Close stints for members no longer occupying — but ONLY within crimes that
  // were in this response.
  //
  // A crime absent from the page means we did not look at it. It does not mean
  // its occupants left. Closing on absence would fabricate a departure AND
  // stamp it with a specific time, which then reads as data rather than as a
  // guess. This is exactly the #330 mistake, where a guard asked "did this row
  // change?" while meaning "were we watching?", and it cost a fortnight.
  //
  // The consequence of the narrow scope is that a crime which stops being
  // returned (executed and aged out) leaves its stints open forever. That is
  // the correct trade: an open stint ends at its last observation, which is
  // true, whereas a fabricated close is not.
  let closed = 0
  if (observedCrimeIds.length > 0) {
    const keys = observations.map((o) => `${o.crimeId}|${o.memberId}|${o.positionId ?? ''}`)
    const res = await dbc.query(
      `UPDATE crime_occupancy
          SET closed = true, updated_at = now()
        WHERE NOT closed
          AND crime_id = ANY($1)
          AND (crime_id || '|' || member_id || '|' || COALESCE(position_id, '')) <> ALL($2)`,
      [observedCrimeIds, keys]
    )
    closed = res.rowCount ?? 0
  }

  await dbc.query(
    `INSERT INTO crime_occupancy_polls (polled_at, crimes_seen, slots_seen, opened, closed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (polled_at) DO UPDATE SET
       crimes_seen = EXCLUDED.crimes_seen, slots_seen = EXCLUDED.slots_seen,
       opened = EXCLUDED.opened, closed = EXCLUDED.closed`,
    [nowSec, observedCrimeIds.length, observations.length, opened, closed]
  )

  return { crimesSeen: observedCrimeIds.length, slotsSeen: observations.length, opened, closed }
}

export async function crimeOccupancyJob({ db, pool, client }: JobDeps): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const data = await client.fetch(CRIMES_PATH, claimed.key)
  const crimes: Crime[] = data.crimes ?? []
  const nowSec = Math.floor(Date.now() / 1000)

  const dbc = await db.connect()
  let stats
  try {
    await dbc.query('BEGIN')
    stats = await applyPoll(dbc, crimes, nowSec)
    await dbc.query('COMMIT')
  } catch (err) {
    await dbc.query('ROLLBACK')
    throw err
  } finally {
    dbc.release()
  }

  return {
    rows: stats.slotsSeen,
    details: {
      crimes_seen: stats.crimesSeen,
      slots_seen: stats.slotsSeen,
      stints_opened: stats.opened,
      stints_closed: stats.closed,
    },
  }
}
