// @vitest-environment jsdom
//
// ⚠️ The break-even is the reason this panel exists. Scope is paid once at the
// root and repaid only at the terminal link, only if every link succeeded, so
// the reward stays flat while the probability of collecting it compounds.
// Elaborate is 83.3% standalone but 91.3% PER LINK over two — and the
// standalone scope verdict elsewhere on the page is the wrong number for a
// chain. Without this panel a reader has no way to know that.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ChainPanel } from '../OCChainPanel'

afterEach(cleanup)

const chain = (over = {}) => ({
  links: [{ name: 'Stacking the Deck' }, { name: 'Ace in the Hole' }],
  confident: true,
  chainedSuccess: 0.81,
  value: { expected: 364_500_000, complete: true },
  scope: {
    links: 2, cost: 5, reward: 6, chainedSuccess: 0.81,
    breakEvenPerLink: Math.sqrt(5 / 6), equivalentSuccess: 0.9,
    net: 0.81 * 6 - 5, sustainable: false,
  },
  assumedCpr: 75,
  missing: [],
  ...over,
})

describe('ChainPanel', () => {
  it('renders without throwing', () => {
    render(<ChainPanel chain={chain()} rootName="Stacking the Deck" />)
    expect(screen.getByText(/Stacking the Deck → Ace in the Hole/)).toBeTruthy()
  })

  it('⚠️ shows the PER-LINK break-even against the standalone one', () => {
    render(<ChainPanel chain={chain()} rootName="Stacking the Deck" />)
    const text = document.body.textContent
    expect(text).toMatch(/91\.3%/)     // (5/6)^(1/2), the bar that actually applies
    expect(text).toMatch(/83\.3%/)     // what a standalone crime needs, for contrast
  })

  it('⚠️ compares the EQUIVALENT per-link success, not the chained probability', () => {
    // Comparing 81% against a 91.3% per-link bar is the natural mistake and it
    // makes every chain look doomed.
    render(<ChainPanel chain={chain()} rootName="Stacking the Deck" />)
    expect(document.body.textContent).toMatch(/averages 90\.0% per link/)
  })

  it('values the whole chain, not the root on its own', () => {
    render(<ChainPanel chain={chain()} rootName="Stacking the Deck" />)
    expect(document.body.textContent).toMatch(/completing 81\.0% of the time/)
  })

  it('⚠️ marks an incompletely priced chain as a floor', () => {
    render(<ChainPanel chain={chain({ value: { expected: 1000, complete: false } })} rootName="X" />)
    expect(document.body.textContent).toMatch(/at least/)
  })

  it('⚠️ states the crew assumption, because it cannot be carried downstream', () => {
    render(<ChainPanel chain={chain()} rootName="Stacking the Deck" />)
    expect(screen.getByText(/flat 75 CPR/)).toBeTruthy()
  })

  it('⚠️ warns when this faction has not observed the links itself', () => {
    render(<ChainPanel chain={chain({ confident: false })} rootName="X" />)
    expect(screen.getByText(/unverified here/i)).toBeTruthy()
  })

  it('says what it could not price rather than showing a number anyway', () => {
    render(<ChainPanel chain={chain({ missing: ['Ace in the Hole'], scope: null, value: null })} rootName="X" />)
    expect(screen.getByText(/could not be priced/i)).toBeTruthy()
  })

  it('offers the computation on demand — each link is a probability call', () => {
    render(<ChainPanel chain={null} onCompute={vi.fn()} rootName="X" />)
    expect(screen.getByRole('button').textContent).toMatch(/Value this chain/)
  })
})
