// Per-member war note affordance (#199): a small pencil on a roster row.
// Hovering shows the note (read-only) for everyone; clicking the pencil opens
// the editor — war leads / leadership / admin only. A click also "pins" the
// popover open (so it works on touch, where there's no hover). The icon is
// highlighted when a note exists.
import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'

export default function MemberNoteButton({ memberId, memberName, note = '', canEdit = false, onSave }) {
  const [hoverOpen, setHoverOpen] = useState(false)
  const [pinned, setPinned] = useState(false)   // clicked open — survives mouseleave
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  const hasNote = !!(note && note.trim())

  useEffect(() => { if (editing) setDraft(note || '') }, [editing, note])

  // Outside-click / Escape close only matter once it's pinned (hover closes
  // itself on mouseleave).
  useEffect(() => {
    if (!pinned) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) close() }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  // Nothing to show a plain member if there's no note and they can't edit.
  if (!hasNote && !canEdit) return null

  function close() { setPinned(false); setEditing(false); setHoverOpen(false) }

  function onPencilClick(e) {
    e.stopPropagation()
    if (canEdit) { setEditing(true); setPinned(true) }
    else { setPinned(p => !p) }  // touch: tap to pin the read-only view
  }

  async function save() {
    setBusy(true)
    try { await onSave?.(memberId, draft); close() }
    finally { setBusy(false) }
  }

  // Popover shows on hover only when there's a note to read; a click (pin)
  // always shows it (view for members, editor for leads).
  const visible = (hoverOpen && hasNote) || pinned

  return (
    <span
      className="relative inline-flex"
      ref={ref}
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
    >
      <button
        type="button"
        onClick={onPencilClick}
        aria-label={canEdit ? 'Edit member note' : 'View member note'}
        className={`p-1 rounded ${hasNote
          ? 'text-amber-500 hover:text-amber-600'
          : 'text-gray-300 dark:text-gray-600 hover:text-gray-500'}`}
      >
        <Pencil className="w-3.5 h-3.5" fill={hasNote ? 'currentColor' : 'none'} />
      </button>
      {visible && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full mt-1 z-40 w-64 p-2.5 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl text-left normal-case"
        >
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
              Note — {memberName || memberId}
            </span>
            {pinned && (
              <button onClick={close} aria-label="Close" className="p-0.5 text-gray-400 hover:text-gray-600">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {editing ? (
            <>
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                placeholder="Wears X armour · Y job · Z timezone · OD-prone…"
                className="w-full px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-gray-900 dark:text-white resize-none"
              />
              <div className="mt-2 flex items-center justify-end gap-2">
                <button onClick={close} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
                <button onClick={save} disabled={busy}
                  className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50">
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          ) : hasNote ? (
            <>
              <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{note}</p>
              {canEdit && (
                <button onClick={() => { setEditing(true); setPinned(true) }}
                  className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">Edit</button>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-500">No note yet — click the pencil to add one.</p>
          )}
        </div>
      )}
    </span>
  )
}
