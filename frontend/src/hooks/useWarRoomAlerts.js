// Personal war-room alerts (#156 dibs hospital-exit, #157 chain-watch). Runs a
// 1 Hz clock over the already-polled members/dibs/chain and fires sound/flash
// when the current user's claim is about to become hittable or the chain is
// about to drop. Each alert fires once per event (target-exit / chain-drop
// window) — tracked by refs so a steady poll doesn't re-trigger it.
import { useEffect, useRef, useState } from 'react'
import {
  hospitalExitDue,
  chainSecondsLeft,
  chainDropDue,
  fireAlert,
} from '../utils/warRoomAlerts'

export function useWarRoomAlerts({ chain, members, dibs, userId, prefs, active }) {
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const [chainAlerting, setChainAlerting] = useState(false)
  const dibsFiredRef = useRef(new Set())   // `${targetId}:${until}` already alerted
  const chainFiredRef = useRef(null)       // chain.timeout already alerted for

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [active])

  // #156 — the user's own dib'd target is within the lead window of leaving hospital.
  useEffect(() => {
    if (!active || !prefs?.dibs?.enabled || !userId) return
    const myId = String(userId)
    for (const m of members) {
      const dib = dibs[m.member_id]
      if (!dib || String(dib.claimed_by) !== myId) continue
      const key = `${m.member_id}:${m.status_until}`
      if (dibsFiredRef.current.has(key)) continue
      if (hospitalExitDue(m, nowSec, prefs.dibs.leadSec)) {
        fireAlert('dibs', prefs.dibs)
        dibsFiredRef.current.add(key)
      }
    }
  }, [active, prefs, members, dibs, userId, nowSec])

  // #157 — the chain is within the threshold of dropping. `chainAlerting`
  // drives the red target-button cue; the sound/flash fires once per window.
  useEffect(() => {
    if (!active || !prefs?.chain?.enabled) { setChainAlerting(false); return }
    const due = chainDropDue(chain, nowSec, prefs.chain.thresholdSec)
    setChainAlerting(due)
    if (!due) {
      // Reset the once-per-window latch when the chain is safe again / dropped.
      if (chainSecondsLeft(chain, nowSec) == null) chainFiredRef.current = null
      return
    }
    if (chainFiredRef.current !== chain?.timeout) {
      fireAlert('chain', prefs.chain)
      chainFiredRef.current = chain?.timeout
    }
  }, [active, prefs, chain, nowSec])

  return { chainAlerting }
}
