// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import MemberPicker, { memberMarker } from '../MemberPicker'
import { ACTIVITY } from '../../../utils/warOverviewMembers'

const member = (over) => ({
  id: 1, name: 'Someone', outgoing: 0, incoming: 0, revivesIn: 0, revivesOut: 0,
  events: 0, onRoster: true, activity: ACTIVITY.none, ...over,
})

const fought = (over) => member({ outgoing: 4, events: 4, activity: ACTIVITY.fought, ...over })
const medic  = (over) => member({ revivesOut: 6, events: 6, activity: ACTIVITY.revivedOnly, ...over })

const options = () =>
  [...document.querySelectorAll('option')].map(o => o.textContent)

const optionFor = (id) => document.querySelector(`option[value="${id}"]`)

describe('MemberPicker', () => {
  afterEach(cleanup)

  it('offers a member who did nothing', () => {
    render(<MemberPicker members={[member({ id: 7, name: 'Idle' })]} onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: 'Idle [7] — no events' })).toBeTruthy()
  })

  /**
   * ⚠️ ONE list, interleaved. The first version grouped them, and grouping
   * costs the only thing an alphabetical dropdown is good for — jumping
   * straight to a name without first deciding which half it is in.
   */
  it('interleaves quiet members alphabetically rather than grouping them', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      fought({ id: 1, name: 'Alice' }),
      member({ id: 2, name: 'Bob' }),
      fought({ id: 3, name: 'Carol' }),
    ]} />)
    expect(document.querySelectorAll('optgroup')).toHaveLength(0)
    expect(options()).toEqual([
      '— pick a member —',
      'Alice [1]',
      'Bob [2] — no events',
      'Carol [3]',
    ])
  })

  it('greys a member with nothing to plot', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      fought({ id: 1, name: 'Fighter' }),
      member({ id: 7, name: 'Idle' }),
    ]} />)
    expect(optionFor(7).className).toContain('text-gray-400')
    expect(optionFor(1).className).toBe('')
  })

  /**
   * ⚠️ A revives-only member is greyed too: no panel plots revives performed,
   * so their three charts are exactly as empty as an idle member's.
   */
  it('greys a revives-only member, and says which kind of quiet it is', () => {
    render(<MemberPicker onSelect={() => {}} members={[medic({ id: 9, name: 'Medic' })]} />)
    expect(optionFor(9).className).toContain('text-gray-400')
    expect(screen.getByRole('option', { name: 'Medic [9] — revives only' })).toBeTruthy()
  })

  it('leaves a member who fought unmarked and ungreyed', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      fought({ id: 1, name: 'Fighter', revivesOut: 2, events: 6 }),
    ]} />)
    expect(screen.getByRole('option', { name: 'Fighter [1]' })).toBeTruthy()
    expect(optionFor(1).className).toBe('')
  })

  /**
   * ⚠️ The colour cannot carry this alone — native select menus on macOS Safari
   * and on mobile ignore `option { color }` entirely.
   */
  it('marks every quiet member in text, not only in colour', () => {
    for (const activity of [ACTIVITY.none, ACTIVITY.revivedOnly]) {
      expect(memberMarker(activity)).not.toBe('')
    }
    expect(memberMarker(ACTIVITY.fought)).toBe('')
  })

  it('explains the grey when there is any', () => {
    render(<MemberPicker onSelect={() => {}} members={[member({ id: 7, name: 'Idle' })]} />)
    expect(screen.getByText(/Greyed names have nothing to plot/)).toBeTruthy()
  })

  it('says nothing about grey when every member fought', () => {
    render(<MemberPicker onSelect={() => {}} members={[fought({ id: 1, name: 'Fighter' })]} />)
    expect(screen.queryByText(/Greyed names/)).toBeNull()
  })

  it('reports the picked member as a number', () => {
    const onSelect = vi.fn()
    render(<MemberPicker onSelect={onSelect} members={[member({ id: 7, name: 'Idle' })]} />)
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: '7' } })
    // ⚠️ A number: every downstream comparison is `=== selectedMemberId`
    // against numeric ids, and a string would match nothing silently.
    expect(onSelect).toHaveBeenCalledWith(7)
  })

  it('clears the selection back to null', () => {
    const onSelect = vi.fn()
    render(
      <MemberPicker onSelect={onSelect} selectedId={7}
        members={[member({ id: 7, name: 'Idle' })]} />
    )
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: '' } })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('renders with no members at all', () => {
    render(<MemberPicker onSelect={() => {}} />)
    expect(options()).toEqual(['— pick a member —'])
    expect(screen.queryByText(/Greyed names/)).toBeNull()
  })
})
