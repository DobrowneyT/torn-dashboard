import { useEffect, useState } from 'react'
import { apiGet, apiPut, apiDelete } from '../../utils/apiClient'
import BingoCard from './BingoCard'

/**
 * Setting up the event's bingo card (#965). Leadership/admin.
 *
 * ⚠️ The image is only the art. Line the grid up over its squares with the four
 * edges (percent of the image) and the preview shows exactly what members get.
 * Each square's text and type live here as data — that is what makes a square
 * automatic, reviewable, and readable with no image at all.
 */
const FIELD = 'w-full rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm text-gray-900 dark:text-white'
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'
const IMAGE_MAX = 5 * 1024 * 1024

function resize(tiles, rows, cols) {
  const byIdx = new Map(tiles.map((t) => [t.idx, t]))
  return Array.from({ length: rows * cols }, (_, idx) => byIdx.get(idx) ?? { idx, label: '', kind: 'proof', rule: null })
}

export default function BingoSettings({ event }) {
  const [card, setCard] = useState(null)
  const [rules, setRules] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    apiGet(`/api/events/${event.id}/bingo`)
      .then((d) => {
        setRules(d?.auto_rules ?? [])
        const rows = Number(d?.rows) || 5
        const cols = Number(d?.cols) || 5
        setCard({ enabled: !!d?.enabled, rows, cols,
          grid: d?.grid ?? { left: 0, top: 0, right: 100, bottom: 100 }, image_url: d?.image_url ?? null,
          tiles: resize(d?.tiles ?? [], rows, cols) })
      })
      .catch((err) => setError(err.message || 'Could not load the bingo card.'))
  }, [event.id])

  if (!card) return error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null

  const update = (patch) => setCard((c) => {
    const next = { ...c, ...patch }
    return { ...next, tiles: resize(next.tiles, next.rows, next.cols) }
  })
  const setGrid = (k) => (e) => update({ grid: { ...card.grid, [k]: Number(e.target.value) } })
  const setTile = (idx, patch) => setCard((c) => ({ ...c, tiles: c.tiles.map((t) => (t.idx === idx ? { ...t, ...patch } : t)) }))

  async function run(fn, done) {
    setBusy(true); setError(null); setNotice(null)
    try { await fn(); if (done) setNotice(done) } catch (err) { setError(err.message || 'That did not work.') } finally { setBusy(false) }
  }

  const save = () => run(async () => {
    const saved = await apiPut(`/api/events/${event.id}/bingo`, {
      enabled: card.enabled, rows: card.rows, cols: card.cols, grid: card.grid,
      tiles: card.tiles.map((t) => ({ idx: t.idx, label: t.label, kind: t.kind, rule: t.kind === 'auto' ? t.rule : null })),
    })
    setCard((c) => ({ ...c, image_url: saved.image_url }))
  }, 'Bingo card saved.')

  const upload = (file) => run(async () => {
    if (!file) return
    if (file.size > IMAGE_MAX) throw new Error('The card image must be 5 MB or smaller.')
    const data = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = rej
      r.readAsDataURL(file)
    })
    const saved = await apiPut(`/api/events/${event.id}/bingo/image`, { content_type: file.type, data_base64: data })
    setCard((c) => ({ ...c, image_url: saved.image_url }))
  }, 'Image uploaded. Line the grid up below, then Save.')

  const removeImage = () => run(async () => {
    await apiDelete(`/api/events/${event.id}/bingo/image`)
    setCard((c) => ({ ...c, image_url: null }))
  }, 'Image removed.')

  const template = () => run(async () => {
    if (card.tiles.some((t) => t.label) && !window.confirm('Replace every square with the Halloween card?')) return
    const t = await apiGet(`/api/events/${event.id}/bingo/template`)
    setCard((c) => ({ ...c, rows: t.rows, cols: t.cols, grid: t.grid, tiles: resize(t.tiles, t.rows, t.cols) }))
  }, 'Halloween squares loaded — not saved yet.')

  return (
    <section className="card p-6 space-y-5 max-w-3xl" aria-label="Bingo settings">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Bingo</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          One card for everyone; each member crosses squares off their own copy. Automatic squares cross themselves
          from attacks, attack logs, Chain Watch and travel; the rest need proof that leadership reviews.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={card.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        Show the Bingo tab to members
      </label>

      <div className="space-y-2">
        <span className={LABEL}>Card image</span>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          PNG, JPEG, WebP or GIF, up to 5 MB. Any art works as long as its squares sit on an even grid.
          Without an image the squares draw their own text.
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm cursor-pointer">
            {card.image_url ? 'Replace image' : 'Upload image'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" disabled={busy}
              onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          {card.image_url && (
            <button type="button" disabled={busy} onClick={removeImage}
              className="px-3 py-1.5 rounded-lg border border-red-400 text-red-600 dark:text-red-400 text-sm">Remove image</button>
          )}
          <button type="button" disabled={busy} onClick={template}
            className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm">Use the Halloween squares</button>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-6">
        <label><span className={LABEL}>Rows</span>
          <input type="number" min="1" max="10" className={FIELD} value={card.rows}
            onChange={(e) => update({ rows: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></label>
        <label><span className={LABEL}>Columns</span>
          <input type="number" min="1" max="10" className={FIELD} value={card.cols}
            onChange={(e) => update({ cols: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} /></label>
        {['left', 'top', 'right', 'bottom'].map((k) => (
          <label key={k}><span className={LABEL}>{k[0].toUpperCase() + k.slice(1)} %</span>
            <input type="number" min="0" max="100" step="0.1" className={FIELD} value={card.grid[k]} onChange={setGrid(k)} /></label>
        ))}
      </div>

      <div>
        <span className={LABEL}>Preview — the dashed boxes are the squares members tap</span>
        <BingoCard card={card} color={event.theme_color} showGrid />
      </div>

      <div className="space-y-2">
        <span className={LABEL}>Squares (left to right, top to bottom)</span>
        <ol className="space-y-2">
          {card.tiles.map((t) => (
            <li key={t.idx} className="grid gap-2 sm:grid-cols-[2.5rem_1fr_8rem_14rem] items-center">
              <span className="text-xs font-mono text-gray-500">{t.idx + 1}</span>
              <input className={FIELD} value={t.label} maxLength={200} placeholder="What to do"
                aria-label={`Square ${t.idx + 1} text`} onChange={(e) => setTile(t.idx, { label: e.target.value })} />
              <select className={FIELD} value={t.kind} aria-label={`Square ${t.idx + 1} type`}
                onChange={(e) => setTile(t.idx, { kind: e.target.value, rule: e.target.value === 'auto' ? (t.rule ?? rules[0]?.key ?? null) : null })}>
                <option value="proof">Proof</option>
                <option value="auto">Automatic</option>
                <option value="free">Free</option>
              </select>
              {t.kind === 'auto' ? (
                <select className={FIELD} value={t.rule ?? ''} aria-label={`Square ${t.idx + 1} rule`}
                  onChange={(e) => setTile(t.idx, { rule: e.target.value })}>
                  {rules.map((r) => <option key={r.key} value={r.key}>{r.label} ({r.source})</option>)}
                </select>
              ) : <span className="hidden sm:block" />}
            </li>
          ))}
        </ol>
      </div>

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
      <button type="button" disabled={busy} onClick={save}
        className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium disabled:opacity-50">Save bingo card</button>
    </section>
  )
}
