// Per-member war note affordance (#199): a small pencil on a roster row.
// Everyone can open it to read the note; war leads / leadership / admin get an
// editor. The icon is highlighted when a note exists. Self-contained popover.
import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'

export default function MemberNoteButton({ memberId, memberName, note = '', canEdit = false, onSave }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const hasNote = !!(note && note.trim())

  useEffect(() => { if (open) setDraft(note || '') }, [open, note])
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Nothing to show a plain member if there's no note and they can't edit.
  if (!hasNote && !canEdit) return null

  async function save() {
    setBusy(true)
    try { await onSave?.(memberId, draft); setOpen(false) }
    finally { setBusy(false) }
  }

  return (
    <span className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        title={hasNote ? `Note: ${note}` : 'Add a note'}
        aria-label={hasNote ? 'View or edit member note' : 'Add member note'}
        className={`p-1 rounded ${hasNote
          ? 'text-amber-500 hover:text-amber-600'
          : 'text-gray-300 dark:text-gray-600 hover:text-gray-500'}`}
      >
        <Pencil className="w-3.5 h-3.5" fill={hasNote ? 'currentColor' : 'none'} />
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full mt-1 z-40 w-64 p-2.5 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl text-left normal-case"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
              Note — {memberName || memberId}
            </span>
            <button onClick={() => setOpen(false)} aria-label="Close" className="p-0.5 text-gray-400 hover:text-gray-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {canEdit ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                placeholder="Wears X armour · Y job · Z timezone · OD-prone…"
                className="w-full px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-900 dark:text-white resize-none"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button onClick={() => setOpen(false)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
                <button onClick={save} disabled={busy}
                  className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{note}</p>
          )}
        </div>
      )}
    </span>
  )
}
