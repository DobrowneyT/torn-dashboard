/**
 * The bingo card (#965): the uploaded art with a grid of squares laid over it.
 *
 * ⚠️ The image is a SKIN. The squares are positioned from the card's grid
 * settings (percentages of the image), so any art works as long as its squares
 * sit on an even grid — and with no image at all the squares draw themselves
 * from their text.
 *
 * Shared by the member's card and the Settings preview, so what leadership
 * lines up is exactly what members see.
 */
import { useRef } from 'react'

export default function BingoCard({
  card, stateOf = () => null, onPick = null, selected = null, color = '#f97316', showGrid = false,
  onGridChange = null,
}) {
  const { rows, cols, grid, image_url: imageUrl } = card
  // The art's gap between squares, as a percent of one square: crosses and
  // outlines sit inside each square rather than over its border.
  const inset = `${Math.max(0, Number(grid.gap) || 0) / 2}%`
  const frame = useRef(null)
  const byIdx = new Map((card.tiles ?? []).map((t) => [t.idx, t]))
  const cells = Array.from({ length: rows * cols }, (_, idx) => idx)

  const cell = (idx) => {
    const tile = byIdx.get(idx)
    const state = tile?.kind === 'free' ? 'crossed' : stateOf(idx)
    const label = tile?.label || `Square ${idx + 1}`
    const isSel = selected === idx
    const Tag = onPick ? 'button' : 'div'
    return (
      <Tag
        key={idx}
        type={onPick ? 'button' : undefined}
        onClick={onPick ? () => onPick(idx) : undefined}
        aria-label={`${label}${state === 'crossed' ? ' — crossed' : state === 'pending' ? ' — waiting for review' : ''}`}
        aria-pressed={onPick ? isSel : undefined}
        data-testid={`bingo-cell-${idx}`}
        className={`relative min-w-0 overflow-hidden text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${
          imageUrl ? 'rounded-md' : 'rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-1 sm:p-2 aspect-square'
        } ${onPick ? 'cursor-pointer hover:bg-white/10' : ''}`}
        style={!imageUrl && isSel ? { boxShadow: `inset 0 0 0 3px ${color}` } : undefined}
      >
        {!imageUrl && (
          <span className="block text-[9px] leading-tight sm:text-xs text-gray-700 dark:text-gray-200 line-clamp-5">
            {tile?.kind === 'free' ? '★ Free' : label}
          </span>
        )}
        <span className="pointer-events-none absolute" style={{ inset: imageUrl ? inset : 0 }}>
        {imageUrl && (isSel || showGrid) && (
          <span className="absolute inset-0 rounded-md" style={{
            ...(isSel ? { boxShadow: `inset 0 0 0 3px ${color}` } : {}),
            ...(showGrid && !isSel ? { outline: '1.5px dashed rgba(255,255,255,0.9)', outlineOffset: '-1px' } : {}),
          }} />
        )}
        {showGrid && (
          <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px] font-mono text-white">{idx + 1}</span>
        )}
        {state === 'crossed' && tile?.kind !== 'free' && <Cross color={color} />}
        {state === 'crossed' && tile?.kind === 'free' && !imageUrl && <Cross color={color} />}
        {state === 'pending' && (
          <span className="absolute inset-0 flex items-end justify-center pb-1 rounded-md"
            style={{ boxShadow: `inset 0 0 0 2px ${color}`, background: 'rgba(0,0,0,0.35)' }}>
            <span className="rounded px-1.5 py-0.5 text-[9px] sm:text-[11px] font-semibold text-white" style={{ background: color }}>
              Pending
            </span>
          </span>
        )}
        </span>
      </Tag>
    )
  }

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  }

  if (!imageUrl) {
    return <div className="w-full max-w-3xl mx-auto gap-1 sm:gap-2" style={gridStyle}>{cells.map(cell)}</div>
  }
  /**
   * Settings only: drag the grid's top-left and bottom-right corners onto the
   * art's outer squares. The squares are the even split between them.
   * ⚠️ Pointer events with capture, and `touch-action: none` on the handles,
   * so a finger drags the corner instead of scrolling the page.
   */
  const handle = (corner) => {
    const move = (e) => {
      const r = frame.current?.getBoundingClientRect()
      if (!r || !r.width || !r.height) return
      const x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)) * 10) / 10
      const y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)) * 10) / 10
      onGridChange(corner === 'tl'
        ? { ...grid, left: Math.min(x, grid.right - 1), top: Math.min(y, grid.bottom - 1) }
        : { ...grid, right: Math.max(x, grid.left + 1), bottom: Math.max(y, grid.top + 1) })
    }
    const at = corner === 'tl' ? { left: `${grid.left}%`, top: `${grid.top}%` } : { left: `${grid.right}%`, top: `${grid.bottom}%` }
    return (
      <span
        key={corner}
        role="slider"
        tabIndex={0}
        aria-label={corner === 'tl' ? 'Top-left corner of the grid' : 'Bottom-right corner of the grid'}
        aria-valuetext={corner === 'tl' ? `${grid.left}%, ${grid.top}%` : `${grid.right}%, ${grid.bottom}%`}
        data-testid={`bingo-corner-${corner}`}
        className="absolute z-10 -ml-4 -mt-4 flex h-8 w-8 cursor-grab items-center justify-center rounded-full border-2 border-white shadow-lg"
        style={{ ...at, background: color, touchAction: 'none' }}
        onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); move(e) }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) move(e) }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 0.1
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
          if (!d) return
          e.preventDefault()
          const r1 = (v) => Math.round(v * 10) / 10
          onGridChange(corner === 'tl'
            ? { ...grid, left: r1(grid.left + d[0]), top: r1(grid.top + d[1]) }
            : { ...grid, right: r1(grid.right + d[0]), bottom: r1(grid.bottom + d[1]) })
        }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
      </span>
    )
  }

  return (
    <div ref={frame} className="relative w-full max-w-3xl mx-auto select-none">
      <img src={imageUrl} alt="Bingo card" className="block w-full h-auto rounded-xl" draggable={false} />
      <div
        className="absolute"
        style={{
          ...gridStyle,
          left: `${grid.left}%`,
          top: `${grid.top}%`,
          width: `${grid.right - grid.left}%`,
          height: `${grid.bottom - grid.top}%`,
        }}
      >
        {cells.map(cell)}
      </div>
      {onGridChange && [handle('tl'), handle('br')]}
    </div>
  )
}

/** The cross itself: two strokes, drawn over the square's art. */
function Cross({ color }) {
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}>
      <rect x="0" y="0" width="100" height="100" fill={color} opacity="0.18" />
      <line x1="12" y1="12" x2="88" y2="88" stroke={color} strokeWidth="9" strokeLinecap="round" />
      <line x1="88" y1="12" x2="12" y2="88" stroke={color} strokeWidth="9" strokeLinecap="round" />
    </svg>
  )
}
