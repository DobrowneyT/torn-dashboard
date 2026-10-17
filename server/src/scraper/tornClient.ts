// Rate-limited Torn API client. One client per faction process; the budget is
// enforced PER KEY (Torn's rate limit is per key), so N keys run at N× the
// budget — fanning a job across several keys (#228) actually multiplies
// throughput instead of being throttled together.
import { withTornAuth } from '../tornComment.js'

export interface TornClientOptions {
  baseUrl: string
  /** Per-key budget: at most `requests` dispatches per `perMs` window, per key. */
  budget: { requests: number; perMs: number }
  /**
   * Give up on one request after this long.
   *
   * ⚠️ Without it Node's `fetch` waits up to FIVE MINUTES for headers. On
   * forge's two-minute attacks-sync that stacked two or three hung runs during
   * an outage, each holding a pooled key — and Torn's API is down for hours at
   * a time every Halloween.
   */
  timeoutMs?: number
  /**
   * Retries for failures that are worth retrying at all — see `isRetryable`.
   *
   * ⚠️ Opt out where a caller polls fast. The War Room ticker runs every few
   * seconds, and a retry chain longer than its cadence is worse than failing.
   */
  retry?: { attempts: number; baseDelayMs: number; maxDelayMs: number }
  /** Injected for tests, so backoff does not make the suite sleep. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Torn's "slow down" codes: 5 (too many requests) and 8 (IP block).
 *
 * ⚠️ NEVER retried. Hitting a rate limit again a second later is how a soft
 * limit becomes a longer one. Jobs treat these as a routine SOFT STOP — the run
 * keeps what it fetched and the next one resumes.
 */
export const TORN_RATE_LIMIT_CODES = new Set([5, 8])

/**
 * Torn's "we are down" codes: 9 (API disabled, i.e. maintenance) and 17
 * (backend error).
 *
 * ⚠️ Distinct from rate limiting on purpose, and NOT a soft stop. A run during
 * an outage should be recorded as a FAILURE so the outage is visible — turning
 * it into a quiet success is the "not measured reads as healthy" trap (#645).
 * Jobs that upsert as they go keep their partial progress either way.
 */
export const TORN_UNAVAILABLE_CODES = new Set([9, 17])

/** Either of the above: "try again later", as opposed to "your key is wrong". */
export const TRANSIENT_TORN_CODES = new Set([...TORN_RATE_LIMIT_CODES, ...TORN_UNAVAILABLE_CODES])

export class TornApiError extends Error {
  tornCode: number
  constructor(code: number, message: string) {
    super(`Torn API error ${code}: ${message}`)
    this.tornCode = code
  }
}

/**
 * Torn could not be reached, or answered with something that is not the API.
 *
 * ⚠️ Separate from `TornApiError` because there is no Torn error code to read:
 * a timeout, a refused connection, an HTTP 502 from the load balancer, or a
 * Cloudflare HTML page. Every Halloween outage so far has looked like one of
 * these, and the old client reported all of them as
 * "Unexpected token '<'" — a JSON parse error that sends whoever is reading
 * the run log looking for a bug in our code.
 */
export class TornUnavailableError extends Error {
  /** HTTP status, when there was a response at all. */
  status: number | null
  constructor(message: string, status: number | null = null) {
    super(`Torn unavailable: ${message}`)
    this.status = status
  }
}

/** "Try again later" — an outage or a rate limit, never a bad key. */
export function isTransientTornError(err: unknown): boolean {
  if (err instanceof TornUnavailableError) return true
  return err instanceof TornApiError && TRANSIENT_TORN_CODES.has(err.tornCode)
}

/**
 * Is a retry a second later likely to succeed?
 *
 * ⚠️ Narrower than "transient". A rate limit (5, 8) is transient but retrying
 * makes it worse; "API disabled" (9) is transient but lasts minutes to hours,
 * so a retry seconds later only spends budget. What remains are genuine blips:
 * a dropped connection, a timeout, a 5xx from the load balancer, a Cloudflare
 * page, and Torn's own backend error (17).
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TornUnavailableError) {
    // No response at all (timeout, refused, reset), or a server-side status.
    return err.status === null || err.status === 429 || err.status >= 500
  }
  return err instanceof TornApiError && err.tornCode === 17
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Exponential backoff with full jitter.
 *
 * ⚠️ Jitter matters here more than usual: five tenants' scrapers all reach
 * Torn from one box, and when it comes back they would otherwise all retry in
 * the same second.
 */
function backoff(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(max, base * 2 ** (attempt - 1))
  return Math.floor(Math.random() * ceiling)
}

/** The first bytes of a body, for an error message, never the whole page. */
function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

// A single-key sliding-window limiter: timestamps of recent dispatches + FIFO queue.
function createLimiter(budget: { requests: number; perMs: number }) {
  const dispatched: number[] = []
  const waiting: Array<() => void> = []
  let timer: NodeJS.Timeout | null = null

  function pump() {
    const now = Date.now()
    while (dispatched.length > 0 && dispatched[0] <= now - budget.perMs) dispatched.shift()
    while (waiting.length > 0 && dispatched.length < budget.requests) {
      dispatched.push(Date.now())
      waiting.shift()!()
    }
    if (waiting.length > 0 && timer === null) {
      const wait = dispatched[0] + budget.perMs - now
      timer = setTimeout(() => { timer = null; pump() }, Math.max(1, wait))
    }
  }

  return {
    acquire(): Promise<void> {
      return new Promise((resolve) => {
        waiting.push(resolve)
        pump()
      })
    },
  }
}

export function createTornClient({
  baseUrl, budget, timeoutMs = DEFAULT_TIMEOUT_MS, retry = DEFAULT_RETRY, sleep = realSleep,
}: TornClientOptions) {
  // One limiter per API key — keys are rate-limited independently.
  const limiters = new Map<string, ReturnType<typeof createLimiter>>()
  function acquire(key: string): Promise<void> {
    let limiter = limiters.get(key)
    if (!limiter) { limiter = createLimiter(budget); limiters.set(key, limiter) }
    return limiter.acquire()
  }

  /**
   * One request, classified.
   *
   * ⚠️ The body is read as TEXT first. The old `res.json()` threw a bare
   * SyntaxError on Cloudflare's HTML pages, which said nothing about Torn
   * being down and everything about our code looking broken.
   */
  async function once(path: string, key: string): Promise<any> {
    let res: Response
    try {
      res = await fetch(withTornAuth(`${baseUrl}${path}`, key), {
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err: any) {
      const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? `no response within ${timeoutMs}ms`
        : (err?.cause?.code || err?.message || 'network error')
      throw new TornUnavailableError(reason)
    }

    let text: string
    try {
      text = await res.text()
    } catch (err: any) {
      throw new TornUnavailableError(`response body did not arrive (${err?.name ?? 'error'})`, res.status)
    }

    if (!res.ok) {
      // ⚠️ Cloudflare answers 403 with "error code: 1010" when it blocks a
      // client by signature, and 5xx pages during an outage. Neither is a
      // Torn error, and neither has a Torn error code to report.
      throw new TornUnavailableError(`HTTP ${res.status} ${snippet(text)}`, res.status)
    }

    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new TornUnavailableError(`non-JSON response: ${snippet(text)}`, res.status)
    }
    if (data?.error) throw new TornApiError(Number(data.error.code), String(data.error.error))
    return data
  }

  return {
    /**
     * Rate-limited GET against the Torn API (throttled per key). Torn error
     * payloads reject with a TornApiError (carrying `tornCode`) instead of
     * resolving.
     */
    async fetch(path: string, key: string): Promise<any> {
      const attempts = Math.max(1, retry.attempts)
      let last: unknown = null
      for (let attempt = 1; attempt <= attempts; attempt++) {
        // ⚠️ Every attempt goes through the limiter, so retries spend real
        // budget and cannot quietly exceed Torn's per-key rate.
        await acquire(key)
        try {
          return await once(path, key)
        } catch (err) {
          last = err
          if (attempt === attempts || !isRetryable(err)) throw err
          await sleep(backoff(attempt, retry.baseDelayMs, retry.maxDelayMs))
        }
      }
      throw last
    },
  }
}
