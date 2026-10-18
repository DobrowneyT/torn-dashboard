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
export default function BingoCard({
  card, stateOf = () => null, onPick = null, selected = null, color = '#f97316', showGrid = false,
}) {
  const { rows, cols, grid, image_url: imageUrl } = card
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
        style={{
          ...(isSel ? { boxShadow: `inset 0 0 0 3px ${color}` } : {}),
          ...(showGrid ? { outline: '1px dashed rgba(255,255,255,0.85)', outlineOffset: '-1px' } : {}),
        }}
      >
        {!imageUrl && (
          <span className="block text-[9px] leading-tight sm:text-xs text-gray-700 dark:text-gray-200 line-clamp-5">
            {tile?.kind === 'free' ? '★ Free' : label}
          </span>
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
  return (
    <div className="relative w-full max-w-3xl mx-auto select-none">
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
