// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import MemberPicker from '../MemberPicker'
import { ACTIVITY } from '../../../utils/warOverviewMembers'

const member = (over) => ({
  id: 1, name: 'Someone', outgoing: 0, incoming: 0, revivesIn: 0, revivesOut: 0,
  events: 0, onRoster: true, activity: ACTIVITY.none, ...over,
})

const groupLabels = () =>
  [...document.querySelectorAll('optgroup')].map(g => g.getAttribute('label'))

describe('MemberPicker', () => {
  afterEach(cleanup)

  it('offers a member who did nothing, under a group that says so', () => {
    render(<MemberPicker members={[member({ id: 7, name: 'Idle' })]} onSelect={() => {}} />)
    expect(screen.getByRole('option', { name: 'Idle [7]' })).toBeTruthy()
    // ⚠️ The label carries the caveat: this comes from today's roster, so the
    // claim is about the war data, not about where they were at the time.
    expect(groupLabels()).toEqual(['No events in this war'])
  })

  it('separates members with events from members without', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      member({ id: 1, name: 'Fighter', outgoing: 4, events: 4, activity: ACTIVITY.fought }),
      member({ id: 7, name: 'Idle' }),
    ]} />)
    expect(groupLabels()).toEqual(['In the war data', 'No events in this war'])
  })

  it('marks a revives-only member, because no panel plots what they did', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      member({ id: 9, name: 'Medic', revivesOut: 6, events: 6, activity: ACTIVITY.revivedOnly }),
    ]} />)
    expect(screen.getByRole('option', { name: 'Medic [9] — revives only' })).toBeTruthy()
  })

  it('does not mark a member who actually fought', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      member({ id: 1, name: 'Fighter', outgoing: 4, revivesOut: 2, events: 6, activity: ACTIVITY.fought }),
    ]} />)
    expect(screen.getByRole('option', { name: 'Fighter [1]' })).toBeTruthy()
  })

  it('renders no empty group when every member has events', () => {
    render(<MemberPicker onSelect={() => {}} members={[
      member({ id: 1, name: 'Fighter', outgoing: 4, events: 4, activity: ACTIVITY.fought }),
    ]} />)
    expect(groupLabels()).toEqual(['In the war data'])
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
    expect(screen.getByRole('option', { name: '— pick a member —' })).toBeTruthy()
    expect(groupLabels()).toEqual([])
  })
})
