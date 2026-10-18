import { useEffect, useState } from 'react'
import { apiGet } from '../utils/apiClient'
import { FF_TRUE_RED_HIGH_DEFAULT } from '../utils/fairFight'

const DEFAULTS = { ff_red_high: FF_TRUE_RED_HIGH_DEFAULT }
let cached = null
let inflight = null

/**
 * Display tunables from the server (#995) — the true-FF gradient's upper red
 * anchor, set as `war_room_ff_red_high` in Global Admin. Fetched once per page
 * load and shared; defaults until (and if) it arrives, so the War Room never
 * waits on it.
 */
export function useDisplaySettings() {
  const [settings, setSettings] = useState(cached ?? DEFAULTS)
  useEffect(() => {
    if (cached) return undefined
    let alive = true
    // ⚠️ Wrapped so a throw or a non-promise (a test double, a broken fetch)
    // still lands on the defaults instead of crashing the War Room it decorates.
    inflight ??= Promise.resolve()
      .then(() => apiGet('/api/display-settings'))
      .then((s) => { cached = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) }; return cached })
      .catch(() => DEFAULTS)
    inflight.then((s) => { if (alive) setSettings(s) })
    return () => { alive = false }
  }, [])
  return settings
}
