// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InfoTooltip, { tooltipPosition } from '../InfoTooltip'

// The placement maths is the half worth pinning hardest: it is what makes the
// panel readable on a 320px phone and what stops a row near the foot of a long
// table opening a panel below the fold.
describe('tooltipPosition', () => {
  const wide = { w: 1200, h: 800 }

  it('sits just under the trigger', () => {
    const pos = tooltipPosition({ left: 40, top: 100, bottom: 120 }, wide, { w: 340, h: 90 })
    expect(pos).toMatchObject({ left: 40, top: 126, placement: 'below' })
  })

  it('pulls a right-hand trigger back so the panel stays on screen', () => {
    const pos = tooltipPosition({ left: 1150, top: 100, bottom: 120 }, wide, { w: 340, h: 90 })
    expect(pos.left).toBe(1200 - 340 - 8)
  })

  it('⚠️ narrows the panel rather than overflowing a phone', () => {
    // 320px cannot hold 340 plus margins. Off the right edge of a table that
    // already scrolls horizontally is somewhere a reader will not find it.
    const pos = tooltipPosition({ left: 10, top: 100, bottom: 120 }, { w: 320, h: 700 }, { w: 340, h: 90 })
    expect(pos.width).toBe(320 - 8 * 2)
    expect(pos.left).toBe(8)
  })

  it('⚠️ flips above when there is no room below', () => {
    // The last row of a long job list is near the bottom of the viewport, which
    // is exactly where the default placement would put the text off-screen.
    const pos = tooltipPosition({ left: 40, top: 700, bottom: 720 }, wide, { w: 340, h: 200 })
    expect(pos.placement).toBe('above')
    expect(pos.top).toBe(700 - 6 - 200)
  })

  it('takes the roomier side when the panel fits on neither, and never goes off the top', () => {
    // A panel taller than the viewport cannot be shown whole either way, so the
    // choice is which end gets cut. The clamp is the part that matters: without
    // it the panel would start at a negative offset and lose its first lines
    // with no way to scroll back to them.
    const pos = tooltipPosition({ left: 40, top: 300, bottom: 320 }, { w: 1200, h: 400 }, { w: 340, h: 600 })
    expect(pos.placement).toBe('above')
    expect(pos.top).toBe(8)
  })

  it('does not flip on the first pass, before the panel has a height', () => {
    // Height is 0 until something renders; flipping on that would jump the
    // panel on screen between the two placement passes.
    const pos = tooltipPosition({ left: 40, top: 700, bottom: 720 }, wide, { w: 340, h: 0 })
    expect(pos.placement).toBe('below')
  })
})

describe('InfoTooltip', () => {
  it('⚠️ opens on a click, which is the whole point on a touchscreen', () => {
    // A touchscreen has no hover, so the group-hover pattern this replaces left
    // the content unreachable on mobile — as did the native `title` before it.
    render(<InfoTooltip label="crimes-sync">What this job does.</InfoTooltip>)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'crimes-sync' }))
    expect(screen.getByRole('tooltip').textContent).toContain('What this job does.')
  })

  it('closes again on a second press', () => {
    render(<InfoTooltip label="crimes-sync">Body</InfoTooltip>)
    const trigger = screen.getByRole('button', { name: 'crimes-sync' })
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens on hover for a pointer', () => {
    render(<InfoTooltip label="crimes-sync">Body</InfoTooltip>)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'crimes-sync' }))
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('⚠️ closes on an outside press, so a tapped-open panel is never stuck', () => {
    render(<InfoTooltip label="crimes-sync">Body</InfoTooltip>)
    fireEvent.click(screen.getByRole('button', { name: 'crimes-sync' }))
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('closes on Escape', () => {
    render(<InfoTooltip label="crimes-sync">Body</InfoTooltip>)
    fireEvent.click(screen.getByRole('button', { name: 'crimes-sync' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('renders the label alone when there is nothing to describe', () => {
    render(<InfoTooltip label="unknown-job">{null}</InfoTooltip>)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('unknown-job')).toBeTruthy()
  })

  it('points screen readers at the panel only while it is open', () => {
    render(<InfoTooltip label="crimes-sync">Body</InfoTooltip>)
    const trigger = screen.getByRole('button', { name: 'crimes-sync' })
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
  })
})
