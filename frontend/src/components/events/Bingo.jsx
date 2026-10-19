import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete, apiFetch } from '../../utils/apiClient'
import BingoCard from './BingoCard'
import SortableTh, { useTableSort } from '../SortableTh'
import { prepareImage, formatBytes, uploadErrorMessage } from '../../utils/imageUpload'
import { Spinner } from './BingoSettings'
import { PlayerLink } from './TornLink'

/**
 * The event's bingo tab (#965).
 *
 * Every member sees their own copy of the card. Automatic squares cross
 * themselves from data the dashboard already has; the rest are asked for with
 * proof (a log snippet or a screenshot) and leadership approves or denies.
 * Leadership can also look at anyone's card and cross a square directly.
 */
const PROOF_IMAGE_MAX = 3 * 1024 * 1024
const KIND_TEXT = {
  auto: 'Crosses automatically when the dashboard sees it. If you think it was missed, send proof.',
  proof: 'Send proof — a log snippet or a screenshot. Leadership reviews it.',
  free: 'Free — crossed for everyone.',
}
const SOURCE_TEXT = { auto: 'automatically', council: 'by leadership', proof: 'after review' }

// db-time-safe: every bingo time arrives as epoch milliseconds from the server.
const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

export default function Bingo({ event, isLeadership = false }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [viewing, setViewing] = useState('')
  const [picked, setPicked] = useState(null)
  const [showReviews, setShowReviews] = useState(false)
  const top = useRef(null)
  const color = event.theme_color

  const load = useCallback(async () => {
    try {
      const q = viewing ? `?member=${encodeURIComponent(viewing)}` : ''
      setData(await apiGet(`/api/events/${event.id}/bingo${q}`))
      setError(null)
    } catch (err) {
      setError(err.message || 'Could not load the bingo card.')
    }
  }, [event.id, viewing])

  useEffect(() => { load() }, [load])
  // Automatic squares land every few minutes; keep the card current.
  useEffect(() => {
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const marksByIdx = useMemo(() => {
    const m = new Map()
    // Newest first from the server. A live mark (pending or crossed) wins over
    // any denied one; otherwise the latest denial is what the square shows.
    for (const mark of data?.marks ?? []) {
      const cur = m.get(mark.idx)
      if (!cur || (cur.status === 'rejected' && mark.status !== 'rejected')) m.set(mark.idx, mark)
    }
    return m
  }, [data])

  if (error && !data) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
  if (!data || !data.grid) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading the card…</p>

  const stateOf = (idx) => {
    const m = marksByIdx.get(idx)
    if (!m) return null
    return m.status === 'approved' ? 'crossed' : m.status === 'pending' ? 'pending' : null
  }
  const playable = data.tiles.filter((t) => t.kind !== 'free')
  const crossed = playable.filter((t) => stateOf(t.idx) === 'crossed').length
  const mineLines = data.standings.find((s) => s.member_id === data.member.member_id)?.lines ?? 0
  const isMe = !viewing
  const tile = picked == null ? null : data.tiles.find((t) => t.idx === picked) ?? { idx: picked, label: `Square ${picked + 1}`, kind: 'proof' }

  return (
    <div className="space-y-4">
      {!data.enabled && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          Bingo is off — only leadership can see this. Turn it on in Settings.
        </p>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div ref={top}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isMe ? 'Your card' : `${data.member.name ?? data.member.member_id}'s card`}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 tabular-nums">
            {crossed} of {playable.length} squares · {mineLines} {mineLines === 1 ? 'line' : 'lines'}
          </p>
        </div>
        {isLeadership && (
          <div className="flex flex-wrap gap-2">
            {!isMe && (
              <button type="button" onClick={() => { setViewing(''); setPicked(null) }}
                className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm">
                Back to my card
              </button>
            )}
            <button type="button" onClick={() => setShowReviews((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: color }}>
              Review proof{data.pending_reviews ? ` (${data.pending_reviews})` : ''}
            </button>
          </div>
        )}
      </div>

      {isLeadership && showReviews && <ReviewQueue event={event} tiles={data.tiles} onChanged={load} />}

      <BingoCard card={data} stateOf={stateOf} onPick={setPicked} selected={picked} color={color} />

      {tile && (
        <SquarePanel
          key={`${tile.idx}-${data.member.member_id}`}
          event={event} tile={tile} mark={marksByIdx.get(tile.idx) ?? null}
          history={(data.marks ?? []).filter((m) => m.idx === tile.idx)}
          memberId={data.member.member_id} isMe={isMe} isLeadership={isLeadership}
          color={color} onChanged={load} onClose={() => setPicked(null)}
        />
      )}

      <Standings rows={data.standings} me={data.member.member_id}
        onView={isLeadership ? (id) => { setViewing(id); setPicked(null); top.current?.scrollIntoView?.({ behavior: 'smooth' }) } : null} />
    </div>
  )
}

function SquarePanel({ event, tile, mark, history, memberId, isMe, isLeadership, color, onChanged, onClose }) {
  const [text, setText] = useState('')
  const [image, setImage] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [working, setWorking] = useState(null)

  async function attach(file) {
    setError(null)
    if (!file) return
    setWorking('Preparing screenshot…')
    try {
      const img = await prepareImage(file)
      if (img.bytes > PROOF_IMAGE_MAX) throw new Error(`That screenshot is ${formatBytes(img.bytes)}; the limit is 3 MB.`)
      setImage({ type: img.type, data: img.data, name: `${file.name || 'pasted screenshot'} · ${formatBytes(img.bytes)}` })
    } catch (err) {
      setError(uploadErrorMessage(err))
    } finally {
      setWorking(null)
    }
  }

  async function act(fn, label = 'Working…') {
    setBusy(true); setError(null); setWorking(label)
    try { await fn(); await onChanged() } catch (err) { setError(uploadErrorMessage(err)) } finally { setBusy(false); setWorking(null) }
  }

  const submit = () => act(() => apiPost(`/api/events/${event.id}/bingo/marks`, {
    idx: tile.idx, proof_text: text,
    ...(image ? { proof_image_base64: image.data, proof_image_type: image.type } : {}),
  }).then(() => { setText(''); setImage(null) }), 'Sending for review…')

  const crossFor = () => act(() => apiPost(`/api/events/${event.id}/bingo/marks`, {
    idx: tile.idx, member_id: memberId, council: true,
  }))
  const withdraw = () => act(() => apiDelete(`/api/events/${event.id}/bingo/marks/${mark.id}`))
  const uncross = () => {
    if (!window.confirm('Un-cross this square?')) return
    act(() => apiPost(`/api/events/${event.id}/bingo/marks/${mark.id}/revoke`, {}))
  }

  const rejected = history.find((m) => m.status === 'rejected')
  const canAsk = tile.kind !== 'free' && (!mark || mark.status === 'rejected')

  return (
    <section className="card p-4 space-y-3" aria-label="Square details">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Square {tile.idx + 1}</p>
          <h4 className="font-semibold text-gray-900 dark:text-white">{tile.label || `Square ${tile.idx + 1}`}</h4>
          <p className="text-sm text-gray-500 dark:text-gray-400">{KIND_TEXT[tile.kind]}</p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">Close</button>
      </div>

      {mark?.status === 'approved' && (
        <p className="text-sm" style={{ color }}>
          ✕ Crossed {SOURCE_TEXT[mark.source] ?? ''} · {when(mark.reviewed_at ?? mark.created_at)}
        </p>
      )}
      {mark?.status === 'pending' && (
        <p className="text-sm text-amber-700 dark:text-amber-300">Waiting for review · sent {when(mark.created_at)}</p>
      )}
      {(!mark || mark.status === 'rejected') && rejected && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Last request denied{rejected.review_note ? `: ${rejected.review_note}` : ''}. You can send new proof.
        </p>
      )}

      {canAsk && isMe && (
        <div className="space-y-2">
          <textarea
            className="w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono"
            rows={4} maxLength={4000} value={text}
            placeholder="Paste the log line, or describe what happened. You can paste a screenshot here too."
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'))
              if (f) { e.preventDefault(); attach(f) }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm cursor-pointer">
              {image ? 'Change screenshot' : 'Attach screenshot'}
              <input type="file" accept="image/*" className="sr-only" onChange={(e) => attach(e.target.files?.[0])} />
            </label>
            {image && (
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[12rem]">
                {image.name} · <button type="button" className="underline" onClick={() => setImage(null)}>remove</button>
              </span>
            )}
            <button type="button" disabled={busy || !!working || (!text.trim() && !image)} onClick={submit}
              className="ml-auto px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ backgroundColor: color }}>
              Send for review
            </button>
          </div>
          {/* ⚠️ Beside the button, not at the panel's foot — off-screen on a phone. */}
          {working && <p role="status" className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"><Spinner /> {working}</p>}
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}
          {image && <img src={image.data} alt="Screenshot to send" className="max-h-48 rounded border border-gray-200 dark:border-slate-700" />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {mark?.status === 'pending' && (isMe || isLeadership) && (
          <button type="button" disabled={busy} onClick={withdraw} className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm">
            Withdraw request
          </button>
        )}
        {isLeadership && canAsk && (
          <button type="button" disabled={busy} onClick={crossFor} className="px-3 py-1.5 rounded-lg border text-sm" style={{ borderColor: color, color }}>
            Cross it {isMe ? 'off' : 'for them'}
          </button>
        )}
        {isLeadership && mark?.status === 'approved' && (
          <button type="button" disabled={busy} onClick={uncross} className="px-3 py-1.5 rounded-lg border border-red-400 text-red-600 dark:text-red-400 text-sm">
            Un-cross
          </button>
        )}
      </div>
      {!(canAsk && isMe) && working && <p role="status" className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"><Spinner /> {working}</p>}
      {!(canAsk && isMe) && error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}
    </section>
  )
}

/** A proof screenshot. ⚠️ Fetched with the session token — an <img> cannot send it. */
function ProofImage({ path }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    let made = null
    apiFetch(path).then(async (res) => {
      if (!res.ok || !alive) return
      made = URL.createObjectURL(await res.blob())
      setUrl(made)
    }).catch(() => {})
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
  }, [path])
  if (!url) return <span className="text-xs text-gray-400">Loading screenshot…</span>
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Proof screenshot" className="max-h-56 rounded border border-gray-200 dark:border-slate-700" />
    </a>
  )
}

function ReviewQueue({ event, tiles, onChanged }) {
  const [marks, setMarks] = useState(null)
  const [notes, setNotes] = useState({})
  const [error, setError] = useState(null)
  const label = (idx) => tiles.find((t) => t.idx === idx)?.label || `Square ${idx + 1}`

  const load = useCallback(async () => {
    try { setMarks((await apiGet(`/api/events/${event.id}/bingo/reviews`)).marks) } catch (err) { setError(err.message) }
  }, [event.id])
  useEffect(() => { load() }, [load])

  async function decide(m, decision) {
    setError(null)
    try {
      await apiPatch(`/api/events/${event.id}/bingo/marks/${m.id}`, { decision, note: notes[m.id] ?? '' })
      await Promise.all([load(), onChanged()])
    } catch (err) { setError(err.message || 'Could not save that decision.') }
  }

  if (!marks) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading requests…</p>
  const waiting = marks.filter((m) => m.status === 'pending')
  const decided = marks.filter((m) => m.status !== 'pending')
  return (
    <section className="card p-4 space-y-3" aria-label="Proof to review">
      <h4 className="font-semibold text-gray-900 dark:text-white">Proof to review</h4>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {waiting.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">Nothing waiting.</p>}
      <ul className="space-y-3">
        {waiting.map((m) => (
          <li key={m.id} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2">
            <p className="text-sm">
              <PlayerLink id={m.member_id} name={m.member_name} /> ·{' '}
              <span className="font-medium">{label(m.idx)}</span>{' '}
              <span className="text-gray-500 dark:text-gray-400">· {when(m.created_at)}</span>
            </p>
            {m.proof_text && (
              <pre className="whitespace-pre-wrap break-words rounded bg-gray-50 dark:bg-slate-900 p-2 text-xs">{m.proof_text}</pre>
            )}
            {m.has_image && <ProofImage path={`/api/events/${event.id}/bingo/marks/${m.id}/image`} />}
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm"
                placeholder="Note (shown to the member if denied)" maxLength={500}
                value={notes[m.id] ?? ''} onChange={(e) => setNotes((n) => ({ ...n, [m.id]: e.target.value }))}
              />
              <button type="button" onClick={() => decide(m, 'approved')} className="px-3 py-1 rounded-lg bg-green-600 text-white text-sm">Approve</button>
              <button type="button" onClick={() => decide(m, 'rejected')} className="px-3 py-1 rounded-lg border border-red-400 text-red-600 dark:text-red-400 text-sm">Deny</button>
            </div>
          </li>
        ))}
      </ul>
      {decided.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-gray-500 dark:text-gray-400">Decided in the last week ({decided.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {decided.map((m) => (
              <li key={m.id}>
                {m.status === 'approved' ? '✓' : '✕'} {m.member_name ?? m.member_id} · {label(m.idx)}
                {m.review_note ? ` — ${m.review_note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

const STANDING_COLS = [
  { key: 'name', label: 'Member', kind: 'string', accessor: (r) => r.name ?? r.member_id },
  { key: 'lines', label: 'Lines', kind: 'number', accessor: (r) => r.lines },
  { key: 'squares', label: 'Squares', kind: 'number', accessor: (r) => r.squares },
  { key: 'pending', label: 'Pending', kind: 'number', accessor: (r) => r.pending },
]

function Standings({ rows, me, onView }) {
  // Lines first, then squares — the server's order — so the board reads as a ranking.
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, STANDING_COLS, { initialCol: 'lines', initialDir: 'desc', tieBreak: 'name' })
  if (!rows.length) return null
  return (
    <section className="card p-0 sm:p-0 overflow-hidden" aria-label="Bingo standings">
      <h4 className="px-4 pt-3 font-semibold text-gray-900 dark:text-white">Standings</h4>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <th className="px-4 py-2 w-10" aria-label="Position">#</th>
              {STANDING_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
                  className={c.kind === 'number' ? 'text-right' : ''}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={r.member_id} className={`border-t border-gray-100 dark:border-slate-700 ${r.member_id === me ? 'font-semibold' : ''}`}>
                <td className="px-4 py-1.5 tabular-nums">{i + 1}</td>
                <td className="px-3 py-1.5">
                  {onView
                    ? <button type="button" className="hover:underline text-left" onClick={() => onView(r.member_id)}>{r.name ?? r.member_id}</button>
                    : (r.name ?? r.member_id)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.lines}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.squares}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.pending || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
