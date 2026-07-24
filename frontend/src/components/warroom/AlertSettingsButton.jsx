// Personal War Room alert settings (#156/#157). A bell button + popover any
// member can use to opt into the dibs hospital-exit reminder and the chain-
// watch alert, each with a lead/threshold and sound/flash toggles. Prefs are
// per-user (localStorage) — not a leadership setting.
import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { saveAlertPrefs, playAlertSound } from '../../utils/warRoomAlerts'

function Row({ label, children }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-gray-700 dark:text-gray-200">
      <span>{label}</span>
      {children}
    </label>
  )
}

function ChannelSection({ title, hint, cfg, onChange, sampleKind, unitLabel, unitKey }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-gray-900 dark:text-white">{title}</span>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={e => onChange({ ...cfg, enabled: e.target.checked })} />
          <span>{cfg.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>
      <Row label={unitLabel}>
        <input type="number" min={5} max={600} step={1} value={cfg[unitKey]} disabled={!cfg.enabled}
          onChange={e => onChange({ ...cfg, [unitKey]: Math.min(600, Math.max(5, Math.floor(Number(e.target.value) || cfg[unitKey]))) })}
          className="w-20 px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white disabled:opacity-50" />
      </Row>
      <Row label="Sound">
        <input type="checkbox" checked={cfg.sound} disabled={!cfg.enabled}
          onChange={e => onChange({ ...cfg, sound: e.target.checked })} />
      </Row>
      <Row label="Screen flash">
        <input type="checkbox" checked={cfg.flash} disabled={!cfg.enabled}
          onChange={e => onChange({ ...cfg, flash: e.target.checked })} />
      </Row>
      <button type="button" onClick={() => playAlertSound(sampleKind)}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Test sound</button>
    </div>
  )
}

export default function AlertSettingsButton({ prefs, setPrefs, open: openProp, onOpenChange, lockOpen = false }) {
  const [openState, setOpenState] = useState(false)
  const ref = useRef(null)
  // Optionally controlled (the first-run tour opens it on the alerts step).
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : openState
  const setOpen = (v) => {
    const next = typeof v === 'function' ? v(open) : v
    if (isControlled) onOpenChange?.(next)
    else setOpenState(next)
  }

  useEffect(() => {
    // Don't auto-close on an outside click while the tour is holding it open.
    if (!open || lockOpen) return
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, lockOpen])

  function update(channel, cfg) {
    const next = { ...prefs, [channel]: cfg }
    setPrefs(next)
    saveAlertPrefs(next)
  }

  const anyOn = prefs.dibs.enabled || prefs.chain.enabled

  return (
    <div className="relative inline-flex" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        title="Personal alerts — dibs hospital-exit reminder and chain-watch"
        className={`p-2 rounded-lg border transition-colors ${
          anyOn
            ? 'border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20'
            : 'border-gray-300 dark:border-slate-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700'
        }`}>
        <Bell className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-30 w-72 p-4 space-y-4 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">My War Room Alerts</div>
          <ChannelSection
            title="Dib hospital-exit" sampleKind="dibs"
            hint="Alert me shortly before a target I've dibbed leaves hospital."
            cfg={prefs.dibs} onChange={cfg => update('dibs', cfg)}
            unitLabel="Lead time (s)" unitKey="leadSec" />
          <div className="border-t border-gray-200 dark:border-slate-700" />
          <ChannelSection
            title="Chain watch" sampleKind="chain"
            hint="Alert me when the chain is about to drop, and highlight attack buttons red."
            cfg={prefs.chain} onChange={cfg => update('chain', cfg)}
            unitLabel="Threshold (s)" unitKey="thresholdSec" />
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Saved to this browser. Sound needs one click on the page first (browser policy).
          </p>
        </div>
      )}
    </div>
  )
}
