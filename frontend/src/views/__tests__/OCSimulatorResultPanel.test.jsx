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

// #712 — a chain link is not "unpriced".
//
// ⚠️ Stacking the Deck showed "4 endings unpriced, covering 38.23%... the real
// value is higher by an unknown amount". That reads as a data problem and sends
// somebody hunting a number that does not exist. The crime pays nothing because
// every good ending spawns Ace in the Hole — which is what the crime IS
// (#585: 124/124 successful runs spawned a child; Ace has 0 standalone runs).
describe('ResultPanel — chained crimes', () => {
  const CHAINED = {
    name: 'Stacking the Deck',
    parameter_count: 4,
    endings: [
      { ending_key: 'goodEnding1', kind: 'good', resolved: true, node_id: 'A', money_avg: null, reward: { money: null, chainsTo: 'Ace in the Hole' } },
      { ending_key: 'goodEnding2', kind: 'good', resolved: true, node_id: 'B', money_avg: null, reward: { money: null, chainsTo: 'Ace in the Hole' } },
      { ending_key: 'badEnding1', kind: 'bad', resolved: true, node_id: 'F' },
    ],
    roles: [],
  }
  const RESULT = { successChance: 0.38, failureChance: 0.62, goodEnding1: 0.25, goodEnding2: 0.13, badEnding1: 0.62 }

  it('⚠️ names the crime it spawns instead of saying "unpriced"', () => {
    render(<ResultPanel scenario={CHAINED} result={RESULT} calculating={false} error={null} />)
    expect(screen.getAllByText(/Ace in the Hole/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/unpriced, covering/i)).toBeNull()
  })

  it('⚠️ does not tell the reader the value is unknown — it is known, elsewhere', () => {
    render(<ResultPanel scenario={CHAINED} result={RESULT} calculating={false} error={null} />)
    expect(screen.queryByText(/higher by an unknown amount/i)).toBeNull()
    expect(screen.getByText(/judge the pair together/i)).toBeTruthy()
  })

  it('⚠️ still warns about a genuinely unmeasured ending alongside a chain', () => {
    // The distinction has to survive a mixed crime, or the chain message would
    // quietly swallow a real measurement gap.
    const mixed = {
      ...CHAINED,
      endings: [
        ...CHAINED.endings,
        { ending_key: 'goodEnding3', kind: 'good', resolved: true, node_id: 'C', money_avg: null, reward: { money: null, chainsTo: null } },
      ],
    }
    render(<ResultPanel scenario={mixed} result={{ ...RESULT, goodEnding3: 0.05 }} calculating={false} error={null} />)
    expect(screen.getByText(/unpriced, covering/i)).toBeTruthy()
  })
})

// #602 — $ per person-day, the figure that makes two crimes comparable.
describe('per person-day', () => {
  it('shows it beside E(x), with the crime\'s role count', () => {
    render(<ResultPanel scenario={SCENARIO} result={RESULT} />)
    const line = screen.getByText(/per person-day/)
    expect(line).toBeTruthy()
    // 6 roles -> personDays(6, 0.5) = 21 + 2.5 = 23.5
    expect(line.textContent).toMatch(/6 roles hold 23\.5 person-days/)
  })

  it('⚠️ is absent, not zero, when the crime reports no cash', () => {
    // A chain root's own E(x) is zero by design, and several crimes pay only in
    // items. "$0 per person-day" reads as worthless rather than unpriced (#351).
    const noCash = {
      ...SCENARIO,
      endings: SCENARIO.endings.map((e) => ({ ...e, money_avg: 0, money_min: 0, money_max: 0 })),
    }
    render(<ResultPanel scenario={noCash} result={RESULT} />)
    expect(screen.queryByText(/per person-day/)).toBeNull()
  })
})
