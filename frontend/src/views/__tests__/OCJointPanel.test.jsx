// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { JointPanel } from '../OCJointPanel'

afterEach(cleanup)

const plan = (over = {}) => ({
  chosen: {
    Alpha: { vector: { P1: 88, P2: 86, P3: 84, P4: 82 }, crews: 3 },
    Beta: { vector: { P1: 95, P2: 94, P3: 93, P4: 92 }, crews: 1 },
  },
  concessions: {
    Alpha: { stepsDown: 4, pointsGivenUp: 39, crewsGained: 4, fromVector: {} },
    Beta: { stepsDown: 0, pointsGivenUp: 0, crewsGained: 0, fromVector: {} },
  },
  skipped: { Gamma: 'no-readings' },
  score: 462943,
  simulation: { days: 30, filled: 15, spawned: 60, scope: { solvent: false, shortfallPerDay: 1.4 } },
  ...over,
})

describe('JointPanel', () => {
  it('renders without throwing', () => {
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(screen.getByText(/Joint plan/)).toBeTruthy()
  })

  it('⚠️ shows what each crime gave up, and for what', () => {
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(screen.getByText(/39 pts → \+4 crews/)).toBeTruthy()
    expect(screen.getByText(/kept its ceiling/)).toBeTruthy()
  })

  it('⚠️ says a skipped crime was never observed, not that it is impossible', () => {
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(screen.getByText(/not a verdict/)).toBeTruthy()
  })

  it('reports the simulated fill rate and the scope shortfall as an action', () => {
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(screen.getByText(/15 of 60/)).toBeTruthy()
    expect(document.body.textContent).toMatch(/cover it with cheaper spawns/)
  })

  it('⚠️ says whether the spawn mix was MEASURED or assumed', () => {
    // A plan built on a guess that reads like a measurement is the worse of the
    // two, so the panel has to say which it had.
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(document.body.textContent).toMatch(/an even one is assumed/)
    cleanup()
    render(<JointPanel plan={plan({
      spawnMix: { measured: true, windowDays: 30, spawnsPerDay: 2.4, weightByName: { A: 0.6, B: 0.4 } },
    })} crimeCount={3} />)
    expect(document.body.textContent).toMatch(/2\.4 decisions a day across 2 crimes/)
    expect(document.body.textContent).toMatch(/consequences, not choices/)
  })

  it('⚠️ explains a chain child skipped from the plan', () => {
    render(<JointPanel plan={plan({ skipped: { Beta: 'chain-child' } })} crimeCount={3} />)
    expect(document.body.textContent).toMatch(/not a spawn decision/)
  })

  it('still states the occupancy caveat', () => {
    render(<JointPanel plan={plan()} crimeCount={3} />)
    expect(document.body.textContent).toMatch(/overstates\s+occupancy/)
  })

  it('⚠️ warns that the per-crime numbers are a ceiling, before it is run', () => {
    render(<JointPanel plan={null} onSolve={vi.fn()} crimeCount={3} />)
    expect(document.body.textContent).toMatch(/as if it had the whole roster to itself/)
    expect(screen.getByRole('button').textContent).toMatch(/Solve together/)
  })

  it('shows a busy state rather than looking idle', () => {
    render(<JointPanel plan={null} onSolve={vi.fn()} crimeCount={3} solving />)
    const b = screen.getByRole('button')
    expect(b.getAttribute('aria-busy')).toBe('true')
    expect(b.querySelector('.animate-spin')).toBeTruthy()
  })

  it('says plainly when nothing could be solved', () => {
    render(<JointPanel plan={plan({ chosen: {}, concessions: {} })} crimeCount={1} />)
    expect(screen.getByText(/None of the selected crimes/)).toBeTruthy()
  })
})
