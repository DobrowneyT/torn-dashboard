import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

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
 *
 * Three trigger shapes, because #612's sweep hits three different situations:
 *
 *   <InfoTooltip label="…">      a button trigger — the default, for text or a
 *                                glyph that is not otherwise interactive.
 *   <InfoTooltip wrap>…</…>      a span trigger WRAPPING a control that has to
 *                                stay itself (a link, an input, a disabled
 *                                button). Nesting a button inside a button is
 *                                invalid, and would also swallow the control's
 *                                own click.
 *   <InfoDot>…</InfoDot>         a small ⓘ beside an ENABLED control. A wrap
 *                                around one of those would have to choose
 *                                between opening the panel and activating the
 *                                control on the same tap; a separate dot does
 *                                not have to choose.
 */

/** The panel never grows past this; short content stays narrower. */
const PANEL_MAX = 340
const MARGIN = 8
const GAP = 6

/** The default "there is something under here" affordance. */
export const DOTTED =
  'underline decoration-dotted decoration-gray-400 dark:decoration-slate-600 underline-offset-2'

/**
 * Where the panel goes, in viewport coordinates — pure, so the clamping is
 * testable without a DOM.
 *
 * Below the trigger normally; flipped above when there is not room below and
 * there is above, which is what stops a row near the foot of a long table
 * opening a panel nobody can read.
 */
export function tooltipPosition(rect, viewport, size) {
  // ⚠️ A CAP, not a width. The panel used to be painted at PANEL_MAX every
  // time, which made a four-word tooltip 340px of mostly empty box — the
  // battle-stats breakdown in particular went from a tidy ~150px table to a
  // banner. `position: fixed` shrink-wraps to its content, so handing it only a
  // maxWidth gets the old widths back without hardcoding one per caller.
  const maxWidth = Math.max(0, Math.min(PANEL_MAX, viewport.w - MARGIN * 2))
  // `size.w` is the MEASURED width once the panel has painted; before that we
  // have to assume the cap, which is what the second placement pass fixes.
  const width = Math.min(size?.w || maxWidth, maxWidth)
  const height = size?.h || 0
  const maxLeft = Math.max(MARGIN, viewport.w - width - MARGIN)
  const left = Math.min(Math.max(MARGIN, rect.left), maxLeft)

  const below = rect.bottom + GAP
  const roomBelow = viewport.h - below
  const roomAbove = rect.top - GAP
  const flip = height > 0 && roomBelow < height && roomAbove > roomBelow
  const top = flip ? Math.max(MARGIN, rect.top - GAP - height) : below
  return { left, top, width, maxWidth, placement: flip ? 'above' : 'below' }
}

/**
 * Render a "\n"-joined explanation as separate lines.
 *
 * Half the native tooltips being replaced built their text by joining an array
 * with newlines, because that is all a `title` can do. A panel can lay the same
 * sentences out properly, and squashing them back into one paragraph would lose
 * the structure the author already decided on.
 */
export function tipLines(text) {
  if (text == null) return null
  const parts = String(text).split('\n').map((t) => t.trim()).filter(Boolean)
  if (parts.length === 0) return null
  return parts.map((t, i) => <div key={i} className={i === 0 ? '' : 'mt-1.5'}>{t}</div>)
}

/**
 * The open/close/placement machinery, shared by every trigger shape.
 *
 * Returns refs to attach and the panel to render, so a caller only decides what
 * the trigger element IS — the behaviour never forks between shapes.
 */
function useTooltip(children) {
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

  const panel = open ? (
    <div
      ref={panelRef}
      id={id}
      role="tooltip"
      style={{
        position: 'fixed',
        left: pos ? `${pos.left}px` : '-9999px',
        top: pos ? `${pos.top}px` : '-9999px',
        // No `width`: a fixed-position box shrink-wraps its content, so the
        // panel is exactly as wide as it needs to be, up to the cap.
        maxWidth: `${pos ? pos.maxWidth : PANEL_MAX}px`,
      }}
      // ⚠️ The typography resets are not cosmetic. The panel is a DOM
      // descendant of its trigger even though it paints at fixed coordinates,
      // so it INHERITS from whatever it sits in. In the War Room that meant a
      // header's `uppercase tracking-wide whitespace-nowrap`: the Fair Fight
      // explanation rendered in caps and could not wrap, so it ran straight out
      // of its own rounded box. Table cells carry `whitespace-nowrap` too.
      className="z-50 w-max rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg p-2.5 text-[11px] leading-relaxed text-gray-700 dark:text-gray-200 text-left font-normal normal-case not-italic tracking-normal whitespace-normal break-words"
    >
      {children}
    </div>
  ) : null

  return { open, setOpen, triggerRef, panel, id }
}

/**
 * ⚠️ A tap that lands on a live control must press that control, not open a
 * panel. Only a tap on the wrapper's own space — or on a DISABLED child, whose
 * events index.css redirects to the wrapper — toggles the tooltip.
 */
function isLiveControl(target) {
  const el = target?.closest?.('a,button,input,select,textarea,[role="button"]')
  return !!el && !el.disabled
}

export default function InfoTooltip({
  label,
  children,
  className = '',
  decoration = DOTTED,
  ariaLabel,
  // ⚠️ Inline styles on the TRIGGER, not the panel. A wrapped element that is
  // positioned by its parent — a grid band placed with gridColumn/gridRow — has
  // to hand that placement to the wrapper, or the wrapper becomes the grid item
  // and the child lands in the wrong cell.
  style,
  wrap = false,
}) {
  const { open, setOpen, triggerRef, panel, id } = useTooltip(children)

  // Nothing to say: render the label (or the wrapped control) untouched, with
  // no affordance suggesting there is something to open.
  if (!children) return <>{label}</>

  if (wrap) {
    return (
      <>
        <span
          ref={triggerRef}
          aria-label={ariaLabel}
          // `tip-wrap` only exists to neutralise pointer events on a DISABLED
          // child (see index.css). ⚠️ Without it the disabled-reason tooltips
          // are unreachable on a phone: a disabled control does not dispatch
          // pointer events at all, so the wrapper never sees the tap either,
          // and "why is this greyed out?" has no answer on the device.
          className={`tip-wrap inline-flex ${className}`}
          style={style}
          aria-describedby={open ? id : undefined}
          onPointerDown={(e) => { if (!isLiveControl(e.target)) setOpen((v) => !v) }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          // focus/blur bubble in React, so focusing the wrapped control opens
          // the panel — which is how a keyboard reaches it.
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          {label}
        </span>
        {panel}
      </>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        style={style}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        // Hover is a convenience for a mouse, never the only way in.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={`text-left cursor-help ${decoration} ${className}`}
      >
        {label}
      </button>
      {panel}
    </>
  )
}

/**
 * A small ⓘ that sits BESIDE a control rather than around it (#612).
 *
 * For anything a user is meant to click, the explanation cannot live on the
 * control itself: on a touchscreen the one tap has to either open the panel or
 * press the button, and it must press the button. So the explanation gets its
 * own tap target.
 */
export function InfoDot({ children, className = '', size = 13, label = 'More information' }) {
  return (
    <InfoTooltip
      label={<Info size={size} aria-hidden="true" />}
      decoration="no-underline"
      className={`inline-flex items-center align-middle text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0 ${className}`}
      ariaLabel={label}
    >
      {children}
    </InfoTooltip>
  )
}
