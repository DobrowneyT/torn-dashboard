// @vitest-environment jsdom
//
// The event Report tab (#971).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../utils/apiClient', () => ({ apiGet: (...a) => api.get(...a) }))

import EventReport, { Respect, VERSION_POLL_MS } from '../EventReport'

const EVENT = { id: 1, name: 'Halloween', theme_color: '#f97316', phase: 'live',
  starts_at: Date.UTC(2026, 9, 25, 10), daily_from: Date.UTC(2026, 9, 26) }

const REPORT = {
  chain: {
    chain_id: 5, start: 0, end: null, as_of: Date.UTC(2026, 9, 26, 12),
    totals: { chain: 1200, hits: 1210, respect: { raw: 5000, capped: 4690, deduction: 310 }, members: 2,
      targets: 900, best: 320, leave: 100, mug: 800, hospitalize: 300, assists: 10, retaliations: 4,
      overseas: 2, draws: 0, escapes: 1, losses: 3, war: 0, bonuses: 6 },
    bonuses: [{ chain: 100, attacker_id: 1, attacker: 'Alice', defender_id: 9, respect: 320 }],
    members: [
      { id: 1, name: 'Alice', respect: { total: 4000, average: 4, best: 320, capped: 3690, deduction: 310 },
        attacks: { total: 1000, mug: 700, hospitalize: 200, leave: 100, assists: 0, retaliations: 1, overseas: 0, losses: 0, escapes: 0 }, bonus_hits: 1 },
      { id: 2, name: 'Bob', respect: { total: 1000, average: 4.76, best: 9, capped: 1000, deduction: 0 },
        attacks: { total: 210, mug: 100, hospitalize: 100, leave: 0, assists: 10, retaliations: 3, overseas: 2, losses: 3, escapes: 1 }, bonus_hits: 0 },
    ],
    non_attackers: [{ id: 3, name: 'Cara' }],
  },
  daily: [
    { day: '2026-10-26', starts_at: Date.UTC(2026, 9, 26), totals: { hits: 500, respect: 2000, mug: 300, assists: 4, retaliations: 7, incoming: 20 },
      members: [{ id: 1, name: 'Alice', hits: 400, respect: 1600, mug: 250, hospitalize: 100, leave: 50, assists: 0, losses: 0, incoming: 12, defended: 2 }] },
    { day: '2026-10-27', starts_at: Date.UTC(2026, 9, 27), totals: { hits: 710, respect: 3000, mug: 500, assists: 6, incoming: 9 },
      members: [{ id: 2, name: 'Bob', hits: 210, respect: 1000, mug: 100, hospitalize: 100, leave: 0, assists: 10, losses: 3, incoming: 9, defended: 1 }] },
  ],
  targets: {
    members: [{ id: 2, name: 'Bob', outgoing: 210, distinct_targets: 80, incoming: 21, beaten: 18, defended: 3, distinct_attackers: 7 }],
    most_targeted: [{ id: 2, name: 'Bob', incoming: 21 }],
    most_active: [{ id: 1, name: 'Alice', outgoing: 1000 }],
    our_top_targets: [{ id: 50, name: 'Punchbag', hits: 44, by_members: 9 }],
    top_attackers_on_us: [{ id: 999, name: 'Grudger', hits: 12, on_members: 3 }],
    factions_we_hit: [{ id: 700, name: 'Alpha', attacks: 44, wins: 40, members: 9, respect_gained: 120.5 }],
    factions_hit_us: [
      { id: 800, kind: 'faction', name: 'Beta', attacks: 30, beaten: 20, defended: 10, members: 5, respect_lost: 12.25 },
      { id: null, kind: 'stealthed', name: 'Stealthed', attacks: 4, beaten: 4, defended: 0, members: 2, respect_lost: 3 },
    ],
  },
  highlights: {
    logs_parsed: 1300, total_mugged: 4_500_000, total_damage: 2_000_000,
    highest_mugs: [{ id: 1, name: 'Alice', amount: 1_791_890, target: 'Richie', at: 0 }],
    biggest_hits: [{ id: 2, name: 'Bob', damage: 3710, outgoing: true, opponent: 'Tank', at: 0 }],
    most_effects: [{ id: 1, name: 'Alice', total: 14, effects: { powerful: 9, stricken: 5 } }],
    effect_totals: { powerful: 9, stricken: 5 },
    bounties: { claimed: 3, total: 2_100_010, by_member: [{ id: 2, name: 'Bob', claims: 2, total: 2_000_010 }], top: [{ id: 2, name: 'Bob', amount: 2_000_000, target: 'Fiveseven', at: 0 }] },
    effects_by_day: [{ day: '2026-10-26', starts_at: Date.UTC(2026, 9, 26), effects: { powerful: 9, stricken: 5 } }],
  },
}

let version
beforeEach(() => {
  version = 'v1'
  api.get.mockReset()
  api.get.mockImplementation(async (path) => (path.endsWith('/version') ? { version } : REPORT))
})
const reportFetches = () => api.get.mock.calls.filter(([p]) => p === '/api/events/1/report').length
afterEach(cleanup)

describe('Respect', () => {
  it('⚠️ names the deduction when bonus hits were capped', () => {
    render(<Respect raw={5000} capped={4690} deduction={310} />)
    expect(screen.getByText(/4,690\.00 capped \(−310\.00 bonus\)/)).toBeTruthy()
  })
  it('shows raw alone when nothing was capped', () => {
    render(<Respect raw={50} capped={50} deduction={0} />)
    expect(screen.queryByText(/capped/)).toBeNull()
  })
})

describe('EventReport', () => {
  it('⚠️ opens on Members, with Totals second', async () => {
    render(<EventReport event={EVENT} />)
    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((t) => t.textContent).slice(0, 2)).toEqual(['Members', 'Totals'])
    expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true')
    expect(api.get).toHaveBeenCalledWith('/api/events/1/report')
  })

  it('shows Torn\'s totals on the second view', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Totals' }))
    expect(screen.getByText('1,200')).toBeTruthy()
    expect(screen.getByText(/4,690\.00 capped/)).toBeTruthy()
  })

  it('⚠️ numbers members by their place in the CURRENT sort', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    const firstRow = () => screen.getAllByRole('row')[1]
    // Default: hits, descending — Alice (1,000) first.
    expect(within(firstRow()).getAllByRole('cell').slice(0, 2).map((c) => c.textContent)).toEqual(['1', 'Alice'])
    // Sort by Retals: Bob has 3, Alice 1.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Retals' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Retals' }))
    const order = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').slice(0, 2).map((c) => c.textContent).join(' '))
    expect(order[0]).toMatch(/^1 /)
    expect(order).toContain('2 Alice')
  })

  it('lists members and who has not hit yet', async () => {
    render(<EventReport event={EVENT} />)
    expect(await screen.findByText('Alice')).toBeTruthy()
    expect(screen.getByText('Not hit yet (1)')).toBeTruthy()
    expect(screen.getByText('Cara')).toBeTruthy()
  })

  it('shows the latest day first, and any other day on request', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Daily' }))
    expect(screen.getByText('Bob')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '26 Oct' }))
    expect(screen.getByText('Alice')).toBeTruthy()
  })

  it('shows who was targeted most, both ways', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    const card = screen.getByText('Most targeted members').closest('div')
    expect(within(card).getByText('Bob')).toBeTruthy()
    expect(screen.getByText('Grudger')).toBeTruthy()
    expect(screen.getByText('Punchbag')).toBeTruthy()
  })

  it('explains an empty report before the chain starts', async () => {
    api.get.mockImplementation(async (path) => (path.endsWith('/version') ? { version } : { ...REPORT, chain: null }))
    render(<EventReport event={{ ...EVENT, phase: 'upcoming' }} />)
    await screen.findByRole('tab', { name: 'Totals' })
    fireEvent.click(screen.getByRole('tab', { name: 'Totals' }))
    expect(await screen.findByText(/starts collecting when the event opens/)).toBeTruthy()
  })
})

describe('live updates (#972)', () => {
  afterEach(() => vi.useRealTimers())

  it('refetches the report when the version moves, and only then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    expect(reportFetches()).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS) })
    expect(reportFetches()).toBe(1)

    version = 'v2'
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS) })
    expect(reportFetches()).toBe(2)
  })
})

describe('highlights (#974)', () => {
  it('shows the highest mug, biggest hit and effects by name', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Highlights' }))
    expect(screen.getByText('$1,791,890 from Richie')).toBeTruthy()
    expect(screen.getByText('3,710 on Tank')).toBeTruthy()
    expect(screen.getAllByText(/Stricken/).length).toBeGreaterThan(0)
    expect(screen.getByText('$2,000,000 on Fiveseven')).toBeTruthy()
    expect(screen.getByText('$2,100,010')).toBeTruthy()
    expect(screen.getByText('$2,000,010 · 2 claims')).toBeTruthy()
  })

  it('explains an empty archive', async () => {
    api.get.mockImplementation(async (path) => (path.endsWith('/version') ? { version } : { ...REPORT, highlights: null }))
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Highlights' }))
    expect(screen.getByText(/appear once attack logs have been archived/)).toBeTruthy()
  })
})

describe('faction targets (#987)', () => {
  it('ranks the factions both ways, with respect, keeping Stealthed as a row', async () => {
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText(/40 won · 9 of ours · \+120\.50 respect/)).toBeTruthy()
    expect(screen.getByText(/20 beat us · 10 defended · 5 of ours hit · −12\.25 respect/)).toBeTruthy()
    expect(screen.getByText('Stealthed')).toBeTruthy()
  })

  it('leaves out a zero respect figure', async () => {
    api.get.mockImplementation(async (path) => (path.endsWith('/version') ? { version } : { ...REPORT, targets: { ...REPORT.targets,
      factions_hit_us: [{ id: null, kind: 'none', name: 'No faction', attacks: 228, beaten: 2, defended: 226, members: 6, respect_lost: 0 }] } }))
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice')
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    expect(screen.getByText('2 beat us · 226 defended · 6 of ours hit')).toBeTruthy()
  })
})
