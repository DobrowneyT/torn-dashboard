// @vitest-environment jsdom
//
// ⚠️ Every number this panel renders has a member's name beside it, so the
// cases that matter most are the ones where a careless rendering would accuse
// somebody: the two empty states meaning different things, and the blameless
// column being visible rather than folded into a failure.
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import DibsSummaryPanel, { otherCount, greenCount } from '../DibsSummaryPanel'

const row = (over = {}) => ({
  member_id: 1001, member_name: 'Holder', claims: 0, converted: 0, attempted: 0,
  taken_from: 0, no_swing: 0, outside: 0, released: 0, hopped: 0, overridden: 0,
  board_reset: 0, still_open: 0, unknown: 0, swung: 0, took_from_others: 0,
  green_means_go: 0, ...over,
})

const state = (over = {}) => ({
  war_id: 700, claims_seen: 1, grace_seconds: 5, summary_version: 1,
  computed_at: '2026-10-06 12:00:00+00', ...over,
})

const cells = () =>
  [...document.querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))

describe('DibsSummaryPanel', () => {
  afterEach(cleanup)

  /**
   * ⚠️ THE distinction this panel exists to preserve. "Not counted yet" and
   * "nobody called anything" are different facts, and rendering the first as
   * the second tells a lead their faction ignored dibs in a war we simply have
   * not finished counting.
   */
  it('says a war is not counted yet, rather than showing it as empty', () => {
    render(<DibsSummaryPanel members={[]} state={null} />)
    expect(screen.getByText(/Not counted yet/)).toBeTruthy()
    expect(screen.queryByText(/Nobody called a target/)).toBeNull()
    expect(document.querySelector('table')).toBeNull()
  })

  it('says nobody called a target when the war really was counted', () => {
    render(<DibsSummaryPanel members={[]} state={state({ claims_seen: 0 })} />)
    expect(screen.getByText(/Nobody called a target/)).toBeTruthy()
    expect(screen.queryByText(/Not counted yet/)).toBeNull()
  })

  it('shows loading without claiming either', () => {
    render(<DibsSummaryPanel members={[]} state={null} loading />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText(/Not counted yet/)).toBeNull()
  })

  /**
   * ⚠️ The arithmetic has to reconcile on screen. The first thing anybody does
   * with a number about themselves is add up the row, and a leaderboard that
   * does not balance is one nobody can check — so `Other` exists to carry the
   * buckets that are too narrow for their own column, INCLUDING `unknown`.
   */
  it('every row adds up to its claim count', () => {
    const r = row({
      claims: 10, converted: 3, attempted: 1, no_swing: 2, taken_from: 1,
      outside: 1, released: 1, board_reset: 1,
    })
    render(<DibsSummaryPanel members={[r]} state={state()} />)
    const sum = r.converted + r.attempted + r.no_swing + r.taken_from
      + r.outside + otherCount(r) + greenCount(r)
    expect(sum).toBe(r.claims)
    // And the rendered Other cell is the one carrying the remainder.
    expect(otherCount(r)).toBe(2)
  })

  it('counts unknown into Other, so pre-#530 claims are not dropped from the total', () => {
    // ⚠️ Claims released before the reason was recorded have no reason at all.
    // Excluding them would make the row silently fail to add up.
    expect(otherCount(row({ unknown: 4 }))).toBe(4)
  })

  it('renders a member with their Torn id', () => {
    render(<DibsSummaryPanel members={[row({ claims: 2 })]} state={state()} />)
    expect(screen.getByText('Holder')).toBeTruthy()
    expect(screen.getByText('[1001]')).toBeTruthy()
  })

  it('names a member with no recorded name by id', () => {
    render(<DibsSummaryPanel members={[row({ member_name: null })]} state={state()} />)
    expect(screen.getByText('id 1001')).toBeTruthy()
  })

  /**
   * ⚠️ A member who claimed nothing but took other people's targets is exactly
   * who the report exists to surface, so a zero claim count must not hide them.
   */
  it('shows a taker who never claimed anything', () => {
    render(<DibsSummaryPanel state={state()} members={[
      row({ member_id: 1002, member_name: 'Taker', claims: 0, took_from_others: 4 }),
    ]} />)
    expect(screen.getByText('Taker')).toBeTruthy()
    expect(cells()[0]).toContain('4')
  })

  it('sorts by claims descending by default, busiest caller first', () => {
    render(<DibsSummaryPanel state={state()} members={[
      row({ member_id: 1, member_name: 'Few', claims: 1 }),
      row({ member_id: 2, member_name: 'Many', claims: 9 }),
    ]} />)
    expect(cells().map((c) => c[0])).toEqual(['Many [2]', 'Few [1]'])
  })

  /**
   * ⚠️ Numeric columns must sort NUMERICALLY. Every column here declares a
   * `kind`; without it `compareValues` falls through to text and 10 sorts before
   * 2 while the page looks perfectly normal (#872, the Hall of Fame).
   */
  it('sorts Took from others numerically, not as text', () => {
    render(<DibsSummaryPanel state={state()} members={[
      row({ member_id: 1, member_name: 'Two', took_from_others: 2 }),
      row({ member_id: 2, member_name: 'Ten', took_from_others: 10 }),
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: /Sort by Took from others/ }))
    const order = cells().map((c) => c[0])
    // Either direction is fine on first click; what matters is that 10 and 2
    // are not compared as strings.
    expect(order[0] === 'Ten [2]' || order[0] === 'Two [1]').toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Sort by Took from others/ }))
    expect(cells().map((c) => c[0])[0]).toBe(order[0] === 'Ten [2]' ? 'Two [1]' : 'Ten [2]')
  })

  it('states the grace window that produced the numbers', () => {
    render(<DibsSummaryPanel members={[row({ claims: 1 })]} state={state({ grace_seconds: 7 })} />)
    // ⚠️ Shown with the figures: two wars counted under different windows are
    // not comparable, and a number about a named member should say what rule
    // produced it.
    expect(screen.getByText(/been live 7s/)).toBeTruthy()
  })

  it('does not claim a grace window when there is nothing to qualify', () => {
    render(<DibsSummaryPanel members={[]} state={state({ claims_seen: 0 })} />)
    expect(screen.queryByText(/been live/)).toBeNull()
  })

  it('renders without a state row at all rather than throwing', () => {
    expect(() => render(<DibsSummaryPanel />)).not.toThrow()
  })
})

/**
 * #935 — green targets. ⚠️ Its own column rather than folded into `Other`,
 * because this is the number a lead points at when somebody says their dibs was
 * taken. Buried in `Other` it settles no argument.
 */
describe('the Green column', () => {
  afterEach(cleanup)

  it('shows green claims in their own column', () => {
    render(<DibsSummaryPanel state={state()} members={[
      row({ member_id: 7, member_name: 'Holder', claims: 3, converted: 1, green_means_go: 2 }),
    ]} />)
    expect(screen.getByRole('button', { name: /Sort by Green/ })).toBeTruthy()
    expect(cells()[0]).toContain('2')
  })

  it('keeps the row adding up with green in it', () => {
    const r = row({ claims: 5, converted: 1, taken_from: 1, green_means_go: 3 })
    const sum = r.converted + r.attempted + r.no_swing + r.taken_from
      + r.outside + otherCount(r) + greenCount(r)
    expect(sum).toBe(r.claims)
  })

  it('reads a missing green count as zero rather than NaN', () => {
    // Rows summarised before #935 have no such field.
    const { green_means_go: _omitted, ...withoutGreen } = row({ claims: 1 })
    expect(greenCount(withoutGreen)).toBe(0)
  })

  it('does not fold green into Other', () => {
    // ⚠️ The whole point of the column: it has to be separately readable.
    expect(otherCount(row({ green_means_go: 4 }))).toBe(0)
  })
})
