import { useLayoutEffect, useRef, useState } from 'react'
import InfoTooltip from './InfoTooltip'

/**
 * Text that may be cut short, with a tooltip ONLY when it actually is.
 *
 * ⚠️ Replaces a pattern MonChoon called "basically useless" (2026-10-18):
 * `<InfoTooltip label={<span className="truncate">{x}</span>}>{x}</InfoTooltip>`
 * on every row, so a CPR role name like "Hacker" hovered to show… "Hacker".
 * The tooltip is only worth having when the text is truncated on screen, so
 * this measures it and otherwise renders plain text with no affordance.
 */
export default function TruncatedText({ text, className = '', block = true }) {
  const ref = useRef(null)
  const [cut, setCut] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    ro?.observe(el)
    return () => ro?.disconnect()
    // `cut` too: switching to the tooltip re-mounts the span, and the observer
    // must follow it to notice the text fitting again.
  }, [text, cut])

  const inner = <span ref={ref} className={`${block ? 'block' : ''} truncate`}>{text}</span>
  if (!cut) return <span className={`${block ? 'block' : 'inline-block'} min-w-0 ${className}`}>{inner}</span>
  return <InfoTooltip label={inner} decoration="no-underline" className={className}>{text}</InfoTooltip>
}
