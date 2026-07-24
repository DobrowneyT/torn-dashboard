// Lightweight home-grown spotlight tour (#153 part 2). Given a steps array, it
// highlights each step's `data-tour` target in place with a dimmed backdrop +
// a tooltip card, and steps through with Back / Next and a prominent one-click
// Skip. Any step whose target isn't in the DOM is skipped, not broken, so a
// role-gated / no-active-war / closed-overlay target never traps the tour.
import { useState, useEffect, useCallback, useLayoutEffect } from 'react'
import { X } from 'lucide-react'
import { firstPresentStep } from '../../utils/warRoomTour'

const PAD = 6 // highlight ring padding around the target

function targetEl(step) {
  return step ? document.querySelector(`[data-tour="${step.id}"]`) : null
}
const isPresent = (step) => !!targetEl(step)

export default function SpotlightTour({ steps, onFinish }) {
  // Start at the first step whose target is actually present.
  const [index, setIndex] = useState(() => firstPresentStep(steps, 0, 1, isPresent))
  const [rect, setRect] = useState(null)

  const finish = useCallback(() => onFinish?.(), [onFinish])

  const go = useCallback((dir) => {
    setIndex((cur) => {
      const next = firstPresentStep(steps, cur + dir, dir, isPresent)
      if (next === -1) {
        // No more present steps in this direction: forward → done; back → stay.
        if (dir === 1) finish()
        return cur
      }
      return next
    })
  }, [steps, finish])

  const step = index >= 0 ? steps[index] : null

  // Track the target's position (recompute on scroll/resize). If it vanished,
  // skip forward to the next present step.
  useLayoutEffect(() => {
    if (!step) { finish(); return }
    const measure = () => {
      const el = targetEl(step)
      if (!el) { go(1); return }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step, go, finish])

  // Escape skips (same as the Skip button).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') finish() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [finish])

  if (!step || !rect) return null

  const total = steps.length
  const stepNo = index + 1
  // Place the card below the target when there's room, else above.
  const below = rect.top + rect.height + 180 < window.innerHeight
  const cardTop = below ? rect.top + rect.height + PAD + 8 : Math.max(8, rect.top - PAD - 8 - 170)
  const cardLeft = Math.min(Math.max(8, rect.left), window.innerWidth - 320 - 8)

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Dim backdrop with a transparent hole over the target (box-shadow trick);
          clicks on the dim area skip the tour. */}
      <div
        onClick={finish}
        className="absolute rounded-lg pointer-events-auto"
        style={{
          top: rect.top - PAD, left: rect.left - PAD,
          width: rect.width + PAD * 2, height: rect.height + PAD * 2,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          outline: '2px solid rgb(59 130 246)',
        }}
      />
      {/* Tooltip card */}
      <div
        className="absolute w-80 max-w-[calc(100vw-16px)] rounded-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 shadow-xl p-3"
        style={{ top: cardTop, left: cardLeft }}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{step.title}</h3>
          <button onClick={finish} aria-label="Skip tutorial" className="p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-300">{step.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <button onClick={finish} className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 underline">
            Skip tutorial
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-400">{stepNo} / {total}</span>
            {index > firstPresentStep(steps, 0, 1, isPresent) && (
              <button onClick={() => go(-1)} className="px-2.5 py-1 rounded text-xs border border-gray-200 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:border-blue-400">
                Back
              </button>
            )}
            <button onClick={() => go(1)} className="px-2.5 py-1 rounded text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium">
              {firstPresentStep(steps, index + 1, 1, isPresent) === -1 ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
