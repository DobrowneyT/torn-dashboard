// Faction-wide OC config the whole app reads (#136). Right now that's the
// faction's default payout mode, which decides whether the tier machinery is
// visible at all: a flat-weighted or equal faction never sees tier tabs or
// tier columns. Fetched once from /api/oc-config after login; refresh() lets
// the Settings editor push a change without a page reload.
//
// Legacy Supabase mode (API_MODE false, i.e. main until cutover) has no
// oc-config endpoint and has always been tiered, so tiers stay on there.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from './AuthContext'
import { API_MODE, apiGet } from '../utils/apiClient'
import { factionUsesTiers } from '../utils/payoutCalculations'

const FactionConfigContext = createContext(null)

export function FactionConfigProvider({ children }) {
  const { isAuthenticated } = useAuth()
  // null = not yet known. We stay optimistic (tiers shown) until we learn a
  // non-tiered mode, so the tiered faction never sees its tabs flash away.
  const [payoutMode, setPayoutMode] = useState(null)
  const [loading, setLoading] = useState(API_MODE)

  const refresh = useCallback(async () => {
    if (!API_MODE) return
    setLoading(true)
    try {
      const cfg = await apiGet('/api/oc-config')
      setPayoutMode(cfg?.payout_mode ?? null)
    } catch {
      // Leave the last-known mode; absent → optimistic default handles it.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAuthenticated) refresh()
  }, [isAuthenticated, refresh])

  const usesTiers = !API_MODE
    ? true
    : payoutMode == null
      ? true
      : factionUsesTiers(payoutMode)

  const value = { payoutMode, usesTiers, loading, refresh }
  return <FactionConfigContext.Provider value={value}>{children}</FactionConfigContext.Provider>
}

export function useFactionConfig() {
  const ctx = useContext(FactionConfigContext)
  if (!ctx) throw new Error('useFactionConfig must be used within a FactionConfigProvider')
  return ctx
}
