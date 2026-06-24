import { useState, useEffect } from 'react'
import { ClipboardList, X } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../utils/supabase'
import { rollCallGateActive, formatCountdown } from '../../utils/rollCall'

// Global post-login nudge: if there's a matched war the member hasn't filled
// roll call for (and we're still >1h out), show a dismissible banner linking to
// the War Room. Self-contained — does its own lightweight lookup so the layout
// doesn't need war-room state.
export default function RollCallReminderBanner() {
  const { user } = useAuth()
  const [pending, setPending] = useState(null)   // { opponentName, startAt } | null
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      try {
        const { data: cfg } = await supabase
          .from('war_room_config_v2').select('faction_id').eq('id', 1).maybeSingle()
        if (cancelled || !cfg?.faction_id) return

        const { data: war } = await supabase
          .from('ranked_wars')
          .select('id, opponent_name, start_at, end_at')
          .eq('opponent_id', cfg.faction_id)
          .order('start_at', { ascending: false }).limit(1).maybeSingle()
        if (cancelled || !war || war.end_at) return

        const currentWar = { id: war.id, opponentName: war.opponent_name, startAt: war.start_at }
        const { data: rc } = await supabase
          .from('war_room_roll_call_v2').select('id')
          .eq('war_id', war.id).eq('member_id', Number(user.id)).maybeSingle()
        if (cancelled) return
        if (rollCallGateActive({ currentWar, mySubmitted: !!rc })) setPending(currentWar)
      } catch { /* best-effort nudge — ignore lookup errors */ }
    })()
    return () => { cancelled = true }
  }, [user?.id])

  if (!pending || dismissed) return null

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
          <button onClick={() => setDismissed(true)} aria-label="Dismiss" className="text-amber-700 dark:text-amber-300 hover:opacity-70">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
