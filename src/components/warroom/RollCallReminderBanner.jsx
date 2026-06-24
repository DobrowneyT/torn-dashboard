import { useState, useEffect, useCallback } from 'react'
import { ClipboardList, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../utils/supabase'
import { rollCallGateActive, formatCountdown } from '../../utils/rollCall'

// Global post-login nudge: if there's a matched war the member hasn't filled
// roll call for (and we're still >1h out), show a dismissible banner linking to
// the War Room. The check runs silently in the background and re-verifies on tab
// focus + a periodic interval — the same triggers the session token refreshes
// on — so a long-lived session stays accurate (new match appears, filled-out
// nag clears) without ever flashing.
export default function RollCallReminderBanner() {
  const { user, tokenReady } = useAuth()
  const [pending, setPending] = useState(null)        // { id, opponentName, startAt } | null
  const [dismissedId, setDismissedId] = useState(null)

  const check = useCallback(async () => {
    // Need the session token for the faction-scoped reads (RLS); skip until ready.
    if (!user?.id || !tokenReady) { setPending(null); return }
    try {
      const { data: cfg } = await supabase
        .from('war_room_config_v2').select('faction_id').eq('id', 1).maybeSingle()
      if (!cfg?.faction_id) { setPending(null); return }

      const { data: war } = await supabase
        .from('ranked_wars')
        .select('id, opponent_name, start_at, end_at')
        .eq('opponent_id', cfg.faction_id)
        .order('start_at', { ascending: false }).limit(1).maybeSingle()
      if (!war || war.end_at) { setPending(null); return }

      const currentWar = { id: war.id, opponentName: war.opponent_name, startAt: war.start_at }
      const { data: rc } = await supabase
        .from('war_room_roll_call_v2').select('id')
        .eq('war_id', war.id).eq('member_id', Number(user.id)).maybeSingle()
      setPending(rollCallGateActive({ currentWar, mySubmitted: !!rc }) ? currentWar : null)
    } catch { /* best-effort nudge — ignore lookup errors */ }
  }, [user?.id, tokenReady])

  useEffect(() => {
    check()
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVis)
    // Re-verify roughly on the session-refresh cadence so the nudge tracks reality.
    const t = setInterval(check, 15 * 60 * 1000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
  }, [check])

  // Only render once we've confirmed it's pending (no flash), and not for a war
  // the user already dismissed (a new match has a different id, so it returns).
  if (!pending || pending.id === dismissedId) return null

  return (
    <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-300 dark:border-amber-700 px-4 py-2">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-3">
        <span className="text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2 min-w-0">
          <ClipboardList className="w-4 h-4 shrink-0" />
          <span className="truncate">
            War roll call needed vs <strong>{pending.opponentName || 'your matched faction'}</strong> ({formatCountdown(pending.startAt)}).
          </span>
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <a href="#/rw/war-room" className="text-sm font-semibold text-amber-800 dark:text-amber-200 hover:underline whitespace-nowrap">
            Fill it out →
          </a>
          <button onClick={() => setDismissedId(pending.id)} aria-label="Dismiss" className="text-amber-700 dark:text-amber-300 hover:opacity-70">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
