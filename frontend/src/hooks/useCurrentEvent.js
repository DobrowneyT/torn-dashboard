import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '../utils/apiClient'

const POLL_MS = 60_000

/**
 * The faction event the page should know about (#969): a live one, else the
 * next upcoming one, else null.
 *
 * Called ONCE, in the layout, and passed down — the nav, the `/` redirect and
 * the event page all need the same answer, and three polls would be three
 * chances to disagree.
 *
 * ⚠️ Also re-asks the moment an upcoming event is due to start, so the
 * landing switch happens at 10:00 TCT rather than up to a minute later.
 */
export function useCurrentEvent(enabled = true) {
  const [event, setEvent] = useState(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet('/api/events/current')
      setEvent(res.event ?? null)
    } catch {
      // ⚠️ Keep the last answer. A failed poll during a Torn-wide outage must
      // not flip the landing page away from a live event and back again.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled || event?.phase !== 'upcoming') return undefined
    const wait = event.starts_at - Date.now()
    // Within one poll it is the interval's job; a far-off setTimeout would
    // also overflow the 32-bit delay limit (~24.8 days) and fire at once.
    if (wait <= 0 || wait > POLL_MS) return undefined
    const t = setTimeout(refresh, wait + 1_000)
    return () => clearTimeout(t)
  }, [enabled, event, refresh])

  return { event, loaded, refresh }
}
