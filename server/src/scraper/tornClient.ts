// Rate-limited Torn API client. One client per faction process; the budget
// is shared across every job in the process (per-pool budget), so parallel
// scrapers can't blow through Torn's per-key limits collectively.
import { withTornAuth } from '../tornComment.js'

export interface TornClientOptions {
  baseUrl: string
  /** Shared budget: at most `requests` dispatches per `perMs` window. */
  budget: { requests: number; perMs: number }
}

export class TornApiError extends Error {
  tornCode: number
  constructor(code: number, message: string) {
    super(`Torn API error ${code}: ${message}`)
    this.tornCode = code
  }
}

export function createTornClient({ baseUrl, budget }: TornClientOptions) {
  // Sliding-window limiter: timestamps of recent dispatches + FIFO queue.
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

  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      waiting.push(resolve)
      pump()
    })
  }

  return {
    /**
     * Rate-limited GET against the Torn API. Torn error payloads reject with
     * a TornApiError (carrying `tornCode`) instead of resolving.
     */
    async fetch(path: string, key: string): Promise<any> {
      await acquire()
      const res = await fetch(withTornAuth(`${baseUrl}${path}`, key))
      const data = (await res.json()) as any
      if (data?.error) throw new TornApiError(Number(data.error.code), String(data.error.error))
      return data
    },
  }
}
