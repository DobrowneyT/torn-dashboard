// @vitest-environment jsdom
//
// The event report (#971, #972, #974, #987 and the 2026-10-18 review).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }))
vi.mock('../../../utils/apiClient', () => ({
  apiGet: (...a) => api.get(...a), apiPost: (...a) => api.post(...a), apiDelete: (...a) => api.del(...a),
}))

import EventReport, { Respect, VERSION_POLL_MS, rangeQuery, tctDateTimeMs } from '../EventReport'
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
  loot: { drops: 2, by_member: [{ id: 1, name: 'Alice', drops: 2, items: { Jawbreaker: 1, 'Pixie Sticks': 3 },
    detail: [{ item: 'Jawbreaker', qty: 1, from: 'Jimmy', from_id: 19, at: 0 }, { item: 'Pixie Sticks', qty: 3, from: 'Jimmy', from_id: 19, at: 0 }] }],
    by_item: [{ item: 'Jawbreaker', qty: 1 }, { item: 'Pixie Sticks', qty: 3 }], by_source: [{ from: 'Jimmy', from_id: 19, drops: 2 }] },
  effect_totals: { powerful: 9, stricken: 5 },
}
const STATS = (over = {}) => ({
  from: EVENT.starts_at, to: D2 + 3_600_000, server_now: 1,
  totals: { hits: 500, respect: 2000, mug: 300, assists: 4, retaliations: 7, incoming: 20 },
  members: [{ id: 1, name: 'Alice', hits: 400, respect: 1600, mug: 250, hospitalize: 100, leave: 50, assists: 0, losses: 0, retaliations: 2, incoming: 12, defended: 2 }],
  highlights: HIGHLIGHTS, ...over,
})

const WANTED_ROW = { id: 900, name: 'Grudgey', faction_id: 800, faction_name: 'Beta', attacks: 5, won: 3, failed: 2,
  respect_taken: 4.5, first_ms: D1, last_ms: D2, most_on_one: 4,
  victims: [{ id: 1, name: 'Alice', attacks: 4, won: 3, failed: 1 }, { id: 2, name: 'Bob', attacks: 1, won: 0, failed: 1 }] }
const TARGETED = { member_id: 2, total: 21, attackers: [
  { id: 900, name: 'Grudgey', attacks: 20, won: 18, failed: 2, respect_taken: 9, faction_id: 800, faction_name: 'Beta', first_ms: 0, last_ms: 0 },
  { id: null, name: 'Stealthed', attacks: 1, won: 1, failed: 0, respect_taken: 0, faction_id: null, faction_name: null, first_ms: 0, last_ms: 0 },
] }
let version
let stats
let wanted
beforeEach(() => {
  version = 'v1'
  stats = STATS()
  wanted = { threshold: 3, wanted: [WANTED_ROW], dismissed: [] }
  api.get.mockReset(); api.post.mockReset(); api.del.mockReset()
  api.get.mockImplementation(async (path) => {
    if (path.endsWith('/version')) return { version }
    if (path.includes('/stats')) return typeof stats === 'function' ? stats(path) : stats
    if (path.endsWith('/wanted')) return wanted
    if (path.includes('/targeted/')) return TARGETED
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
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Report', 'Totals', 'Stats', 'Targets'])
    expect(screen.getByText('No attacks yet (1)')).toBeTruthy()
    expect(screen.getByText('Cara [3]')).toBeTruthy()
  })

  it('shows Torn\'s totals, with the bonus hitter linked', async () => {
    await open('Totals')
    expect(screen.getByText('1,200')).toBeTruthy()
    expect(screen.getAllByText('Alice [1]').length).toBeGreaterThan(0)
  })

  it('⚠️ says Stalemates, as Torn does, and has no Bonuses card', async () => {
    await open('Totals')
    expect(screen.getByText('Stalemates')).toBeTruthy()
    expect(screen.queryByText('Draws')).toBeNull()
    expect(screen.queryByText('Bonuses')).toBeNull()
    expect(screen.getByText('Highest respect attack')).toBeTruthy()
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
    await screen.findByText(/Revitalize · 5 procs/)
    expect(api.get).toHaveBeenCalledWith('/api/events/1/stats')
    fireEvent.click(screen.getByRole('button', { name: '27 Oct' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/events/1/stats?from=${D2}&to=${D2 + 86_400_000}`))
  })

  it('⚠️ opening Custom asks the server for nothing until a range is chosen', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    const before = api.get.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    await new Promise((r) => setTimeout(r, 50))
    expect(api.get.mock.calls.slice(before).some(([p]) => p.includes('undefined'))).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('takes a custom range to the SECOND, in TCT', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From (TCT)'), { target: { value: '2026-10-26T14:30:05' } })
    fireEvent.change(screen.getByLabelText('To (TCT)'), { target: { value: '2026-10-27T02:00:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(
      `/api/events/1/stats?from=${Date.UTC(2026, 9, 26, 14, 30, 5)}&to=${Date.UTC(2026, 9, 27, 2)}`))
  })

  it('says plainly when the end is before the start', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('From (TCT)'), { target: { value: '2026-10-27T00:00:00' } })
    fireEvent.change(screen.getByLabelText('To (TCT)'), { target: { value: '2026-10-26T00:00:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('alert').textContent).toBe('The end has to be after the start.')
  })

  it('⚠️ leads with the Revitalize and treat leaderboards, explaining an empty one', async () => {
    await open('Stats')
    expect(await screen.findByText(/Revitalize · 5 procs/)).toBeTruthy()
    expect(screen.getByText('Treats')).toBeTruthy()
    expect(screen.getByText(/No treat seen in a log yet/)).toBeTruthy()
  })

  it('shows loot, bounties, mugs and hits with the other side linked', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    expect(screen.getByText('Loot by item')).toBeTruthy()
    expect(screen.getAllByText('Jimmy [19]').length).toBeGreaterThan(0)
    expect(screen.getByText('$2,000,010')).toBeTruthy()
    expect(screen.getByText('Richie [77]').closest('a').getAttribute('href')).toContain('XID=77')
    expect(screen.getByText('Tank [78]')).toBeTruthy()
  })

  it('keeps every other effect folded away, for spotting new ones', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    expect(screen.getByText('All effects seen (2)')).toBeTruthy()
  })

  it('explains a range with nothing archived yet', async () => {
    stats = STATS({ highlights: null })
    await open('Stats')
    expect(await screen.findByText(/Highlights appear once attack logs/)).toBeTruthy()
  })

  it('rangeQuery never sends half a range', () => {
    expect(rangeQuery({ kind: 'overall' })).toBe('')
    expect(rangeQuery({ kind: 'day', from: 1, to: 2 })).toBe('?from=1&to=2')
    expect(rangeQuery({ kind: 'custom' })).toBe('')
  })

  it('tctDateTimeMs reads TCT to the second, with or without seconds', () => {
    expect(tctDateTimeMs('2026-10-26T14:30:05')).toBe(Date.UTC(2026, 9, 26, 14, 30, 5))
    expect(tctDateTimeMs('2026-10-26T14:30')).toBe(Date.UTC(2026, 9, 26, 14, 30))
    expect(tctDateTimeMs('2026-10-26T14:30:05.000')).toBe(Date.UTC(2026, 9, 26, 14, 30, 5))
    expect(tctDateTimeMs('')).toBeNull()
  })
})

describe('member boards', () => {
  it('⚠️ list the whole faction, sortable, in a scrolling window', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    const board = screen.getByText(/Revitalize · 5 procs/).closest('.card')
    expect(board.querySelector('.overflow-y-auto')).toBeTruthy()
    const names = () => within(board).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1].textContent)
    expect(names()).toEqual(['Alice [1]', 'Bob [2]'])
    fireEvent.click(within(board).getByRole('button', { name: 'Sort by Procs' }))
    expect(names()).toEqual(['Bob [2]', 'Alice [1]'])
  })

  it('⚠️ loot: clicking a member\'s drops shows what and from whom, linked', async () => {
    await open('Stats')
    await screen.findByText(/Revitalize · 5 procs/)
    const board = screen.getByText('Loot drops', { selector: 'h4' }).closest('.card')
    fireEvent.click(within(board).getByRole('button', { name: /2/ }))
    expect(within(board).getByText(/3× Pixie Sticks from/)).toBeTruthy()
    expect(within(board).getAllByText('Jimmy [19]').length).toBe(2)
  })
})

describe('Targets', () => {
  it('⚠️ lists every faction linked, in a scrolling box', async () => {
    await open('Targets')
    expect(screen.getByText('Factions we attacked most')).toBeTruthy()
    const link = screen.getByText('Fac13 [713]').closest('a')
    expect(link.getAttribute('href')).toBe('https://www.torn.com/factions.php?step=profile&ID=713')
    expect(link.closest('ol').className).toMatch(/overflow-y-auto/)
    expect(screen.getByText(/20 beat us · 10 defended · 5 of ours attacked · −12\.25 respect/)).toBeTruthy()
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

describe('⚠️ hits and attacks are never confused', () => {
  it('counts attacks as attacks, and keeps "hit" for one turn\'s damage', async () => {
    await open('Totals')
    expect(screen.getByText('Attacks')).toBeTruthy()
    expect(screen.getByText('Bonus attacks')).toBeTruthy()
    expect(screen.queryByText('Hits')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    expect(screen.getByText('Who attacked us most')).toBeTruthy()
    expect(screen.getByText('Who we attacked most')).toBeTruthy()
    expect(screen.queryByText(/ hits$/)).toBeNull()
  })
})

describe('wanted board', () => {
  it('lists who keeps coming at one member, linking straight to the attack page', async () => {
    await open('Targets')
    const link = (await screen.findAllByText('Grudgey [900]'))[0].closest('a')
    expect(link.getAttribute('href')).toBe('https://www.torn.com/page.php?sid=attack&user2ID=900')
    expect(screen.getByText(/5 attacks · 3 beat us · 2 failed · −4\.50 respect/)).toBeTruthy()
  })

  it('⚠️ adds to the Book of Grudges in one click', async () => {
    api.post.mockResolvedValue({ state: 'active' })
    await open('Targets')
    await screen.findAllByText('Grudgey [900]')
    fireEvent.click(screen.getByRole('button', { name: 'Add to grudges' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/grudges', expect.objectContaining({ target: '900' })))
    expect(await screen.findByText('Added to grudges')).toBeTruthy()
  })

  it('offers Remove to leadership only', async () => {
    render(<EventReport event={EVENT} isLeadership />)
    await screen.findByText('Alice [1]')
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    await screen.findAllByText('Grudgey [900]')
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    cleanup()
    await open('Targets')
    await screen.findAllByText('Grudgey [900]')
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('folds removed entries away, with a way back', async () => {
    wanted = { threshold: 3, wanted: [], dismissed: [{ ...WANTED_ROW, note: 'paid defends' }] }
    render(<EventReport event={EVENT} isLeadership />)
    await screen.findByText('Alice [1]')
    fireEvent.click(screen.getByRole('tab', { name: 'Targets' }))
    expect(await screen.findByText('Removed by leadership (1)')).toBeTruthy()
    expect(screen.getByText('Removed: paid defends')).toBeTruthy()
  })
})

describe('who attacked one member', () => {
  it('expands a most-targeted member into everyone who attacked them, stealthed included', async () => {
    await open('Targets')
    const board = screen.getByText('Most targeted members').closest('.card')
    fireEvent.click(within(board).getByRole('button', { name: /21/ }))
    expect(await within(board).findByText('Stealthed')).toBeTruthy()
    expect(within(board).getAllByText('Grudgey [900]')[0].closest('a').getAttribute('href')).toContain('sid=attack')
  })
})
