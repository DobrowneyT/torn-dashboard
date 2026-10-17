// @vitest-environment jsdom
//
// Faction event page and its wiring (#969): the event tab, the members
// redirect for Chain Watch, and the leadership form's TCT handling.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))
vi.mock('../../utils/apiClient', () => ({
  apiGet: (...a) => api.get(...a),
  apiPost: (...a) => api.post(...a),
  apiPatch: (...a) => api.patch(...a),
}))
// Chain Watch has its own suite; here it only has to be where it should be.
vi.mock('../../components/chainWatch/ChainWatchSection', () => ({
  default: () => <div>chain-watch-section</div>,
}))
vi.mock('../MembersView', () => ({ default: () => <div>members-overview</div> }))

import EventsPage from '../EventsPage'
import MembersPage from '../MembersPage'
import Navigation from '../../components/Navigation'

const EVENT = {
  id: 1, name: 'Halloween', theme_color: '#f97316',
  starts_at: Date.UTC(2026, 9, 25, 10), daily_from: Date.UTC(2026, 9, 26),
  min_ends_at: Date.UTC(2026, 10, 1, 16), ends_with_chain: true,
  chain_event_id: null, ended_at: null, phase: 'live',
}

function Where() { return <div data-testid="where">{useLocation().pathname}</div> }

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); api.patch.mockReset()
  api.get.mockResolvedValue({ events: [] })
})
afterEach(cleanup)

describe('Navigation event tab', () => {
  const nav = (event) => render(<MemoryRouter><Navigation isLeadership={false} event={event} /></MemoryRouter>)

  it('shows the event, by name, while it is live or upcoming', () => {
    nav(EVENT)
    expect(screen.getAllByText('Halloween').length).toBeGreaterThan(0)
  })

  it('hides it with no event', () => {
    nav(null)
    expect(screen.queryByText('Halloween')).toBeNull()
  })

  it('⚠️ the Dashboard tab points at /dashboard, not `/`', () => {
    nav(null)
    expect(screen.getAllByText('Dashboard')[0].closest('a').getAttribute('href')).toBe('/dashboard')
  })
})

describe('Chain Watch moved to the event page', () => {
  it('⚠️ /members/chain-watch redirects to /events/chain-watch (bot link, old bookmarks)', () => {
    render(
      <MemoryRouter initialEntries={['/members/chain-watch']}>
        <Routes>
          <Route path="/members/*" element={<MembersPage isLeadership={false} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('where').textContent).toBe('/events/chain-watch')
  })

  it('is no longer a Members tab', () => {
    render(<MemoryRouter initialEntries={['/members/overview']}><Routes><Route path="/members/*" element={<MembersPage isLeadership={false} />} /></Routes></MemoryRouter>)
    expect(screen.queryByText('Chain Watch')).toBeNull()
  })
})

describe('EventsPage', () => {
  const page = (event, path = '/events', isLeadership = false) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/events/*" element={<EventsPage event={event} isLeadership={isLeadership} onChanged={vi.fn()} />} /></Routes>
    </MemoryRouter>,
  )

  it('⚠️ still serves Chain Watch with no event — sign-ups open before it starts', () => {
    page(null)
    expect(screen.getByText('chain-watch-section')).toBeTruthy()
  })

  it('shows the event header in TCT', () => {
    page(EVENT)
    expect(screen.getByText(/Opens 25 Oct 10:00 TCT/)).toBeTruthy()
    expect(screen.getByText('Live')).toBeTruthy()
  })

  it('keeps Settings from members', () => {
    page(EVENT, '/events/settings')
    expect(screen.queryByText('Settings')).toBeNull()
  })

  it('⚠️ leadership schedules with times read as TCT, not local time', async () => {
    api.post.mockResolvedValue({ id: 2 })
    page(null, '/events/settings', true)
    fireEvent.click(screen.getByText('Schedule event'))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const [path, body] = api.post.mock.calls[0]
    expect(path).toBe('/api/events')
    const d = new Date(body.starts_at)
    expect([d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()]).toEqual([9, 25, 10])
    expect(body.ends_with_chain).toBe(true)
  })

  it('edits the scheduled event with PATCH', async () => {
    api.patch.mockResolvedValue({ id: 1 })
    page(EVENT, '/events/settings', true)
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.patch).toHaveBeenCalled())
    expect(api.patch.mock.calls[0][0]).toBe('/api/events/1')
    expect(api.patch.mock.calls[0][1].min_ends_at).toBe(EVENT.min_ends_at)
  })
})
