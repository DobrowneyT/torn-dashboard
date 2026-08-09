// Faction revives sync.
//
// Two entry points over one upsert:
//
//   revivesSyncJob(deps, warId)  — the original per-war backfill (port of
//     scripts/fetch_revives_for_war.py), triggered from the war pages. Walks
//     one ranked war's window and tags every row with that war id.
//
//   revivesContinuousJob(deps)   — the standing cron job (#358), mirroring
//     attacks-sync: incremental forward from the newest stored revive, no war
//     boundary. This is what keeps the rolling 24-hour revive history current,
//     which is what the War Room's revive-chance estimate is computed from.
//
// Both use `filters=incoming`, i.e. revives our members RECEIVED, whoever did
// the reviving. That is deliberately the whole set that matters here: a
// target's revive score counts revives *received*, and the outside revivers we
// pay show up on exactly these rows (with their `skill`). Revives our own
// members performed on other factions don't affect either question.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import { TornApiError } from '../tornClient.js'

const PAGE_FULL = 100

// Transient Torn errors (#247): too-many-requests (5) / IP-block (8). Same
// soft-stop as attacks-sync — rows already upserted stay, and the next run
// resumes from the newest stored revive.
const RATE_LIMIT_CODES = new Set([5, 8])

/**
 * Where the continuous job starts when nothing is stored: the beginning,
 * exactly like attacks-sync.
 *
 * This was capped at seven days on the grounds that "the only consumer is a
 * rolling 24-hour score". That was simply wrong — the War Overview reads
 * `faction_revives` across whole war windows (GET /api/wars/:id/revives), and
 * has since long before the revive-chance column existed. A seven-day cold
 * start left every war older than a week with empty revive charts unless
 * someone remembered to run the per-war backfill by hand.
 *
 * Revives are the same kind of record as attacks and deserve the same
 * treatment: fetch the lot, once, and stay current from there. The first run
 * is long; every run after it reads one page.
 */
const COLD_START_FROM = 0

interface ReviveRow {
  raw: any
  /** Ranked war this revive falls inside, or null. */
  warId: number | null
}

/**
 * Flatten and upsert one revive.
 *
 * `rw_id` is COALESCEd rather than assigned: the continuous job writes null for
 * anything outside a war window, and must never blank a tag the per-war
 * backfill has already resolved.
 */
async function upsertRevive(db: JobDeps['db'], { raw, warId }: ReviveRow) {
  const reviver = raw.reviver ?? {}
  const target = raw.target ?? {}
  const lastAction = target.last_action
  await db.query(
    `INSERT INTO faction_revives (revive_id, rw_id, "timestamp", reviver_id, reviver_name,
       reviver_faction_id, reviver_faction_name, reviver_skill, target_id, target_name,
       target_faction_id, target_faction_name, hospital_reason, early_discharge,
       target_last_action, target_online_status, success_chance, result, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
     ON CONFLICT (revive_id) DO UPDATE SET
       rw_id = COALESCE(EXCLUDED.rw_id, faction_revives.rw_id),
       hospital_reason = EXCLUDED.hospital_reason,
       early_discharge = EXCLUDED.early_discharge, result = EXCLUDED.result,
       success_chance = EXCLUDED.success_chance, fetched_at = now()`,
    [raw.id, warId, raw.timestamp ?? null, reviver.id ?? null, reviver.name ?? null,
     reviver.faction?.id ?? null, reviver.faction?.name ?? null, reviver.skill ?? null,
     target.id ?? null, target.name ?? null, target.faction?.id ?? null,
     target.faction?.name ?? null, target.hospital_reason ?? null,
     Boolean(target.early_discharge ?? false),
     typeof lastAction === 'object' && lastAction !== null ? lastAction.timestamp ?? null : lastAction ?? null,
     target.online_status ?? null, raw.success_chance ?? null, raw.result ?? null]
  )
}

export async function revivesSyncJob({ db, pool, client }: JobDeps, warId: number): Promise<RunResult> {
  const war = await db.query('SELECT start_at, end_at FROM ranked_wars WHERE id = $1', [warId])
  if (war.rows.length === 0) throw new Error(`War ${warId} not found`)
  const from = Number(war.rows[0].start_at)
  const to = war.rows[0].end_at ? Number(war.rows[0].end_at) : Math.floor(Date.now() / 1000)

  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  let rows = 0
  let cursor = from
  for (;;) {
    const data = await client.fetch(
      `/v2/faction/revives?filters=incoming&striptags=true&sort=ASC&from=${cursor}&to=${to}`,
      claimed.key
    )
    const revives: any[] = data.revives ?? []
    if (revives.length === 0) break

    for (const raw of revives) {
      await upsertRevive(db, { raw, warId })
      rows += 1
    }

    if (revives.length < PAGE_FULL) break
    cursor = revives[revives.length - 1].timestamp ?? cursor
  }

  return { rows, details: { war_id: warId, from, to } }
}

/** Ranked-war windows, newest first, for tagging a revive by its timestamp. */
async function warWindows(db: JobDeps['db']): Promise<Array<{ id: number; start: number; end: number }>> {
  const res = await db.query(
    `SELECT id, start_at, end_at FROM ranked_wars WHERE start_at IS NOT NULL ORDER BY start_at DESC`
  )
  return res.rows.map((r: any) => ({
    id: Number(r.id),
    start: Number(r.start_at),
    // An ongoing war has no end yet; treat it as running to now.
    end: r.end_at != null ? Number(r.end_at) : Number.MAX_SAFE_INTEGER,
  }))
}

/**
 * The standing revives feed (#358).
 *
 * Incremental forward from `max(timestamp)`, inclusive of that second so a
 * revive sharing the newest timestamp can't be skipped — the upsert makes
 * re-seen rows idempotent.
 *
 * `from` overrides that cursor and walks forward from wherever you point it,
 * ignoring what is already stored. This is how a faction that only has partial
 * history gets the rest WITHOUT deleting anything first: the upsert refreshes
 * rows it has already seen and inserts the ones it hasn't.
 *
 * Deleting to force a re-pull would be the obvious alternative and is strictly
 * worse. It opens a window where the data is simply gone, and if Torn's own
 * retention turns out to be shorter than our stored history, everything past
 * their horizon is gone permanently — traded for nothing, because this option
 * reaches the same end state.
 */
export async function revivesContinuousJob(
  { db, pool, client }: JobDeps,
  opts: { from?: number } = {}
): Promise<RunResult> {
  const claimed = await pool.claim()
  if (!claimed) throw new Error('no pooled key available')

  const newest = await db.query('SELECT max("timestamp") AS ts FROM faction_revives')
  const coldStart = newest.rows[0].ts == null
  const forced = Number.isFinite(opts.from as number) ? Number(opts.from) : null
  let cursor = forced ?? (coldStart ? COLD_START_FROM : Number(newest.rows[0].ts))

  const wars = await warWindows(db)
  const warFor = (ts: number | null) => {
    if (ts == null) return null
    return wars.find((w) => ts >= w.start && ts <= w.end)?.id ?? null
  }

  let rows = 0
  let pages = 0
  let rateLimited = false
  for (;;) {
    let data: any
    try {
      data = await client.fetch(
        `/v2/faction/revives?filters=incoming&striptags=true&sort=ASC&from=${cursor}&limit=${PAGE_FULL}`,
        claimed.key
      )
    } catch (err) {
      if (err instanceof TornApiError && RATE_LIMIT_CODES.has(err.tornCode)) { rateLimited = true; break }
      throw err
    }
    const revives: any[] = data.revives ?? []
    pages += 1
    if (revives.length === 0) break

    for (const raw of revives) {
      await upsertRevive(db, { raw, warId: warFor(raw.timestamp ?? null) })
      rows += 1
    }

    if (revives.length < PAGE_FULL) break
    const last = revives[revives.length - 1].timestamp
    // A full page whose cursor did not advance would loop forever — that
    // happens when 100+ revives share one second. Step past it and accept the
    // (vanishingly unlikely) loss rather than spin.
    cursor = last != null && Number(last) > cursor ? Number(last) : cursor + 1
  }

  return {
    rows,
    details: {
      pages, from: cursor, cold_start: coldStart, rate_limited: rateLimited,
      // Distinguishes a deliberate backfill from the routine tail in the run
      // log, where the row count would otherwise look alarming.
      backfill_from: forced,
    },
  }
}
