// @vitest-environment jsdom
//
// #866 — say what the numbers are a rate OF.
//
// Singularity [2573844], on 3.174.0: *"I was just sad to see such low numbers
// till I saw it's out of 30"*.
//
// ⚠️ The arithmetic was never wrong. `perDay = delta / daysCovered` divides by
// the days actually covered, never by the window length, so a short history is
// not diluted. What was wrong is that nothing said the big number was per day.
// These tests are about the LABEL and the coverage signal; a test that asserted
// the division would be testing something that already worked.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { RateCell } from '../MemberOverview'

const fmt = (n) => Math.round(n).toLocaleString()
afterEach(cleanup)

const show = (props) => render(
  <RateCell perDay={80} delta={2400} daysCovered={30} windowDays={30} format={fmt} {...props} />
)

describe('RateCell names its unit', () => {
  it('⚠️ puts /d on the VALUE, not only in a header', () => {
    // The table scrolls horizontally: a header-only label is invisible exactly
    // when the reader is deep in the right-hand columns.
    show()
    expect(screen.getByText('/d')).toBeTruthy()
    expect(screen.getByText('80')).toBeTruthy()
  })

  it('still shows the window total and the days it covers', () => {
    show()
    expect(screen.getByText(/\(2,400 in 30d\)/)).toBeTruthy()
  })

  it('renders an em dash when there is no rate at all', () => {
    show({ perDay: null })
    expect(screen.getByText('—')).toBeTruthy()
  })
})

describe('short coverage is visible on the cell being read', () => {
  it('⚠️ goes amber when the history is shorter than the window', () => {
    // `days_covered` was already honest, but the only SIGNAL was an underline
    // on the far-left name cell — and somebody studying the Xanax column never
    // looks there.
    show({ daysCovered: 12, delta: 960 })
    const bracket = screen.getByText(/\(960 in 12d\)/)
    expect(bracket.className).toMatch(/amber/)
  })

  it('stays grey when the window is fully covered', () => {
    show()
    expect(screen.getByText(/\(2,400 in 30d\)/).className).not.toMatch(/amber/)
  })

  it('stays grey on the All window, which has no length to fall short of', () => {
    show({ windowDays: null, daysCovered: 12, delta: 960 })
    expect(screen.getByText(/\(960 in 12d\)/).className).not.toMatch(/amber/)
  })

  it('⚠️ does not add a tooltip per cell', () => {
    // Thirty hover targets per row is worse than the problem. The full reason
    // stays in the single name-cell tooltip.
    const { container } = show({ daysCovered: 12 })
    expect(container.querySelectorAll('[role="tooltip"]')).toHaveLength(0)
  })
})

describe('the rate ⇄ total toggle', () => {
  it('shows the total as primary and drops the /d suffix', () => {
    show({ showTotals: true })
    expect(screen.getByText('2,400')).toBeTruthy()
    expect(screen.queryByText('/d')).toBeNull()
  })

  it('keeps the rate visible in brackets, still labelled', () => {
    show({ showTotals: true })
    expect(screen.getByText(/\(80\/d over 30d\)/)).toBeTruthy()
  })

  it('⚠️ still says how many days the figure actually covers', () => {
    // The misreading this ticket fixes was about the basis, and switching to
    // totals must not drop it.
    show({ showTotals: true, daysCovered: 12, delta: 960 })
    expect(screen.getByText(/over 12d/)).toBeTruthy()
  })
})
