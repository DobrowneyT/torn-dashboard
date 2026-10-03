import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * #841 — the Name column survives horizontal scroll.
 *
 * ⚠️ Source-reading, not rendering, and on purpose: `WarRoomViewV2` needs
 * sockets, auth and a live roster to mount, and none of that would make the
 * assertions below any stronger. What can actually break here is CSS stacking,
 * which jsdom does not compute at all — it has no layout engine, so a render
 * test would report success with the frozen column painted behind the rows.
 * So the invariants are pinned against the stylesheet and the markup directly.
 */

const CSS = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
const VIEW = readFileSync(new URL('../WarRoomViewV2.jsx', import.meta.url), 'utf8')

const zIndexOf = (selector) => {
  // The declaration block for a selector, up to its closing brace.
  const at = CSS.indexOf(selector)
  if (at === -1) return null
  const block = CSS.slice(at, CSS.indexOf('}', at))
  const m = block.match(/@apply[^;]*\bz-(\d+)/) || block.match(/z-index:\s*(\d+)/)
  return m ? Number(m[1]) : null
}

describe('the frozen column is actually frozen', () => {
  it('sticks to the left edge, which is the whole point', () => {
    // ⚠️ `left-0`, not `top-0`. The vertical case was already solved, and the
    // report was specifically about scrolling RIGHT and losing the name.
    expect(zIndexOf('.frozen-col {')).not.toBeNull()
    const block = CSS.slice(CSS.indexOf('.frozen-col {'), CSS.indexOf('}', CSS.indexOf('.frozen-col {')))
    expect(block).toMatch(/\bsticky\b/)
    expect(block).toMatch(/\bleft-0\b/)
  })

  it('the Name header and the Name cell both read the same toggle', () => {
    expect(VIEW).toMatch(/col="name"[^>]*frozen=\{nameFrozen\}/)
    expect(VIEW).toMatch(/max-w-\[13rem\] \$\{frozenCell\}/)
  })

  it('the row is a hover group so the frozen cell lights up with it', () => {
    // Without `group` on the <tr>, the frozen cell stays unlit while the rest
    // of its row highlights — which reads as a rendering fault.
    expect(VIEW).toMatch(/<tr key=\{m\.member_id\} className=\{`group /)
    expect(CSS).toMatch(/\.group:hover \.frozen-col/)
  })
})

describe('stacking order (#331 is the trap this guards)', () => {
  const HEADER_Z = 20 // `sticky top-0 z-20` on SortTh

  it('frozen body cells sit above the scrolling body but below the header', () => {
    const body = zIndexOf('.frozen-col {')
    expect(body).toBeGreaterThan(0)      // above z-auto scrolling cells
    expect(body).toBeLessThan(HEADER_Z)  // the header still wins
  })

  it('the corner cell sits above BOTH the header row and the frozen cells', () => {
    const corner = zIndexOf('.frozen-col-head')
    expect(corner).toBeGreaterThan(HEADER_Z)
    expect(corner).toBeGreaterThan(zIndexOf('.frozen-col {'))
  })

  it('the corner cell emits exactly one z-index, not a cascade gamble', () => {
    // ⚠️ `sticky top-0 z-20 ... z-30` on one element is decided by the order
    // Tailwind happens to write the utilities out in, not by class order. The
    // frozen header therefore swaps the stickiness class wholesale.
    expect(VIEW).toMatch(/const stick = frozen \? 'frozen-col-head' : 'sticky top-0 z-20'/)
    expect(VIEW).not.toMatch(/py-2\.5 px-3 sticky top-0 z-20[^`]*\$\{className\}/)
  })

  it('a hovered or focused frozen cell lifts so its popovers escape', () => {
    // The Name cell holds an OD tooltip, a loadout shield and the note button.
    // All are inside the cell, so all are clamped by its stacking context
    // unless the cell itself rises — `position: fixed` does not escape one.
    const lift = zIndexOf('.frozen-col:hover')
    expect(lift).toBeGreaterThan(HEADER_Z)
    expect(CSS).toMatch(/\.frozen-col:focus-within/)
  })
})

describe('the frozen cell paints opaquely', () => {
  it('carries its own background, because a <tr> background does not reach it', () => {
    const block = CSS.slice(CSS.indexOf('.frozen-col {'), CSS.indexOf('}', CSS.indexOf('.frozen-col {')))
    expect(block).toMatch(/bg-white/)
    expect(block).toMatch(/dark:bg-slate-900/)
  })

  it('⚠️ puts the translucent stripe in background-IMAGE, not background-color', () => {
    // Copying `bg-gray-50/50` onto the cell as a colour paints the tint at
    // full strength over nothing and leaves a visible seam down the frozen
    // boundary — glaring in dark mode, where slate-800/40 over slate-900 is
    // nowhere near opaque slate-800. Layering image-over-colour composites to
    // exactly what the rest of the row shows.
    for (const sel of ['.frozen-col-striped', '.group:hover .frozen-col']) {
      const at = CSS.indexOf(sel)
      expect(at, `${sel} missing`).toBeGreaterThan(-1)
      expect(CSS.slice(at, CSS.indexOf('}', at))).toMatch(/background-image:\s*linear-gradient/)
    }
  })

  it('both themes are covered for the stripe and the hover', () => {
    expect(CSS).toMatch(/\.dark \.frozen-col-striped/)
    expect(CSS).toMatch(/\.dark \.group:hover \.frozen-col/)
  })

  it('reuses palette tints via theme() rather than hand-computed hexes', () => {
    // A hand-composited opaque equivalent stops matching the moment somebody
    // changes a stripe, and nothing would fail.
    const at = CSS.indexOf('.frozen-col-striped')
    expect(CSS.slice(at, CSS.indexOf('}', at))).toMatch(/theme\(colors\./)
  })
})

describe('scope', () => {
  it('mobile does not grow a frozen column', () => {
    // MobileWarRoomView is a card list, not a wide table — it never had this
    // problem and a frozen column there would be meaningless.
    const mobile = readFileSync(new URL('../MobileWarRoomView.jsx', import.meta.url), 'utf8')
    expect(mobile).not.toMatch(/frozen-col/)
  })
})


describe('the lock toggle', () => {
  it('defaults to FROZEN, because that is what shipped and what was asked for', () => {
    // ⚠️ `?? true`. `?? false` would quietly un-freeze the column for everyone
    // on first load after this deploy, which reads as the feature regressing.
    expect(VIEW).toMatch(/persistedState\.nameFrozen \?\? true/)
  })

  it('persists through useViewState, so it survives a reload mid-war', () => {
    // Not a bespoke localStorage key — it rides with the rest of the board's
    // prefs, and must be in the sync effect's dependency array or the last
    // toggle before a refresh is lost.
    const sync = VIEW.slice(VIEW.indexOf('setPersistedState({'))
    expect(sync.slice(0, sync.indexOf('})'))).toMatch(/nameFrozen/)
    expect(VIEW).toMatch(/notesPanelOpen, nameFrozen, setPersistedState\]/)
  })

  it('unfreezing drops the stripe class as well as the sticky one', () => {
    // ⚠️ Keeping `frozen-col-striped` on an unfrozen cell paints an opaque
    // name cell over a translucent row — the exact seam the compositing exists
    // to avoid, with none of the benefit.
    const at = VIEW.indexOf('const frozenCell = nameFrozen')
    expect(at).toBeGreaterThan(-1)
    const block = VIEW.slice(at, at + 220)
    expect(block).toMatch(/frozen-col \$\{idx % 2 === 0 \? '' : 'frozen-col-striped'\}/)
    expect(block).toMatch(/: ''/)   // the unfrozen branch is empty, not partial
  })

  it('⚠️ stops the header sorting when the lock is used, by click AND by key', () => {
    // The whole <th> sorts on click and on Enter/Space. Without both guards,
    // tabbing to the lock and pressing Enter would freeze the column and
    // re-sort the board underneath whoever was reading it.
    const at = VIEW.indexOf('onToggleFrozen && (')
    expect(at).toBeGreaterThan(-1)
    const button = VIEW.slice(at, VIEW.indexOf('</button>', at))
    expect(button).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\)/)
    expect(button).toMatch(/onKeyDown[\s\S]*e\.stopPropagation\(\)/)
  })

  it('announces its state to a screen reader and says what the click does', () => {
    const at = VIEW.indexOf('onToggleFrozen && (')
    const button = VIEW.slice(at, VIEW.indexOf('</button>', at))
    expect(button).toMatch(/aria-pressed=\{frozen\}/)
    expect(button).toMatch(/aria-label=\{frozen \?/)
    // The tooltip names the OUTCOME, not the current state — "click to let it
    // scroll" rather than "frozen", which leaves you guessing what happens.
    expect(button).toMatch(/click to let it scroll/)
    expect(button).toMatch(/click to freeze it/)
  })

  it('shows an open padlock when unfrozen and a closed one when frozen', () => {
    const at = VIEW.indexOf('onToggleFrozen && (')
    expect(VIEW.slice(at, VIEW.indexOf('</button>', at) + 9))
      .toMatch(/frozen \? <Lock [^>]*\/> : <LockOpen /)
    expect(VIEW).toMatch(/import \{[^}]*\bLock\b[^}]*\bLockOpen\b[^}]*\} from 'lucide-react'/)
  })
})
