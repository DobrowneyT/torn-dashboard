// War Room contextual help (#153, slice 1): a slide-over reference panel opened
// from the "?" button. Renders the structured sections from warRoomHelp.js —
// member sections for everyone, the "For leaders" section only for leaders,
// clearly labelled. This is the durable reference that stays correct as the UI
// evolves; the first-run spotlight tour (slice 2) will reuse the same content.
import { useEffect } from 'react'
import { X, HelpCircle } from 'lucide-react'
import { helpSectionsFor } from './warRoomHelp'

export default function HelpPanel({ open, onClose, isLeader = false }) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const sections = helpSectionsFor({ isLeader })

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="War Room help"
        className="relative w-full max-w-md h-full overflow-y-auto bg-white dark:bg-slate-800 shadow-xl border-l border-gray-200 dark:border-slate-700"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-blue-500" /> War Room — how it works
          </h2>
          <button
            onClick={onClose}
            aria-label="Close help"
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          {sections.map((s) => (
            <section key={s.id}>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
                {s.title}
                {s.forLeaders && (
                  <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 text-[10px] font-semibold">
                    For leaders
                  </span>
                )}
              </h3>
              <dl className="space-y-1.5">
                {s.points.map((p) => (
                  <div key={p.term} className="text-xs">
                    <dt className="font-medium text-gray-800 dark:text-gray-200">{p.term}</dt>
                    <dd className="text-gray-600 dark:text-gray-400">{p.desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}
