// #973 — archives the log of every event attack, both directions, while the
// log still exists.
//
// ⚠️ Driven by `faction_attacks`: any event attack without a stored log is due.
// That is what makes it resumable for free — after an outage or a restart it
// simply carries on from what is missing. Nothing here remembers progress.
//
// ⚠️ Its own loop, not a scraper job, for the same reason as the chain-report
// poller: a job every 15 s would write a `scraper_runs` row each time all year.
// Health lives in `event_attack_log_state`.
//
// ⚠️ Pooled keys only — never the admin key (MonChoon, 2026-10-17).
import type pg from 'pg'
import type { FlagResolver } from '../featureFlags.js'
import type { createKeyPool } from '../scraper/keyPool.js'
import { createTornClient } from '../scraper/tornClient.js'
import {
  createKeySlots, allocate, classifyFailure, retryDelayMs, backlogGrowing,
  DEFAULT_PER_KEY_PER_MIN,
} from './eventAttackLogs.js'

/** How often the archiver looks for due attacks. */
export const RUN_MS = 15_000
/** At most this many logs in flight at once. */
export const CONCURRENCY = 8
/** Keep archiving an ended event's stragglers for this long. */
export const AFTER_END_DAYS = 7
/** How often the list of usable keys is re-read. */
const KEYS_TTL_MS = 5 * 60_000
/** Most pages one log is allowed to run to — a fight has never come close. */
const MAX_PAGES = 10

type Pool = ReturnType<typeof createKeyPool>

export interface AttackLogArchiverDeps {
  db: pg.Pool
  pool: Pool
  tornBaseUrl: string
  flags?: FlagResolver
  now?: () => number
}

export interface RunOutcome {
  events: number
  due: number
  archived: number
  gone: number
  failed: number
  outage: boolean
}

export function createAttackLogArchiver(deps: AttackLogArchiverDeps) {
  const { db, pool } = deps
  const now = deps.now ?? Date.now
  let perKey = DEFAULT_PER_KEY_PER_MIN
  const slots = createKeySlots(() => perKey)
  // One attempt: a failed log is retried on a later run, by schedule.
  const client = createTornClient({
    baseUrl: deps.tornBaseUrl,
    budget: { requests: 100, perMs: 60_000 },
    timeoutMs: 10_000,
    retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  })
  let keys: Array<{ member_id: string; key: string }> = []
  let keysAt = 0
  const history = new Map<number, Array<{ at: number; backlog: number }>>()
  let timer: NodeJS.Timeout | null = null
  let stopped = true

  async function refreshKeys(force = false) {
    if (!force && now() - keysAt < KEYS_TTL_MS) return
    keys = await pool.listKeys()
    keysAt = now()
  }

  async function readFlags() {
    if (!deps.flags) return
    try {
      const v = Number((await deps.flags.get('event_attack_log_per_key_per_min')).value)
      perKey = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PER_KEY_PER_MIN
    } catch { /* keep the last value */ }
  }

  async function fetchLog(code: string, key: string) {
    const pages: unknown[] = []
    let lines = 0
    let offset = 0
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await client.fetch(`/v2/torn/attacklog?log=${encodeURIComponent(code)}&offset=${offset}`, key)
      pages.push(body)
      const n = Array.isArray(body?.attacklog?.log) ? body.attacklog.log.length : 0
      lines += n
      if (!body?._metadata?.links?.next || n === 0) break
      offset += n
    }
    return { pages, lines }
  }

  async function due(eventId: number, us: number, from: number, to: number, limit: number) {
    return db.query(
      `SELECT a.attack_id, a.code, coalesce(l.attempts, 0) AS attempts
         FROM faction_attacks a
         LEFT JOIN event_attack_logs l ON l.attack_id = a.attack_id
        WHERE a.started >= $2 AND a.started < $3 AND a.code IS NOT NULL
          AND (a.attacker_faction_id = $1 OR a.defender_faction_id = $1)
          AND (l.attack_id IS NULL OR (l.status = 'failed' AND l.next_attempt_at <= now()))
        ORDER BY a.started
        LIMIT $4`,
      [us, Math.floor(from / 1000), Math.ceil(to / 1000), limit],
    )
  }

  async function backlogOf(eventId: number, us: number, from: number, to: number) {
    const r = await db.query(
      `SELECT count(*) AS n
         FROM faction_attacks a
         LEFT JOIN event_attack_logs l ON l.attack_id = a.attack_id
        WHERE a.started >= $2 AND a.started < $3 AND a.code IS NOT NULL
          AND (a.attacker_faction_id = $1 OR a.defender_faction_id = $1)
          AND (l.attack_id IS NULL OR l.status = 'failed')`,
      [us, Math.floor(from / 1000), Math.ceil(to / 1000)],
    )
    return Number(r.rows[0].n)
  }

  async function saveState(eventId: number, fields: Record<string, unknown>) {
    const cols = Object.keys(fields)
    await db.query(
      `INSERT INTO event_attack_log_state (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING`, [eventId])
    if (cols.length === 0) return
    await db.query(
      `UPDATE event_attack_log_state SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE event_id = $1`,
      [eventId, ...cols.map((c) => fields[c])],
    )
  }

  /** One pass over every event still being archived. Exported for tests. */
  async function runOnce(): Promise<RunOutcome> {
    const out: RunOutcome = { events: 0, due: 0, archived: 0, gone: 0, failed: 0, outage: false }
    const evs = await db.query(
      `SELECT id, (extract(epoch from starts_at) * 1000)::bigint AS start_ms,
              (extract(epoch from ended_at) * 1000)::bigint AS end_ms
         FROM faction_events
        WHERE starts_at <= to_timestamp($1::bigint / 1000.0)
          AND (ended_at IS NULL OR ended_at > to_timestamp($1::bigint / 1000.0) - make_interval(days => $2))
        ORDER BY starts_at`,
      [now(), AFTER_END_DAYS],
    )
    if (evs.rows.length === 0) return out
    const us = Number((await db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')).rows[0]?.torn_faction_id)
    if (!Number.isFinite(us) || us <= 0) return out

    await readFlags()
    await refreshKeys()

    for (const ev of evs.rows) {
      out.events++
      const eventId = Number(ev.id)
      const from = Number(ev.start_ms)
      const to = ev.end_ms == null ? now() : Math.min(now(), Number(ev.end_ms))

      const t = now()
      const plan = allocate(keys.map((k) => k.member_id), (id) => slots.free(id, t), 1_000)
      const todo = plan.length === 0 ? { rows: [] as any[] } : await due(eventId, us, from, to, plan.length)
      out.due += todo.rows.length
      const keyOf = new Map(keys.map((k) => [k.member_id, k.key]))
      let calls = 0
      let lastError: string | null = null

      const jobs = todo.rows.map((row: any, i: number) => ({ row, member: plan[i] }))
      let cursor = 0
      const worker = async () => {
        while (cursor < jobs.length && !out.outage) {
          const { row, member } = jobs[cursor++]
          const key = keyOf.get(member)
          if (!key) continue
          slots.use(member, now())
          calls++
          try {
            const { pages, lines } = await fetchLog(row.code, key)
            await db.query(
              `INSERT INTO event_attack_logs (attack_id, event_id, code, status, raw, lines, attempts, fetched_at)
               VALUES ($1, $2, $3, 'archived', $4::jsonb, $5, $6, now())
               ON CONFLICT (attack_id) DO UPDATE SET status = 'archived', raw = EXCLUDED.raw,
                 lines = EXCLUDED.lines, attempts = EXCLUDED.attempts, last_error = NULL,
                 next_attempt_at = NULL, fetched_at = now()`,
              [row.attack_id, eventId, row.code, JSON.stringify({ pages }), lines, Number(row.attempts) + 1],
            )
            out.archived++
          } catch (err) {
            const f = classifyFailure(err)
            const message = err instanceof Error ? err.message : String(err)
            if (f.kind === 'gone') {
              await db.query(
                `INSERT INTO event_attack_logs (attack_id, event_id, code, status, attempts, last_error)
                 VALUES ($1, $2, $3, 'gone', $4, $5)
                 ON CONFLICT (attack_id) DO UPDATE SET status = 'gone', attempts = EXCLUDED.attempts,
                   last_error = EXCLUDED.last_error, next_attempt_at = NULL, fetched_at = now()`,
                [row.attack_id, eventId, row.code, Number(row.attempts) + 1, message],
              )
              out.gone++
            } else if (f.kind === 'bad-key') {
              await pool.disable(member, message.replace(/^Torn API error /, 'Torn error '))
              keyOf.delete(member)
              await refreshKeys(true)
            } else if (f.kind === 'rate-limited') {
              slots.pause(member, now())
            } else if (f.kind === 'outage') {
              out.outage = true
              lastError = message
            } else {
              const attempts = Number(row.attempts) + 1
              await db.query(
                `INSERT INTO event_attack_logs (attack_id, event_id, code, status, attempts, last_error, next_attempt_at)
                 VALUES ($1, $2, $3, 'failed', $4, $5, to_timestamp($6::bigint / 1000.0))
                 ON CONFLICT (attack_id) DO UPDATE SET status = 'failed', attempts = EXCLUDED.attempts,
                   last_error = EXCLUDED.last_error, next_attempt_at = EXCLUDED.next_attempt_at, fetched_at = now()`,
                [row.attack_id, eventId, row.code, attempts, message, now() + retryDelayMs(attempts)],
              )
              out.failed++
              lastError = message
            }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))

      const backlog = await backlogOf(eventId, us, from, to)
      const h = (history.get(eventId) ?? []).concat({ at: now(), backlog }).filter((x) => now() - x.at <= 15 * 60_000)
      history.set(eventId, h)
      const growing = backlogGrowing(h, now())
      const prev = await db.query('SELECT growing_since FROM event_attack_log_state WHERE event_id = $1', [eventId])
      const wasGrowing = prev.rows[0]?.growing_since != null
      if (growing && !wasGrowing) {
        console.warn(`[attack-log-archive] event ${eventId}: backlog is GROWING (${backlog} due) — logs may be lost`)
      }
      await saveState(eventId, {
        backlog,
        keys_available: keys.length,
        last_run_at: new Date(now()), // db-time-safe: epoch ms
        ...(growing ? (wasGrowing ? {} : { growing_since: new Date(now()) }) : { growing_since: null }), // db-time-safe: epoch ms
        ...(lastError ? { last_error: lastError, last_error_at: new Date(now()) } : {}), // db-time-safe: epoch ms
      })
      if (calls > 0) {
        await db.query('UPDATE event_attack_log_state SET calls = calls + $2 WHERE event_id = $1', [eventId, calls])
      }
      if (keys.length === 0) {
        await saveState(eventId, { last_error: 'no pooled key available', last_error_at: new Date(now()) }) // db-time-safe: epoch ms
      }
    }
    return out
  }

  async function loop() {
    if (stopped) return
    try {
      const out = await runOnce()
      if (out.outage) console.warn('[attack-log-archive] Torn unavailable — will retry next run')
    } catch (err) {
      console.error('[attack-log-archive] run crashed:', err instanceof Error ? err.message : err)
    }
    if (!stopped) timer = setTimeout(loop, RUN_MS)
  }

  return {
    runOnce,
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
  }
}
