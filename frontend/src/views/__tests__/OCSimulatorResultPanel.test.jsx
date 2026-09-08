// @vitest-environment jsdom
//
// ⚠️ THIS FILE EXISTS BECAUSE v3.97.0 SHIPPED A CRASH.
//
// The endings-list work grew a chain of useMemos — endingProbabilities →
// collapsed → goodProbabilities → endings — and one of them named `collapsed`
// from ABOVE its own declaration. A useMemo dependency array is evaluated
// immediately, not deferred with the callback, so that is a temporal-dead-zone
// throw on every render: "Cannot access 'o' before initialization" after
// minification, and the whole OC Simulator page replaced by an error boundary.
//
// Every pure helper involved had tests. Not one of them mounted the component,
// so nothing caught it. These do — the assertions matter less than the render.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ResultPanel } from '../OCSimulatorView'

afterEach(cleanup)

// Blast from the Past's real shape: two aliased labels folded onto goodEnding3,
// which is the case the crashing code path exists to handle.
const SCENARIO = {
  name: 'Blast from the Past',
  parameter_count: 6,
  endings: [
    { ending_key: 'goodEnding1', kind: 'good', resolved: true, starved: false, alias_of: null,
      money_avg: 172408913, money_min: 158585000, money_max: 215676000, observations: 5000 },
    { ending_key: 'goodEnding3', kind: 'good', resolved: true, starved: false, alias_of: null,
      money_avg: 123437699, money_min: 112798000, money_max: 172584000, observations: 4000 },
    { ending_key: 'goodEnding35', kind: 'good', resolved: true, starved: false, alias_of: 'goodEnding3',
      money_avg: 123437699, money_min: 112798000, money_max: 172584000, observations: 4000 },
    { ending_key: 'goodEnding310', kind: 'good', resolved: true, starved: false, alias_of: 'goodEnding3',
      money_avg: 123437699, money_min: 112798000, money_max: 172584000, observations: 4000 },
    { ending_key: 'badEnding1', kind: 'bad', resolved: true, starved: false, alias_of: null,
      money_avg: 0, observations: 100 },
  ],
}

const RESULT = {
  successChance: 0.7984,
  failureChance: 0.2016,
  goodEnding1: 0.42105,
  goodEnding3: 0.10526,
  goodEnding35: 0.06316,
  goodEnding310: 0.00936,
  badEnding1: 0.01562,
  // The service's zero padding, which must not appear as rows.
  goodEnding9: 0,
  badEnding9: 0,
}

describe('OC Simulator result panel', () => {
  it('⚠️ renders with a result at all — the regression that took the page down', () => {
    expect(() => render(<ResultPanel scenario={SCENARIO} result={RESULT} />)).not.toThrow()
    expect(screen.getByText('Endings by likelihood')).toBeTruthy()
  })

  it('folds the alias labels away and keeps their probability', () => {
    render(<ResultPanel scenario={SCENARIO} result={RESULT} />)
    // The alias rows are gone...
    expect(screen.queryByText('goodEnding35')).toBeNull()
    expect(screen.queryByText('goodEnding310')).toBeNull()
    // ...and goodEnding3 carries all three: 10.526 + 6.316 + 0.936 = 17.778.
    expect(screen.getByText('17.778%')).toBeTruthy()
    expect(screen.getByText('goodEnding3')).toBeTruthy()
  })

  it('drops the service’s zero padding', () => {
    render(<ResultPanel scenario={SCENARIO} result={RESULT} />)
    expect(screen.queryByText('goodEnding9')).toBeNull()
    expect(screen.queryByText('badEnding9')).toBeNull()
  })

  it('renders the other states without throwing', () => {
    // Each is a separate branch of the same component, and any of them could
    // carry the next crash of this kind.
    expect(() => render(<ResultPanel scenario={SCENARIO} result={null} />)).not.toThrow()
    cleanup()
    expect(() => render(<ResultPanel scenario={SCENARIO} result={null} calculating />)).not.toThrow()
    cleanup()
    expect(() => render(<ResultPanel scenario={SCENARIO} result={null} error="nope" />)).not.toThrow()
  })

  it('renders an items-paying scenario without throwing', () => {
    const items = {
      name: 'Window of Opportunity',
      parameter_count: 5,
      endings: [{
        ending_key: 'goodEnding1', kind: 'good', resolved: true, starved: false, alias_of: null,
        money_avg: 0, item_value_avg: 98460178, item_value_min: 39384071, item_value_max: 206766374,
        observations: 781, item_value_unmatched: ['Mystery Box'],
        item_drops: [{ name: 'Priceless Painting', dropRate: 1, qty: { min: 1, avg: 1, max: 1 }, unitPrice: 12000000, contribution: 12000000 }],
      }],
    }
    expect(() => render(
      <ResultPanel scenario={items} result={{ successChance: 0.8, failureChance: 0.2, goodEnding1: 0.8 }} />
    )).not.toThrow()
    expect(screen.getByText('in items')).toBeTruthy()
  })
})
