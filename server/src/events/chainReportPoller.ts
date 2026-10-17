// #970 — polls Torn's live chain report while a faction event is live.
//
// ⚠️ Its own loop, not a scraper job. The scheduler writes a `scraper_runs` row
// per run, and a 5-second job would add 17,000 a day per tenant all year round
// — including the eleven months with no event, when every run would be a skip.
// Health lives in `event_chain_report_poll_state` instead.
//
// ⚠️ Chain Watch and this share nothing with the War Room (see chainSample.ts):
// a Halloween chain has no opponent, and the War Room only runs during a war.
//
// ⚠️ **`timestamp` on every call.** Measured 2026-10-17 on a live chain: a
// plain call served the same cached answer for ~30 seconds; with `timestamp`
// every call was fresh, picking up a hit within 3 seconds. Without it a 5-second
// cadence would be six calls for one answer.
import type pg from 'pg'
import type { FlagResolver } from '../featureFlags.js'
import type { createKeyPool } from '../scraper/keyPool.js'
import { createTornClient, TornApiError } from '../scraper/tornClient.js'
import { currentEvent } from './eventRoutes.js'
import {
  normaliseReport, reportHash, belongsToEvent, chainReportEnded, nextDelayMs, shouldSnapshot,
} from './eventChainReport.js'

/** Default cadence. Tunable per tenant: flag `event_chain_report_poll_sec` (0 = off). */
export const DEFAULT_POLL_SEC = 5
/** Default full-snapshot spacing. Tunable: flag `event_chain_report_snapshot_min`. */
export const DEFAULT_SNAPSHOT_MIN = 5
/** How often the loop re-asks "is an event live?" when it is not polling. */
export const IDLE_MS = 30_000

// Torn error codes that mean the KEY is bad — the same set sampleCapture uses.
const KEY_DISABLE_CODES = new Set([2, 10, 13])

type Pool = ReturnType<typeof createKeyPool>

export interface ChainReportPollerDeps {
  db: pg.Pool
  pool: Pool
  tornBaseUrl: string
  flags?: FlagResolver
  /** Test seam. */
  now?: () => number
}

export type PollOutcome =
  | { kind: 'idle'; reason: string }
  | { kind: 'changed'; chainId: number; snapshot: boolean }
  | { kind: 'unchanged'; chainId: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string }

async function flagNumber(flags: FlagResolver | undefined, key: string, fallback: number) {
  if (!flags) return fallback
  try {
    const v = (await flags.get(key)).value
    const n = Number(v)
    return v === undefined || !Number.isFinite(n) || n < 0 ? fallback : n
  } catch {
    return fallback
  }
}

export function createChainReportPoller(deps: ChainReportPollerDeps) {
  const { db, pool } = deps
  const now = deps.now ?? Date.now
  // ⚠️ One attempt and a short timeout: the next poll five seconds later IS
  // the retry, and a backoff chain inside one poll would only put staler data
  // behind fresher. Outage backoff happens between polls (nextDelayMs).
  const client = createTornClient({
    baseUrl: deps.tornBaseUrl,
    budget: { requests: 20, perMs: 60_000 },
    timeoutMs: 8_000,
    retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  })

  let event: { id: number; starts_at: number } | null = null
  let eventCheckedAt = 0
  let factionId: number | null = null
  let timer: NodeJS.Timeout | null = null
  let stopped = true
  let consecutiveFailures = 0

  async function liveEvent(): Promise<{ id: number; starts_at: number } | null> {
    if (now() - eventCheckedAt < IDLE_MS && eventCheckedAt !== 0) return event
    const e = await currentEvent(db, now())
    event = e && e.phase === 'live' ? { id: e.id, starts_at: e.starts_at } : null
    eventCheckedAt = now()
    return event
  }

  async function ourFaction(): Promise<number | null> {
    if (factionId != null) return factionId
    const r = await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const id = Number(r.rows[0]?.torn_faction_id)
    factionId = Number.isFinite(id) && id > 0 ? id : null
    return factionId
  }

  async function record(eventId: number, sql: string, params: unknown[] = []) {
    await db.query(
      `INSERT INTO event_chain_report_poll_state (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING`,
      [eventId],
    )
    await db.query(`UPDATE event_chain_report_poll_state SET ${sql}, updated_at = now() WHERE event_id = $1`,
      [eventId, ...params])
  }

  /** One poll. Exported for tests and an admin "poll now". */
  async function pollOnce(): Promise<PollOutcome> {
    const e = await liveEvent()
    if (!e) return { kind: 'idle', reason: 'no live event' }
    const pollSec = await flagNumber(deps.flags, 'event_chain_report_poll_sec', DEFAULT_POLL_SEC)
    if (pollSec === 0) return { kind: 'idle', reason: 'polling switched off (event_chain_report_poll_sec = 0)' }
    const us = await ourFaction()
    if (!us) return { kind: 'idle', reason: 'no faction id configured' }

    const fail = async (error: string): Promise<PollOutcome> => {
      consecutiveFailures++
      await record(e.id,
        `polls = polls + 1, failures = failures + 1, consecutive_failures = $2,
         last_error = $3, last_error_at = now()`, [consecutiveFailures, error])
      return { kind: 'failed', error }
    }

    const claimed = await pool.claim()
    if (!claimed) return fail('no pooled key available')

    let report
    try {
      const body = await client.fetch(`/v2/faction/chainreport?timestamp=${Math.floor(now() / 1000)}`, claimed.key)
      report = normaliseReport(body)
    } catch (err) {
      if (err instanceof TornApiError && KEY_DISABLE_CODES.has(err.tornCode)) {
        await pool.disable(claimed.member_id, `Torn error ${err.tornCode}: key rejected`)
      }
      return fail(err instanceof Error ? err.message : String(err))
    }
    const polledAt = now()

    // A healthy poll from here on, whatever it finds.
    consecutiveFailures = 0
    const skip = async (reason: string): Promise<PollOutcome> => {
      await record(e.id,
        `polls = polls + 1, skipped = skipped + 1, consecutive_failures = 0,
         last_ok_at = to_timestamp($2::bigint / 1000.0), last_skip_reason = $3`, [polledAt, reason])
      return { kind: 'skipped', reason }
    }

    // ⚠️ A key whose owner has LEFT answers with their new faction's report.
    // Never store it; members-sync is what retires that key.
    if (report.factionId !== us) {
      return skip(`key of member ${claimed.member_id} reported faction ${report.factionId}, not ${us}`)
    }
    if (!belongsToEvent(report, e.starts_at)) {
      return skip(`latest chain ${report.chainId} ended before the event opened — waiting for the event chain`)
    }

    const hash = reportHash(report)
    const prev = await db.query(
      `SELECT content_hash FROM event_chain_report_latest WHERE event_id = $1`, [e.id])
    if (prev.rows[0]?.content_hash === hash) {
      await record(e.id,
        `polls = polls + 1, consecutive_failures = 0, last_ok_at = to_timestamp($2::bigint / 1000.0)`,
        [polledAt])
      return { kind: 'unchanged', chainId: report.chainId }
    }

    const at = polledAt
    const start = report.startMs
    const end = report.endMs
    const json = (v: unknown) => JSON.stringify(v)
    await db.query(
      `INSERT INTO event_chain_report_latest
         (event_id, chain_id, chain_start, chain_end, details, attackers, bonuses, non_attackers, content_hash, sampled_at)
       VALUES ($1, $2, to_timestamp($3::bigint / 1000.0), to_timestamp($4::bigint / 1000.0),
               $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, to_timestamp($10::bigint / 1000.0))
       ON CONFLICT (event_id) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, chain_start = EXCLUDED.chain_start, chain_end = EXCLUDED.chain_end,
         details = EXCLUDED.details, attackers = EXCLUDED.attackers, bonuses = EXCLUDED.bonuses,
         non_attackers = EXCLUDED.non_attackers, content_hash = EXCLUDED.content_hash,
         sampled_at = EXCLUDED.sampled_at`,
      [e.id, report.chainId, start, end, json(report.details), json(report.attackers),
        json(report.bonuses), json(report.nonAttackers), hash, at],
    )
    await db.query(
      `INSERT INTO event_chain_report_samples (event_id, chain_id, chain_start, chain_end, details, sampled_at)
       VALUES ($1, $2, to_timestamp($3::bigint / 1000.0), to_timestamp($4::bigint / 1000.0), $5::jsonb,
               to_timestamp($6::bigint / 1000.0))`,
      [e.id, report.chainId, start, end, json(report.details), at],
    )

    const last = await db.query(
      `SELECT chain_id, (extract(epoch from sampled_at) * 1000)::bigint AS ms
         FROM event_chain_report_snapshots WHERE event_id = $1 ORDER BY sampled_at DESC LIMIT 1`, [e.id])
    const snapMin = await flagNumber(deps.flags, 'event_chain_report_snapshot_min', DEFAULT_SNAPSHOT_MIN)
    const snapshot = shouldSnapshot({
      lastSnapshotAtMs: last.rows[0] ? Number(last.rows[0].ms) : null,
      lastChainId: last.rows[0] ? Number(last.rows[0].chain_id) : null,
      chainId: report.chainId,
      ended: chainReportEnded(end, polledAt),
      nowMs: polledAt,
      intervalMs: snapMin * 60_000,
    })
    if (snapshot) {
      await db.query(
        `INSERT INTO event_chain_report_snapshots
           (event_id, chain_id, chain_start, chain_end, details, attackers, bonuses, non_attackers, sampled_at)
         VALUES ($1, $2, to_timestamp($3::bigint / 1000.0), to_timestamp($4::bigint / 1000.0),
                 $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, to_timestamp($9::bigint / 1000.0))`,
        [e.id, report.chainId, start, end, json(report.details), json(report.attackers),
          json(report.bonuses), json(report.nonAttackers), at],
      )
    }
    await record(e.id,
      `polls = polls + 1, changes = changes + 1, consecutive_failures = 0,
       last_ok_at = to_timestamp($2::bigint / 1000.0), last_change_at = to_timestamp($2::bigint / 1000.0)`,
      [polledAt])
    return { kind: 'changed', chainId: report.chainId, snapshot }
  }

  async function loop() {
    if (stopped) return
    let delay = IDLE_MS
    try {
      const out = await pollOnce()
      if (out.kind !== 'idle') {
        const base = (await flagNumber(deps.flags, 'event_chain_report_poll_sec', DEFAULT_POLL_SEC)) * 1000
        delay = nextDelayMs(base, consecutiveFailures)
      }
      if (out.kind === 'failed' && consecutiveFailures === 1) {
        // Once per run of failures, so an hours-long outage is one log line.
        console.warn(`[event-chain-report] poll failed, backing off: ${out.error}`)
      }
    } catch (err) {
      // A database error, not Torn. Never let it kill the loop.
      console.error('[event-chain-report] poll crashed:', err instanceof Error ? err.message : err)
    }
    if (!stopped) timer = setTimeout(loop, delay)
  }

  return {
    pollOnce,
    start() {
      if (!stopped) return
      stopped = false
      timer = setTimeout(loop, 0)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    /** Forget the cached event, so a change shows on the next poll. */
    invalidate() { eventCheckedAt = 0 },
  }
}
