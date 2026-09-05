import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/**
 * A tooltip you can also read on a phone (#604).
 *
 * The panel deliberately matches BattleStatsCell's — same border, surface,
 * shadow and 11px type — so the app has one tooltip language rather than a
 * different one per page. What it does NOT copy is that component's
 * `group-hover` CSS-only mechanism, for two reasons:
 *
 *  1. ⚠️ **A touchscreen has no hover.** `group-hover` needs a real pointer, so
 *     on mobile the content was simply unreachable — and the native `title`
 *     attribute it replaced was no better: mobile browsers show `title` on
 *     neither tap nor long press. The description was invisible on the device,
 *     with nothing on screen to suggest anything was missing.
 *
 *  2. ⚠️ **`position: absolute` gets clipped.** Its first home, Global Admin's
 *     Scraper Jobs table, lives inside an `overflow-x-auto` wrapper, which
 *     clips and scrolls an absolutely-positioned child. Measuring the trigger
 *     and painting at fixed viewport coordinates escapes every ancestor's
 *     overflow, and is also what lets the panel clamp itself onto a 320px
 *     screen instead of hanging off the edge.
 *
 * Open on hover or focus for a pointer; toggle on click for a thumb. Escape and
 * an outside press close it, so a tap-opened panel is never stuck on screen.
 */

/** Roughly the reading width of the longest job description at 11px. */
const PANEL_MAX = 340
const MARGIN = 8
const GAP = 6

/**
 * Where the panel goes, in viewport coordinates — pure, so the clamping is
 * testable without a DOM.
 *
 * Below the trigger normally; flipped above when there is not room below and
 * there is above, which is what stops a row near the foot of a long table
 * opening a panel nobody can read.
 */
export function tooltipPosition(rect, viewport, size) {
  const width = Math.min(size?.w || PANEL_MAX, Math.max(0, viewport.w - MARGIN * 2))
  const height = size?.h || 0
  const maxLeft = Math.max(MARGIN, viewport.w - width - MARGIN)
  const left = Math.min(Math.max(MARGIN, rect.left), maxLeft)

  const below = rect.bottom + GAP
  const roomBelow = viewport.h - below
  const roomAbove = rect.top - GAP
  const flip = height > 0 && roomBelow < height && roomAbove > roomBelow
  const top = flip ? Math.max(MARGIN, rect.top - GAP - height) : below
  return { left, top, width, placement: flip ? 'above' : 'below' }
}

export default function InfoTooltip({ label, children, className = '' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const id = useId()

  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el?.getBoundingClientRect) return
    const rect = el.getBoundingClientRect()
    const panel = panelRef.current
    setPos(tooltipPosition(
      rect,
      { w: window.innerWidth, h: window.innerHeight },
      { w: panel?.offsetWidth || PANEL_MAX, h: panel?.offsetHeight || 0 },
    ))
  }, [])

  // Two passes on purpose: the first paints the panel so it has a height, the
  // second re-places it now that the height is known. Without the second, the
  // flip-above branch could never fire — height is 0 until something renders.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    // Capture phase, and pointerdown rather than click: a tap elsewhere should
    // dismiss before that element acts on it, the way a menu does.
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return
      if (panelRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onMove = () => place()
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onMove)
    // Capture, so the panel follows a scroll inside the table wrapper too and
    // not only a scroll of the page itself.
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, place])

  if (!children) return <>{label}</>

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Hover is a convenience for a mouse, never the only way in.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`text-left cursor-help underline decoration-dotted decoration-gray-400 dark:decoration-slate-600 underline-offset-2 ${className}`}
      >
        {label}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={id}
          role="tooltip"
          style={{
            position: 'fixed',
            left: pos ? `${pos.left}px` : '-9999px',
            top: pos ? `${pos.top}px` : '-9999px',
            width: pos ? `${pos.width}px` : `${PANEL_MAX}px`,
          }}
          className="z-50 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg text-left p-2.5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-200"
        >
          {children}
        </div>
      )}
    </>
  )
}
