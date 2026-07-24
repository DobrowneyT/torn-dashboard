// Leader headline banner (#158) — a single urgent message pinned at the top of
// the War Room, shown to everyone and updated live over the 'config' channel.
// Warleads/leadership/admin compose it from presets or free text and clear it.
import { useEffect, useRef, useState } from 'react'
import { Megaphone, X } from 'lucide-react'
import { setWarHeadline, clearWarHeadline } from '../../utils/warRoomApiV2'
import { fmtAgo } from '../../utils/time'

export const HEADLINE_TONE_STYLES = {
  danger:  'bg-red-600 text-white',
  warn:    'bg-amber-500 text-white',
  go:      'bg-green-600 text-white',
  neutral: 'bg-blue-600 text-white',
}

// Quick-pick presets. `push` renders a time input and produces "PUSH 2 HH:MM".
const PRESETS = [
  { label: 'Turtle / stay in hospital', text: 'TURTLE — STAY IN HOSPITAL', tone: 'warn' },
  { label: 'Stop all hits',             text: 'STOP ALL HITS',             tone: 'danger' },
  { label: 'Keep the chain alive',      text: 'KEEP THE CHAIN ALIVE',      tone: 'go' },
]

function Composer({ onSet, busy }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [tone, setTone] = useState('neutral')
  const [pushTime, setPushTime] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  async function send(t, tn) {
    const clean = (t ?? '').trim()
    if (!clean) return
    await onSet(clean, tn)
    setOpen(false); setText(''); setPushTime('')
  }

  return (
    <div className="relative inline-flex" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)} disabled={busy}
        title="Set a headline for the whole War Room"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:border-blue-400 disabled:opacity-50">
        <Megaphone className="w-4 h-4" /> Headline
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-30 w-72 p-3 space-y-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl">
          <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Quick calls</div>
          <div className="flex flex-col gap-1.5">
            {PRESETS.map(p => (
              <button key={p.text} type="button" onClick={() => send(p.text, p.tone)}
                className={`text-left text-sm px-3 py-1.5 rounded ${HEADLINE_TONE_STYLES[p.tone]} opacity-90 hover:opacity-100`}>
                {p.label}
              </button>
            ))}
            <div className="flex items-center gap-2">
              <input type="time" value={pushTime} onChange={e => setPushTime(e.target.value)}
                className="px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white" />
              <button type="button" disabled={!pushTime} onClick={() => send(`PUSH 2 ${pushTime}`, 'go')}
                className={`text-sm px-3 py-1.5 rounded ${HEADLINE_TONE_STYLES.go} disabled:opacity-40`}>
                Push to…
              </button>
            </div>
          </div>
          <div className="border-t border-gray-200 dark:border-slate-700 pt-2 space-y-2">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Custom</div>
            <input value={text} onChange={e => setText(e.target.value)} maxLength={200} placeholder="Type a headline…"
              onKeyDown={e => { if (e.key === 'Enter') send(text, tone) }}
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white" />
            <div className="flex items-center gap-2">
              <select value={tone} onChange={e => setTone(e.target.value)}
                className="px-2 py-1 text-sm border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-900 dark:text-white">
                <option value="neutral">Neutral</option>
                <option value="danger">Danger</option>
                <option value="warn">Warn</option>
                <option value="go">Go</option>
              </select>
              <button type="button" disabled={!text.trim()} onClick={() => send(text, tone)}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white font-medium disabled:opacity-40">
                Set
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// `mode` lets the banner display and the leader composer live in different
// places (#197/layout): 'full' = both (default), 'banner' = display only,
// 'composer' = the post/clear controls only.
export default function HeadlineBanner({ config, canManage, nowMs = Date.now(), mode = 'full' }) {
  const [busy, setBusy] = useState(false)
  const text = config?.headline_text
  const tone = HEADLINE_TONE_STYLES[config?.headline_tone] ? config.headline_tone : 'neutral'

  async function set(t, tn) {
    setBusy(true)
    try { await setWarHeadline(t, tn) } finally { setBusy(false) }
  }
  async function clear() {
    setBusy(true)
    try { await clearWarHeadline() } finally { setBusy(false) }
  }

  const showBanner = mode !== 'composer' && !!text
  const showComposer = mode !== 'banner' && canManage
  if (!showBanner && !showComposer) return null

  return (
    <div className={mode === 'composer' ? '' : 'mb-3 space-y-2'}>
      {showBanner && (
        <div className={`rounded-lg px-4 py-3 flex items-center justify-between gap-3 shadow ${HEADLINE_TONE_STYLES[tone]}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Megaphone className="w-5 h-5 flex-shrink-0" />
            <span className="font-bold text-base sm:text-lg truncate">{text}</span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {config?.headline_set_at && (
              <span className="text-xs opacity-80 hidden sm:inline">{fmtAgo(config.headline_set_at, nowMs)}</span>
            )}
            {canManage && (
              <button type="button" onClick={clear} disabled={busy} title="Clear headline"
                className="p-1 rounded hover:bg-black/20">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
      {showComposer && (
        <div className="flex justify-end">
          <Composer onSet={set} busy={busy} />
        </div>
      )}
    </div>
  )
}
