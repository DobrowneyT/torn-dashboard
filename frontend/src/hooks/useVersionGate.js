/**
 * Keep this tab on the deployed build (#382).
 *
 * The nginx cache rules fix the common case — a fresh navigation always
 * re-fetches index.html. This covers the case they cannot: a tab left open,
 * which is the norm for the War Room and exactly where running old code does
 * the most damage.
 *
 * The decision itself lives in utils/versionGate (pure, and tested for the
 * reload-loop cases); this hook is only the plumbing around it.
 */
import { useEffect, useState } from 'react'
import {
  GateAction, evaluateVersion, readMark, writeMark, clearMarkIfCurrent,
} from '../utils/versionGate'

/** Five minutes. A stale tab matters in minutes, not seconds. */
const POLL_MS = 5 * 60 * 1000

/**
 * @param {object}  opts
 * @param {boolean} opts.forceReload  reload outright rather than prompting.
 *   True on the War Room: a board showing wrong dibs is worse than a two-
 *   second interruption, and a dismissible banner gets dismissed. Elsewhere a
 *   reload could discard something half-typed, so we ask.
 * @returns {{ stale: boolean, version: string|null }} for the banner.
 */
export function useVersionGate({ forceReload = false } = {}) {
  const [stale, setStale] = useState(null)

  useEffect(() => {
    // Vite replaces this at build time; a dev server without it simply never
    // triggers, which is the right behaviour there.
    const running = import.meta.env.VITE_APP_VERSION
    let cancelled = false

    const check = async () => {
      let serving = null
      try {
        // Plain fetch, not the authorized client: /api/health needs no session,
        // and routing it through apiGet would couple "is this tab current?" to
        // token refresh — so an expiring session could suppress the check, or a
        // 401 could kick off a refresh every five minutes for nothing.
        // `cache: 'no-store'` because this answer must never come from the
        // browser's cache; that would defeat the entire mechanism.
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (!res.ok) return
        serving = (await res.json())?.version ?? null
      } catch {
        // Offline, or the API is down. evaluateVersion treats a missing
        // version as no information — deliberately, so an outage never
        // refreshes the board in a loop during the incident.
        return
      }
      if (cancelled) return

      const storage = typeof sessionStorage === 'undefined' ? null : sessionStorage
      clearMarkIfCurrent(storage, { running, serving })

      const decision = evaluateVersion({
        running, serving, mark: readMark(storage), canReload: forceReload,
      })

      if (decision.action === GateAction.RELOAD) {
        // Record BEFORE reloading. If the mark cannot be written we have no
        // way to stop a second attempt, so we decline to reload at all and
        // fall through to the banner — an annoying board beats an unusable one.
        if (writeMark(storage, decision.version)) {
          window.location.reload()
          return
        }
        setStale({ version: decision.version })
        return
      }

      setStale(decision.action === GateAction.NOTIFY ? { version: decision.version } : null)
    }

    check()
    const id = setInterval(check, POLL_MS)
    // Coming back to a backgrounded tab is the single most likely moment for
    // it to be stale, and the one where the user is about to act on it.
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [forceReload])

  return { stale: stale != null, version: stale?.version ?? null }
}
