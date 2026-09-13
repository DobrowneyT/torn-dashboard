// @vitest-environment jsdom
//
// ⚠️ The render is the point, not the assertions — same reason
// `OCSimulatorResultPanel.test.jsx` exists. v3.97.0 shipped a `useMemo` whose
// dependency array named a `const` from above its own declaration: a
// temporal-dead-zone throw on every render that replaced the whole OC Simulator
// with an error boundary, for every user on every browser. Every pure helper
// involved had tests; none mounted the component.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { GuidancePanel } from '../OCGuidancePanel'

afterEach(cleanup)

const guidance = (over = {}) => ({
  scenarioName: 'Blast from the Past',
  publishable: true,
  generatedAt: '2026-09-12T00:00:00.000Z',
  roles: [
    { positionId: 'P1', roleName: 'Muscle', weight: 34.6, isCarry: false, published: 92, floor: 92, expected: 93.5, ceiling: 95, eligible: 8, eligibleOneHigher: 4, cliff: 4, readings: 91, nearMisses: [{ member_id: 'm9', cpr: 91, pointsNeeded: 1 }] },
    { positionId: 'P4', roleName: 'Picklock 2', weight: 2.9, isCarry: true, published: 0, floor: 86, expected: 89, ceiling: 92, eligible: 12, eligibleOneHigher: 11, cliff: 1, readings: 91, nearMisses: [] },
  ],
  value: { floor: 100_000_000, expected: 130_000_000, uplift: 0.3 },
  assumptions: ['Join gap of 12h between members — assumed, not measured (#687).'],
  reason: null,
  ...over,
})

describe('GuidancePanel', () => {
  it('renders without throwing', () => {
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.getByText(/Picklock 2/)).toBeTruthy()
  })

  it('⚠️ shows 0 for a carry role, and the bar the model used beside it', () => {
    render(<GuidancePanel guidance={guidance()} />)
    const cells = [...screen.getByText(/Picklock 2/).closest('tr').querySelectorAll('td')]
        .map((td) => td.textContent.trim())
    // Publish column is 0; the bar the model scored at stays visible next to it,
    // or the table cannot be audited.
    expect(cells[2]).toBe('0')
    expect(cells[3]).toBe('86')
  })

  it('⚠️ labels the carry so nobody reads the 0 as a mistake', () => {
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.getByText(/no training needed/i)).toBeTruthy()
  })

  it('shows the expected crew alongside the published floor', () => {
    render(<GuidancePanel guidance={guidance()} />)
    const row = screen.getByText(/Muscle/).closest('tr')
    expect(row.textContent).toMatch(/92/)
    expect(row.textContent).toMatch(/93\.5/)
  })

  it('⚠️ flags a threshold sitting on a cliff', () => {
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.getByText(/8 → 4/)).toBeTruthy()
  })

  it('renders its assumptions rather than hiding them', () => {
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.getByText(/assumed, not measured/i)).toBeTruthy()
  })

  it('⚠️ says why a crime is unpublishable, distinguishing the reasons', () => {
    render(<GuidancePanel guidance={guidance({ publishable: false, roles: [] })} reason="no-readings" limitingRoles={['P3']} />)
    expect(screen.getByText(/never observed/i)).toBeTruthy()
    cleanup()
    render(<GuidancePanel guidance={guidance({ publishable: false, roles: [] })} reason="not-crewable" />)
    expect(screen.getByText(/nobody clears/i)).toBeTruthy()
  })

  it('renders an idle state before anything has been computed', () => {
    render(<GuidancePanel guidance={null} onCompute={vi.fn()} />)
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('⚠️ survives a guidance object with fields missing', () => {
    // Absent must render, not crash — the whole point of reporting absence.
    render(<GuidancePanel guidance={guidance({ value: { floor: null, expected: null, uplift: null }, assumptions: [] })} />)
    expect(screen.getByText(/Muscle/)).toBeTruthy()
  })
})

// ⚠️ v3.107.0 locked the browser for 44 seconds with the button still looking
// idle. The blocking work is fixed (57x faster) but it is still ~0.8s of
// synchronous matching, so the busy state has to be real and visible.
describe('GuidancePanel — busy state', () => {
  it('shows a spinner and marks the button busy while working', () => {
    render(<GuidancePanel guidance={null} onCompute={vi.fn()} computing />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.disabled).toBe(true)
    expect(button.querySelector('.animate-spin')).toBeTruthy()
  })

  it('⚠️ dims a stale table while recomputing, so it is not read as fresh', () => {
    render(<GuidancePanel guidance={guidance()} onCompute={vi.fn()} computing />)
    expect(document.querySelector('.overflow-x-auto').className).toMatch(/opacity-40/)
  })

  it('⚠️ explains a chain crime by name rather than calling it unpriced', () => {
    render(
      <GuidancePanel guidance={guidance({ publishable: false, roles: [] })}
        reason="chains" chainsTo="Ace in the Hole" />
    )
    // Named twice on purpose — "spawns X instead", then "set thresholds on X".
    expect(screen.getAllByText(/Ace in the Hole/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/unpriced/i)).toBeNull()
  })

  it('⚠️ warns that the numbers are one crime at a time', () => {
    // The single most important caveat: every threshold assumes this crime has
    // first claim on the whole roster, and every other crime wants the same
    // people. Buried in a footnote it would be read as publishable.
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.getByText(/One crime at a time/i)).toBeTruthy()
  })
})

// ⚠️ #713 — a chain root's thresholds are for ITS crew, but the value behind
// them is the whole chain's. Without saying so the figure reads as this crime's
// own payout, which is zero.
describe('GuidancePanel — a chain root', () => {
  it('says the value is the chain\'s, and the thresholds are this crew\'s', () => {
    render(<GuidancePanel guidance={guidance()} chainOf="Ace in the Hole" />)
    expect(screen.getByText(/Valued at the whole chain/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/this is the crime people join/)
  })

  it('says nothing about chains on an ordinary crime', () => {
    render(<GuidancePanel guidance={guidance()} />)
    expect(screen.queryByText(/Valued at the whole chain/)).toBeNull()
  })
})
