// @vitest-environment jsdom
//
// The event report (#971, #972, #974, #987 and the 2026-10-18 review).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../utils/apiClient', () => ({ apiGet: (...a) => api.get(...a) }))

import EventReport, { Respect, VERSION_POLL_MS, rangeQuery } from '../EventReport'
import { tornLabel } from '../TornLink'

const EVENT = { id: 1, name: 'Halloween', theme_color: '#f97316', phase: 'live',
  starts_at: Date.UTC(2026, 9, 25, 10), daily_from: Date.UTC(2026, 9, 26) }
const D1 = Date.UTC(2026, 9, 26)
const D2 = Date.UTC(2026, 9, 27)

const REPORT = {
  server_now: 1,
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
    { day: '2026-10-26', starts_at: D1, totals: {}, members: [] },
    { day: '2026-10-27', starts_at: D2, totals: {}, members: [] },
  ],
  targets: {
    members: [{ id: 2, name: 'Bob', outgoing: 210, distinct_targets: 80, incoming: 21, beaten: 18, defended: 3, distinct_attackers: 7 }],
    most_targeted: [{ id: 2, name: 'Bob', incoming: 21 }],
    most_active: [{ id: 1, name: 'Alice', outgoing: 1000 }],
    our_top_targets: [{ id: 50, name: 'Punchbag', hits: 44, by_members: 9 }],
    top_attackers_on_us: [{ id: 999, name: 'Grudger', hits: 12, on_members: 3 }],
    factions_we_hit: Array.from({ length: 14 }, (_, i) => ({ id: 700 + i, name: `Fac${i}`, attacks: 44 - i, wins: 40 - i, members: 9, respect_gained: i === 0 ? 120.5 : 0 })),
    factions_hit_us: [{ id: 800, kind: 'faction', name: 'Beta', attacks: 30, beaten: 20, defended: 10, members: 5, respect_lost: 12.25 }],
  },
}

const HIGHLIGHTS = {
  logs_parsed: 1300, total_mugged: 4_500_000, total_damage: 2_000_000,
  highest_mugs: [{ id: 1, name: 'Alice', amount: 1_791_890, target_id: 77, target: 'Richie', at: 0 }],
  biggest_hits: [{ id: 2, name: 'Bob', damage: 3710, outgoing: true, opponent_id: 78, opponent: 'Tank', at: 0 }],
  bounties: { claimed: 3, total: 2_100_010, by_member: [{ id: 2, name: 'Bob', claims: 2, total: 2_000_010 }],
    top: [{ id: 2, name: 'Bob', amount: 2_000_000, target_id: 79, target: 'Fiveseven', at: 0 }] },
  tracked: [
    { key: 'revitalize', label: 'Revitalize', total: 5, by_member: [{ id: 1, name: 'Alice', count: 4 }, { id: 2, name: 'Bob', count: 1 }] },
    { key: 'treats', label: 'Treats', total: 0, by_member: [] },
  ],
  loot: { drops: 2, by_member: [{ id: 1, name: 'Alice', drops: 2, items: { Jawbreaker: 1, 'Pixie Sticks': 1 } }],
    by_item: [{ item: 'Jawbreaker', qty: 1 }, { item: 'Pixie Sticks', qty: 1 }], by_source: [{ from: 'Jimmy', drops: 2 }] },
  effect_totals: { powerful: 9, stricken: 5 },
}
const STATS = (over = {}) => ({
  from: EVENT.starts_at, to: D2 + 3_600_000, server_now: 1,
  totals: { hits: 500, respect: 2000, mug: 300, assists: 4, retaliations: 7, incoming: 20 },
  members: [{ id: 1, name: 'Alice', hits: 400, respect: 1600, mug: 250, hospitalize: 100, leave: 50, assists: 0, losses: 0, retaliations: 2, incoming: 12, defended: 2 }],
  highlights: HIGHLIGHTS, ...over,
})

let version
let stats
beforeEach(() => {
  version = 'v1'
  stats = STATS()
  api.get.mockReset()
  api.get.mockImplementation(async (path) => {
    if (path.endsWith('/version')) return { version }
    if (path.includes('/stats')) return typeof stats === 'function' ? stats(path) : stats
    return REPORT
  })
})
afterEach(cleanup)
const reportFetches = () => api.get.mock.calls.filter(([p]) => p === '/api/events/1/report').length
const open = async (tab) => {
  render(<EventReport event={EVENT} />)
  await screen.findByText('Alice [1]')
  if (tab) fireEvent.click(screen.getByRole('tab', { name: tab }))
}

describe('names', () => {
  it('⚠️ read "name [id]" and link to the Torn profile', async () => {
    await open()
    const a = screen.getByText('Alice [1]').closest('a')
    expect(a.getAttribute('href')).toBe('https://www.torn.com/profiles.php?XID=1')
    expect(a.getAttribute('target')).toBe('_blank')
  })
  it('shows just the id when the name is unknown', () => {
    expect(tornLabel(5, '#5')).toBe('[5]')
    expect(tornLabel(5, null)).toBe('[5]')
    expect(tornLabel(null, 'Someone')).toBe('Someone')
  })
})

describe('Respect', () => {
  it('⚠️ names the deduction when bonus hits were capped', () => {
    render(<Respect raw={5000} capped={4690} deduction={310} />)
    expect(screen.getByText(/4,690\.00 capped \(−310\.00 bonus\)/)).toBeTruthy()
  })
})

describe('views', () => {
  it('⚠️ opens on Members; Totals, Stats, Targets follow', async () => {
    await open()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Members', 'Totals', 'Stats', 'Targets'])
    expect(screen.getByText('Not hit yet (1)')).toBeTruthy()
    expect(screen.getByText('Cara [3]')).toBeTruthy()
  })

  it('shows Torn\'s totals, with the bonus hitter linked', async () => {
    await open('Totals')
    expect(screen.getByText('1,200')).toBeTruthy()
    expect(screen.getAllByText('Alice [1]').length).toBeGreaterThan(0)
  })

  it('⚠️ numbers members by their place in the CURRENT sort', async () => {
    await open()
    const first = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell').slice(0, 2).map((c) => c.textContent)
    expect(first()).toEqual(['1', 'Alice [1]'])
  })
})

describe('Stats (Daily + Highlights merged)', () => {
  it('⚠️ starts on Overall, and a day asks for exactly that day', async () => {
    await open('Stats')
    await screen.findByText('Revitalize (5)')
    expect(api.get).toHaveBeenCalledWith('/api/events/1/stats')
    fireEvent.click(screen.getByRole('button', { name: '27 Oct' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/events/1/stats?from=${D2}&to=${D2 + 86_400_000}`))
  })

  it('takes a custom range of whole TCT days, inclusive', async () => {
    await open('Stats')
    await screen.findByText('Revitalize (5)')
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From (TCT)'), { target: { value: '2026-10-26' } })
    fireEvent.change(screen.getByLabelText('To (TCT, inclusive)'), { target: { value: '2026-10-27' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/events/1/stats?from=${D1}&to=${D2 + 86_400_000}`))
  })

  it('⚠️ leads with the Revitalize and treat leaderboards, explaining an empty one', async () => {
    await open('Stats')
    expect(await screen.findByText('Revitalize (5)')).toBeTruthy()
    expect(screen.getByText('Treats')).toBeTruthy()
    expect(screen.getByText(/No treat seen in a log yet/)).toBeTruthy()
  })

  it('shows loot, bounties, mugs and hits with the other side linked', async () => {
    await open('Stats')
    await screen.findByText('Revitalize (5)')
    expect(screen.getByText('Loot by item')).toBeTruthy()
    expect(screen.getByText(/From: Jimmy \(2\)/)).toBeTruthy()
    expect(screen.getByText('$2,000,010 · 2 claims')).toBeTruthy()
    expect(screen.getByText('Richie [77]').closest('a').getAttribute('href')).toContain('XID=77')
    expect(screen.getByText('Tank [78]')).toBeTruthy()
  })

  it('keeps every other effect folded away, for spotting new ones', async () => {
    await open('Stats')
    await screen.findByText('Revitalize (5)')
    expect(screen.getByText('All effects seen (2)')).toBeTruthy()
  })

  it('explains a range with nothing archived yet', async () => {
    stats = STATS({ highlights: null })
    await open('Stats')
    expect(await screen.findByText(/Highlights appear once attack logs/)).toBeTruthy()
  })

  it('rangeQuery', () => {
    expect(rangeQuery({ kind: 'overall' })).toBe('')
    expect(rangeQuery({ kind: 'day', from: 1, to: 2 })).toBe('?from=1&to=2')
  })
})

describe('Targets', () => {
  it('⚠️ lists every faction linked, in a scrolling box', async () => {
    await open('Targets')
    expect(screen.getByText('Factions we hit most')).toBeTruthy()
    const link = screen.getByText('Fac13 [713]').closest('a')
    expect(link.getAttribute('href')).toBe('https://www.torn.com/factions.php?step=profile&ID=713')
    expect(link.closest('ol').className).toMatch(/overflow-y-auto/)
    expect(screen.getByText(/20 beat us · 10 defended · 5 of ours hit · −12\.25 respect/)).toBeTruthy()
  })

  it('leaves out a zero respect figure', async () => {
    await open('Targets')
    expect(screen.getByText('39 won · 9 of ours')).toBeTruthy()
  })

  it('links the people in the ranked lists', async () => {
    await open('Targets')
    expect(screen.getByText('Grudger [999]')).toBeTruthy()
    expect(screen.getByText('Punchbag [50]')).toBeTruthy()
  })
})

describe('live updates (#972)', () => {
  afterEach(() => vi.useRealTimers())

  it('refetches the report when the version moves, and only then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<EventReport event={EVENT} />)
    await screen.findByText('Alice [1]')
    expect(reportFetches()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS) })
    expect(reportFetches()).toBe(1)
    version = 'v2'
    await act(async () => { await vi.advanceTimersByTimeAsync(VERSION_POLL_MS) })
    expect(reportFetches()).toBe(2)
  })
})
