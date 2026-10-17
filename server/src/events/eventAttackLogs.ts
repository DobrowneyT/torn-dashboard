// Pure rules for the attack-log archive (#973). The archiver
// (attackLogArchiver.ts) does the I/O and asks these the questions.
import { TornApiError, TornUnavailableError, TORN_RATE_LIMIT_CODES, TORN_UNAVAILABLE_CODES } from '../scraper/tornClient.js'

/**
 * Default ceiling on calls from any one key per minute. Tunable per tenant:
 * flag `event_attack_log_per_key_per_min`.
 *
 * ⚠️ A courtesy, not a promise members were given. Torn's limit is 100 a
 * minute per PLAYER, shared with that player's own scripts — which they run
 * hardest during Halloween. 96 keys × 10 = 960/min against last year's worst
 * minute of 63.
 */
export const DEFAULT_PER_KEY_PER_MIN = 10
const WINDOW_MS = 60_000

/** Torn's "Incorrect log ID": the log has expired or never existed. */
export const LOG_GONE_CODE = 28
// Codes that mean the KEY is bad — the same set sampleCapture uses.
export const KEY_DISABLE_CODES = new Set([2, 10, 13])

/**
 * Per-key call budget over a sliding minute. In-process, which is the right
 * scope: one tenant process owns its archiver.
 */
export function createKeySlots(perKeyPerMin: () => number) {
  const calls = new Map<string, number[]>()
  const pausedUntil = new Map<string, number>()
  const recent = (id: string, now: number) => {
    const list = (calls.get(id) ?? []).filter((t) => now - t < WINDOW_MS)
    calls.set(id, list)
    return list
  }
  return {
    /** Calls this key may still make in the current minute. */
    free(id: string, now: number): number {
      if ((pausedUntil.get(id) ?? 0) > now) return 0
      return Math.max(0, perKeyPerMin() - recent(id, now).length)
    },
    use(id: string, now: number) { recent(id, now).push(now) },
    /** Rate-limited by Torn: rest this key for a whole window. */
    pause(id: string, now: number) { pausedUntil.set(id, now + WINDOW_MS) },
  }
}

/**
 * Hand out up to `want` calls across the keys, round-robin, never past any
 * key's free budget. Returns one member id per call.
 */
export function allocate(keys: string[], free: (id: string) => number, want: number): string[] {
  const left = new Map(keys.map((k) => [k, free(k)]))
  const out: string[] = []
  let progressed = true
  while (out.length < want && progressed) {
    progressed = false
    for (const k of keys) {
      if (out.length >= want) break
      const n = left.get(k) ?? 0
      if (n > 0) { out.push(k); left.set(k, n - 1); progressed = true }
    }
  }
  return out
}

export type FetchFailure =
  | { kind: 'gone' }          // never retry
  | { kind: 'bad-key' }       // disable the key; the attack stays due
  | { kind: 'rate-limited' }  // rest the key; the attack stays due
  | { kind: 'outage' }        // stop this run; everything stays due
  | { kind: 'retry'; message: string }

export function classifyFailure(err: unknown): FetchFailure {
  if (err instanceof TornUnavailableError) return { kind: 'outage' }
  if (err instanceof TornApiError) {
    if (err.tornCode === LOG_GONE_CODE) return { kind: 'gone' }
    if (KEY_DISABLE_CODES.has(err.tornCode)) return { kind: 'bad-key' }
    if (TORN_RATE_LIMIT_CODES.has(err.tornCode)) return { kind: 'rate-limited' }
    if (TORN_UNAVAILABLE_CODES.has(err.tornCode)) return { kind: 'outage' }
  }
  return { kind: 'retry', message: err instanceof Error ? err.message : String(err) }
}

/** Wait before retrying one attack's log: 2, 4, 8… minutes, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(3_600_000, 60_000 * 2 ** Math.max(1, Math.min(attempts, 12)))
}

/** How far back the backlog trend looks. */
export const TREND_WINDOW_MS = 10 * 60_000

/**
 * Is the backlog growing? True when it is non-zero and larger now than at
 * every reading in the last ten minutes — a burst that the archiver is
 * catching up on is not growth; a backlog that keeps climbing is.
 */
export function backlogGrowing(history: Array<{ at: number; backlog: number }>, now: number): boolean {
  const window = history.filter((h) => now - h.at <= TREND_WINDOW_MS)
  if (window.length < 3) return false
  const first = window[0]
  if (now - first.at < TREND_WINDOW_MS / 2) return false
  const last = window[window.length - 1]
  if (last.backlog === 0) return false
  for (let i = 1; i < window.length; i++) {
    if (window[i].backlog < window[i - 1].backlog) return false
  }
  return last.backlog > first.backlog
}
