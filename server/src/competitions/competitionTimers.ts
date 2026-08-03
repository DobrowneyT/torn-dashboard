// Precise competition boundary timers (#230). Each fixed competition gets a
// one-off timer at its start (capture a baseline sample) and at its end (capture
// a final sample, then freeze auto-resolving contests) — so a contest with a
// hard time cutoff freezes on the values as they were at that exact instant,
// with no leader action. Timers are re-armed from the DB on boot; the
// auto-resolve tick (runAutoResolve) is the backstop if a timer was missed.
//
// Boundary captures stamp the sample AT the boundary instant (see
// captureBoundarySamples) so it counts as the "latest sample ≤ boundary" during
// resolution.
import type pg from 'pg'
import type { JobDeps } from '../scraper/jobs/itemsSync.js'
import { captureBoundarySamples } from '../scraper/sampleCapture.js'
import { toDate, resolveCompetition, type CompetitionRow } from '../competitions.js'

// A start instant this far in the past is treated as "starting now" (capture a
// baseline immediately); older than this, we skip the baseline capture and let
// resolution fall back to the latest existing reading ≤ start — a now() capture
// would otherwise fabricate a false-dated historical point.
const START_GRACE_MS = 5 * 60_000

// setTimeout's max delay (~24.8 days); longer delays must be chained or Node
// fires them immediately.
const MAX_DELAY = 2_147_483_647

/**
 * The pure scheduling decision for a competition, relative to `nowMs`:
 * - `start`: ms until the start capture, `'now'` for an immediate baseline, or
 *   null (rolling, no window, or a long-past start).
 * - `end`: ms until the end capture, or null (rolling/no window, or past end —
 *   the backstop handles a passed end).
 */
export function scheduleFor(
  comp: CompetitionRow,
  nowMs: number
): { start: number | 'now' | null; end: number | null } {
  if (comp.window_kind !== 'fixed' || comp.window_start == null || comp.window_end == null) {
    return { start: null, end: null }
  }
  const startTs = toDate(comp.window_start).getTime()
  const endTs = toDate(comp.window_end).getTime()
  let start: number | 'now' | null
  if (startTs > nowMs) start = startTs - nowMs
  else if (nowMs - startTs <= START_GRACE_MS) start = 'now'
  else start = null
  return { start, end: endTs > nowMs ? endTs - nowMs : null }
}

export interface TimerHandle { current: NodeJS.Timeout | null }

function defaultSetTimer(fn: () => void, ms: number): TimerHandle {
  const holder: TimerHandle = { current: null }
  const arm = (remaining: number) => {
    const d = Math.min(remaining, MAX_DELAY)
    holder.current = setTimeout(() => {
      const left = remaining - d
      if (left > 0) arm(left)
      else fn()
    }, d)
    holder.current.unref?.()
  }
  arm(ms)
  return holder
}

function defaultClearTimer(handle: TimerHandle) {
  if (handle?.current) clearTimeout(handle.current)
}

export interface CompetitionTimersOptions {
  db: pg.Pool
  /** Deps for the boundary capture (pool + client). */
  deps: JobDeps
  /** Capture a sample for every current member stamped at `at`. Injectable. */
  capture?: (deps: JobDeps, at: Date) => Promise<number>
  /** Freeze an auto-resolving competition. Injectable. */
  resolve?: (comp: CompetitionRow) => Promise<unknown>
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export function createCompetitionTimers(opts: CompetitionTimersOptions) {
  const capture = opts.capture ?? captureBoundarySamples
  const resolve = opts.resolve ?? ((comp: CompetitionRow) => resolveCompetition(opts.db, comp as CompetitionRow & { id: number | string }, 'scheduler'))
  const setTimer = (opts.setTimer ?? defaultSetTimer) as (fn: () => void, ms: number) => unknown
  const clearTimer = (opts.clearTimer ?? (defaultClearTimer as (h: unknown) => void))
  const now = opts.now ?? (() => Date.now())

  const handles = new Map<string, { start?: unknown; end?: unknown }>()

  async function doStart(comp: CompetitionRow) {
    try { await capture(opts.deps, toDate(comp.window_start!)) } catch { /* best-effort */ }
  }
  async function doEnd(comp: CompetitionRow) {
    try { await capture(opts.deps, toDate(comp.window_end!)) } catch { /* best-effort */ }
    if (comp.auto_resolve) { try { await resolve(comp) } catch { /* backstop retries */ } }
  }

  function cancel(id: string) {
    const h = handles.get(id)
    if (!h) return
    if (h.start) clearTimer(h.start)
    if (h.end) clearTimer(h.end)
    handles.delete(id)
  }

  // Arm (or re-arm) a competition's boundary timers. `immediate` allows the
  // baseline capture to fire now for a just-started contest (create path); on
  // re-arm at boot it's false, so a past start is never re-captured.
  function arm(comp: CompetitionRow, { immediate = false }: { immediate?: boolean } = {}) {
    if (comp.id == null) return
    const id = String(comp.id)
    cancel(id)
    const plan = scheduleFor(comp, now())
    const h: { start?: unknown; end?: unknown } = {}
    if (plan.start === 'now') {
      if (immediate) void doStart(comp)
    } else if (typeof plan.start === 'number') {
      h.start = setTimer(() => void doStart(comp), plan.start)
    }
    if (typeof plan.end === 'number') {
      h.end = setTimer(() => void doEnd(comp), plan.end)
    }
    if (h.start || h.end) handles.set(id, h)
  }

  // Re-arm every fixed competition's future boundaries from the DB (boot).
  async function rearmAll() {
    const { rows } = await opts.db.query(
      `SELECT * FROM competitions WHERE window_kind = 'fixed' AND window_end IS NOT NULL`
    )
    for (const comp of rows) arm(comp as CompetitionRow, { immediate: false })
  }

  function stopAll() {
    for (const id of [...handles.keys()]) cancel(id)
  }

  return { arm, cancel, rearmAll, stopAll, scheduleFor }
}

export type CompetitionTimers = ReturnType<typeof createCompetitionTimers>
