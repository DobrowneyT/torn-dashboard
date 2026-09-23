// @vitest-environment jsdom
//
// Chain Watch, on screen (#772).
//
// The cases here are the ones the spreadsheet got wrong by hand or could not
// do at all: the DST fold in the local-time column, coverage that survives a
// day being appended, and a race on the last graveyard slot reading as news
// rather than as a failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor, fireEvent } from '@testing-library/react'

const api = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(),
}))
vi.mock('../../../utils/apiClient', () => ({
  apiGet: (...a) => api.get(...a),
  apiPost: (...a) => api.post(...a),
  apiPut: (...a) => api.put(...a),
  apiDelete: (...a) => api.del(...a),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: '9200' }, isVisitor: false }),
}))

// ⚠️ Node resolves the zone at startup, so setting process.env.TZ inside a
// test never reaches `Intl.DateTimeFormat().resolvedOptions()`. Override the
// one seam the page reads it through.
const zoneRef = vi.hoisted(() => ({ value: null }))
vi.mock('../../../utils/chainWatch', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, viewerZone: () => zoneRef.value ?? mod.viewerZone() }
})

import ChainWatchSection from '../ChainWatchSection'

const EVENT = {
  id: 7,
  title: 'Halloween 100k',
  starts_at: '2027-10-26T10:00:00+00',
  ends_at: '2027-10-28T10:00:00+00',
  slots_per_hour: 2,
  bonus_hours: [5, 6],
  bonus_multiplier: 2,
  bonus_applies_to: 'tickets',
  status: 'open',
}
// ⚠️ Postgres' own text shape, bare offset and all — the #140 trap, which is
// exactly what this endpoint serves.
const SERVER_NOW = '2027-10-26T14:20:00+00'
const sign = (hour, slot, id, name) => ({
  hour_start: `${hour}+00`, slot_index: slot, member_id: id, member_name: name,
})

function mockApi({ event = EVENT, signups = [], server_now = SERVER_NOW, members = [] } = {}) {
  api.get.mockImplementation(async (path) => {
    if (path === '/api/chain-events') return { events: [event] }
    if (path.startsWith('/api/chain-events/')) return { event, signups, server_now }
    if (path === '/api/members') return { members }
    throw new Error(`unexpected GET ${path}`)
  })
}

beforeEach(() => { vi.clearAllMocks(); mockApi() })
afterEach(cleanup)

const draw = (props = {}) => render(<ChainWatchSection isLeadership={false} {...props} />)
const hour = (iso) => screen.getByTestId(`hour-${iso}`)

describe('the grid', () => {
  it('shows the hours ahead and hides the ones that have run', async () => {
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    // 10:00-13:00 have elapsed against the SERVER's 14:20 and are on History.
    expect(screen.queryByTestId('hour-2027-10-26T11:00:00.000Z')).toBeNull()
  })

  it('⚠️ takes "elapsed" from the server clock, not the browser', async () => {
    // A viewer whose machine is a day fast would otherwise be shown an empty
    // grid, or be offered claims on hours that have gone.
    vi.setSystemTime(new Date('2027-10-27T14:20:00Z'))
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    vi.useRealTimers()
  })

  it('renders slots_per_hour cells, not two by habit', async () => {
    mockApi({ event: { ...EVENT, slots_per_hour: 3 } })
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(within(hour('2027-10-26T15:00:00.000Z')).getAllByText('Sign up')).toHaveLength(3)
  })

  it('⚠️ names the bold time as TCT on every row, not only in a heading', async () => {
    // Without the unit the bold line reads as "some timezone", and the obvious
    // guess is the reader's own — which is the grey line underneath it.
    zoneRef.value = 'America/New_York'
    try {
      draw()
      await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
      const cell = within(hour('2027-10-26T15:00:00.000Z')).getByText('15:00').parentElement
      expect(cell.textContent).toMatch(/15:00\s*TCT/)
      // and the viewer's own clock stays unlabelled-as-TCT on its own line
      expect(within(hour('2027-10-26T15:00:00.000Z')).getByText(/New York/).textContent)
        .toMatch(/^11:00/)
    } finally { zoneRef.value = null }
  })

  it('⚠️ renders a DST fold as two rows with the same local clock time', async () => {
    // The exact thing the sheet got wrong: the 2025 event crossed the US change
    // and rows 100-101 of the workbook list "2:00-3:00" twice, patched by hand.
    // TCT never folds, so the two rows are distinct instants that legitimately
    // print the same local time.
    zoneRef.value = 'America/New_York'
    try {
      mockApi({
        event: { ...EVENT, starts_at: '2027-11-07T04:00:00+00', ends_at: '2027-11-07T08:00:00+00' },
        server_now: '2027-11-07T03:00:00+00',
      })
      draw()
      await waitFor(() => expect(screen.getByTestId('hour-2027-11-07T05:00:00.000Z')).toBeTruthy())
      const first = within(hour('2027-11-07T05:00:00.000Z')).getByText(/New York/).textContent
      const second = within(hour('2027-11-07T06:00:00.000Z')).getByText(/New York/).textContent
      expect(first).toMatch(/^01:00/)
      expect(second).toMatch(/^01:00/)   // correct, and must not be collapsed
    } finally { zoneRef.value = null }
  })

  it('marks a bonus hour with what the bonus actually pays', async () => {
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-27T05:00:00.000Z')).toBeTruthy())
    expect(within(hour('2027-10-27T05:00:00.000Z')).getByText('×2')).toBeTruthy()
    expect(within(hour('2027-10-27T04:00:00.000Z')).queryByText('×2')).toBeNull()
  })
})

describe('the six-hour warning', () => {
  it('⚠️ counts slots and names the hours with nobody at all', async () => {
    mockApi({ signups: [sign('2027-10-26T15:00:00', 0, '9300', 'Two')] })
    draw()
    const alert = await screen.findByTestId('gap-alert')
    expect(alert.textContent).toMatch(/slots unfilled in the next 6 hours/)
    expect(alert.textContent).toMatch(/15:00,/)           // one of two: no marker
    expect(alert.textContent).toMatch(/16:00 \(both\)/)   // nobody at all
  })

  it('says nothing when the next six hours are covered', async () => {
    mockApi({
      event: { ...EVENT, slots_per_hour: 1 },
      signups: Array.from({ length: 7 }, (_, i) =>
        sign(`2027-10-26T${String(14 + i).padStart(2, '0')}:00:00`, 0, '9300', 'Two')),
    })
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(screen.queryByTestId('gap-alert')).toBeNull()
  })
})

describe('claiming', () => {
  it('claims the slot for the signed-in member', async () => {
    api.post.mockResolvedValue({})
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    fireEvent.click(screen.getByTestId('claim-2027-10-26T15:00:00.000Z-0'))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/chain-events/7/signups',
      { hour_start: '2027-10-26T15:00:00.000Z', slot_index: 0 }))
  })

  it('⚠️ a lost race reads as news, not as a failure', async () => {
    // Two people going for the last graveyard slot is the normal case.
    const err = new Error('That slot was just taken')
    err.status = 409
    api.post.mockRejectedValue(err)
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    fireEvent.click(screen.getByTestId('claim-2027-10-26T15:00:00.000Z-0'))
    expect(await screen.findByText(/just taken/i)).toBeTruthy()
    // …and the grid is re-read rather than left showing a slot that is gone.
    await waitFor(() => expect(api.get.mock.calls.filter((c) => c[0] === '/api/chain-events/7').length)
      .toBeGreaterThan(1))
  })

  it('⚠️ offers a drop on your own upcoming slot but not once it has started', async () => {
    mockApi({ signups: [
      sign('2027-10-26T15:00:00', 0, '9200', 'Me'),
      sign('2027-10-26T14:00:00', 0, '9200', 'Me'),   // the hour in progress
    ] })
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(within(hour('2027-10-26T15:00:00.000Z')).getByLabelText(/drop your slot/i)).toBeTruthy()
    expect(within(hour('2027-10-26T14:00:00.000Z')).queryByLabelText(/drop your slot/i)).toBeNull()
  })

  it('never offers a drop on somebody else’s slot', async () => {
    mockApi({ signups: [sign('2027-10-26T15:00:00', 0, '9300', 'Two')] })
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(within(hour('2027-10-26T15:00:00.000Z')).queryByLabelText(/remove/i)).toBeNull()
  })
})

describe('leadership', () => {
  const lead = () => draw({ isLeadership: true })

  it('⚠️ adding a day extends the grid and leaves existing claims alone', async () => {
    mockApi({ signups: [sign('2027-10-26T15:00:00', 0, '9300', 'Two')] })
    lead()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(screen.queryByTestId('hour-2027-10-28T20:00:00.000Z')).toBeNull()

    api.post.mockResolvedValue({})
    mockApi({
      event: { ...EVENT, ends_at: '2027-10-29T10:00:00+00' },
      signups: [sign('2027-10-26T15:00:00', 0, '9300', 'Two')],
    })
    fireEvent.click(screen.getByTestId('add-day'))

    await waitFor(() => expect(screen.getByTestId('hour-2027-10-28T20:00:00.000Z')).toBeTruthy())
    expect(within(hour('2027-10-26T15:00:00.000Z')).getByText('Two')).toBeTruthy()
    expect(api.post).toHaveBeenCalledWith('/api/chain-events/7/days', {})
  })

  it('⚠️ the headline does not worsen when a day is appended', async () => {
    // A fresh day is 24 hours of nothing. If the header leapt, it would read as
    // the roster collapsing at the very moment the window grew.
    // ⚠️ The event must already run past the 48h horizon, or the count
    // legitimately rises: those hours did not exist to staff before. That is
    // the window growing, not coverage collapsing (see chainWatch.test.js).
    const LONG = { ...EVENT, ends_at: '2027-10-30T10:00:00+00' }
    mockApi({ event: LONG, signups: [] })
    lead()
    await waitFor(() => expect(screen.getByTestId('next-gap')).toBeTruthy())
    const before = screen.getByTestId('next-gap').textContent
    const openBefore = screen.getByTestId('open-ahead').textContent

    api.post.mockResolvedValue({})
    mockApi({ event: { ...LONG, ends_at: '2027-10-31T10:00:00+00' }, signups: [] })
    fireEvent.click(screen.getByTestId('add-day'))

    await waitFor(() => expect(screen.getByTestId('hour-2027-10-30T20:00:00.000Z')).toBeTruthy())
    expect(screen.getByTestId('next-gap').textContent).toBe(before)
    expect(screen.getByTestId('open-ahead').textContent).toBe(openBefore)
  })

  it('⚠️ a refused trim names who is still on the last day', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const err = new Error('The last day still has watchers on it')
    err.status = 409
    err.body = { error: err.message, held: [
      { hour_start: '2027-10-27T22:00:00+00', member_id: '9300', member_name: 'Watcher Two' },
      { hour_start: '2027-10-27T23:00:00+00', member_id: '9300', member_name: 'Watcher Two' },
    ] }
    api.del.mockRejectedValue(err)
    lead()
    await waitFor(() => expect(screen.getByTestId('remove-day')).toBeTruthy())
    fireEvent.click(screen.getByTestId('remove-day'))
    const msg = await screen.findByText(/still claimed on the last day/i)
    expect(msg.textContent).toMatch(/Watcher Two/)
    expect(msg.textContent).toMatch(/2 slots/)
  })

  it('shows the day controls to leadership and hides them from a member', async () => {
    lead()
    await waitFor(() => expect(screen.getByTestId('add-day')).toBeTruthy())
    cleanup()
    draw()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    expect(screen.queryByTestId('add-day')).toBeNull()
  })

  it('⚠️ the picker keeps the other slot’s holder, disabled with the reason', async () => {
    mockApi({
      signups: [sign('2027-10-26T15:00:00', 0, '9300', 'Watcher Two')],
      members: [{ member_id: '9300', member_name: 'Watcher Two' },
                { member_id: '9400', member_name: 'Watcher Three' }],
    })
    lead()
    await waitFor(() => expect(screen.getByTestId('hour-2027-10-26T15:00:00.000Z')).toBeTruthy())
    fireEvent.click(within(hour('2027-10-26T15:00:00.000Z'))
      .getByLabelText(/assign someone to 15:00 TCT slot 2/i))

    const dialog = await screen.findByRole('dialog')
    // Present, and disabled with the reason — dropping them entirely makes a
    // leader hunting for the name conclude the picker is broken.
    const taken = within(dialog).getByRole('button', { name: /Watcher Two/ })
    expect(taken.disabled).toBe(true)
    expect(within(dialog).getByText(/already watching this hour/i)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /Watcher Three/ }).disabled).toBe(false)
  })
})

describe('when there is nothing to show', () => {
  const noEvent = () => api.get.mockImplementation(async (p) =>
    p === '/api/chain-events' ? { events: [] } : { members: [] })

  it('says so rather than rendering an empty grid', async () => {
    noEvent()
    draw()
    expect(await screen.findByText(/no chain watch is open yet/i)).toBeTruthy()
  })

  it('offers leadership a way out of the empty state, and a member none', async () => {
    // ⚠️ Without this the page is a dead end: the grid says there is no event
    // and the only way to make one is a POST from a terminal.
    noEvent()
    draw({ isLeadership: true })
    expect(await screen.findByTestId('open-new-event')).toBeTruthy()
    cleanup()
    noEvent()
    draw()
    await screen.findByText(/no chain watch is open yet/i)
    expect(screen.queryByTestId('open-new-event')).toBeNull()
  })

  it('⚠️ creates from a number of DAYS and a TCT start, not an end date', async () => {
    // The window grows a day at a time as the chain proves it has legs. The
    // 2025 sheet was generated to a guessed end and the chain outran it.
    noEvent()
    api.post.mockResolvedValue({ id: 9 })
    draw({ isLeadership: true })
    fireEvent.click(await screen.findByTestId('open-new-event'))

    fireEvent.change(screen.getByLabelText(/starts \(TCT\)/i), { target: { value: '2027-10-25T10:00' } })
    fireEvent.change(screen.getByLabelText(/^days$/i), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('create-event'))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/chain-events',
      expect.objectContaining({
        starts_at: '2027-10-25T10:00:00.000Z',   // the hour typed, read as TCT
        days: 3,
        bonus_hours: [5, 6],
      })))
    // ⚠️ No end date is sent at all — the server derives it, keeping the hour.
    expect(api.post.mock.calls[0][1].ends_at).toBeUndefined()
  })

  it('⚠️ echoes the TCT start back in the viewer\'s own time', async () => {
    // TCT is canonical, but a leader in Winnipeg typing 10:00 should see what
    // that means locally before opening a fortnight of sign-ups on it.
    noEvent()
    draw({ isLeadership: true })
    fireEvent.click(await screen.findByTestId('open-new-event'))
    fireEvent.change(screen.getByLabelText(/starts \(TCT\)/i), { target: { value: '2027-10-25T10:00' } })
    const echo = screen.getByTestId('start-echo').textContent
    expect(echo).toMatch(/your time/)
    expect(echo).toContain(new Date(Date.parse('2027-10-25T10:00:00Z')).toLocaleString())
  })
})
