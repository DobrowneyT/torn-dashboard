// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ObservedPanel } from '../OCObservedPanel'

afterEach(cleanup)

const observed = (over = {}) => ({
  runs: 180, successes: 140, rate: 140 / 180, enough: true, window_days: 240,
  buckets: [
    { lo: 62, hi: 70, meanCpr: 66, runs: 120, successes: 90, rate: 0.75 },
    { lo: 70, hi: 80, meanCpr: 75, runs: 60, successes: 50, rate: 0.8333 },
  ],
  roles: [
    { position: 'Picklock', runs: 360, spread: 25, delta: 2.2, informative: true, reason: 'ok' },
    { position: 'Muscle', runs: 180, spread: 3, delta: null, informative: false, reason: 'narrow-range' },
  ],
  ...over,
})

describe('ObservedPanel', () => {
  it('renders without throwing', () => {
    render(<ObservedPanel observed={observed()} predicted={0.8} crewCpr={75} />)
    expect(screen.getByText(/Our own history/)).toBeTruthy()
  })

  it('flags a material disagreement with the model', () => {
    render(<ObservedPanel observed={observed()} predicted={0.95} crewCpr={75} />)
    expect(screen.getByText(/model and our history disagree/i)).toBeTruthy()
    expect(screen.getByText(/optimistic/)).toBeTruthy()
  })

  it('⚠️ says a narrow-range role tells us nothing, not that it does not matter', () => {
    render(<ObservedPanel observed={observed()} predicted={0.8} crewCpr={75} />)
    expect(screen.getByText(/says nothing about how much it matters/i)).toBeTruthy()
    expect(screen.getByText(/No read on/)).toBeTruthy()
  })

  it('⚠️ distinguishes "not run enough" from a bad crime', () => {
    render(<ObservedPanel observed={observed({ enough: false, runs: 3, buckets: [] })} />)
    expect(screen.getByText(/too few to say anything/i)).toBeTruthy()
    expect(screen.queryByText(/disagree/i)).toBeNull()
  })

  it('says so when we have never run it at all', () => {
    render(<ObservedPanel observed={observed({ enough: false, runs: 0, buckets: [] })} />)
    expect(screen.getByText(/has not run this crime/i)).toBeTruthy()
  })

  it('renders nothing without data', () => {
    const { container } = render(<ObservedPanel observed={null} />)
    expect(container.firstChild).toBeNull()
  })
})
