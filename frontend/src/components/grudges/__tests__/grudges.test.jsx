// @vitest-environment jsdom
//
// The Book of Grudges UI (#889, slices 2-3).
//
// The theme: the list's whole premise is that a target is there for a STATED
// reason, and that an own-faction target does not appear until leadership says
// so. These tests are weighted at those two things plus the ways a table can
// quietly lie about numbers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('../../../utils/apiClient', () => ({
  apiGet: vi.fn(), apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 9010, name: 'Me' } }),
}))

const { apiGet, apiPost, apiPatch, apiDelete } = await import('../../../utils/apiClient')
const { default: GrudgesSection } = await import('../GrudgesSection')
const { default: AddGrudgeForm } = await import('../AddGrudgeForm')
const { default: GrudgeList } = await import('../GrudgeList')

const target = (over = {}) => ({
  id: 1, target_id: '5001', target_name: 'Likor', faction_id: null, faction_name: null,
  state: 'active', bsp_total: null, spy_source: null,
  status_state: null, status_until: null, added_ms: Date.UTC(2026, 9, 4),
  added_by: '9010',
  grudges: [{ id: 11, member_id: '9010', member_name: 'Me', reason: 'mugged me', severity_id: null }],
  ...over,
})

const wire = (targets, settings = { severities: [] }, pending = []) => {
  apiGet.mockImplementation(async (path) => {
    if (path === '/api/grudges') return { targets }
    if (path === '/api/grudges/settings') return settings
    if (path === '/api/grudges/pending') return { pending, count: pending.length }
    throw new Error(`unexpected ${path}`)
  })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AddGrudgeForm', () => {
  // ⚠️ Asserts the BEHAVIOUR, not just the disabled attribute. A greyed-out
  // button that still posts when clicked would pass an attribute check and
  // fail the user, and this is the one rule worth over-testing.
  it('⚠️ will not submit without a reason — that is the whole premise', () => {
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: '5001' } })
    const btn = screen.getByRole('button', { name: /add to the book/i })
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('⚠️ will not submit with a whitespace-only reason', () => {
    // Otherwise a required field is bypassed by pressing the space bar.
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: '5001' } })
    fireEvent.change(screen.getByLabelText(/what did they do/i), { target: { value: '   ' } })
    const btn = screen.getByRole('button', { name: /add to the book/i })
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('objects to a bad link while you type, not after a round trip', () => {
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: 'that guy' } })
    expect(screen.getByText(/not a Torn profile link/i)).toBeTruthy()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('submits a parsed link with its reason', async () => {
    apiPost.mockResolvedValue({ state: 'active' })
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), {
      target: { value: 'https://www.torn.com/profiles.php?XID=5001' },
    })
    fireEvent.change(screen.getByLabelText(/what did they do/i), { target: { value: 'mugged me' } })
    fireEvent.click(screen.getByRole('button', { name: /add to the book/i }))
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost.mock.calls[0][1]).toMatchObject({ reason: 'mugged me' })
  })

  it('⚠️ says a watched-faction target was HELD, not simply added', async () => {
    // "Added to the list" for something nobody can see would be a lie.
    apiPost.mockResolvedValue({ state: 'pending_approval' })
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: '5001' } })
    fireEvent.change(screen.getByLabelText(/what did they do/i), { target: { value: 'friendly fire' } })
    fireEvent.click(screen.getByRole('button', { name: /add to the book/i }))
    expect(await screen.findByText(/held for leadership approval/i)).toBeTruthy()
  })

  it('⚠️ does not claim a watched faction when the lookup simply failed', async () => {
    // Two different reasons to be held, and saying the wrong one is a
    // confident claim about something we failed to find out.
    apiPost.mockResolvedValue({ state: 'pending_approval', pending_reason: 'unverified' })
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: '5001' } })
    fireEvent.change(screen.getByLabelText(/what did they do/i), { target: { value: 'mystery' } })
    fireEvent.click(screen.getByRole('button', { name: /add to the book/i }))
    expect(await screen.findByText(/could not look this player up/i)).toBeTruthy()
    expect(screen.queryByText(/is in a watched faction/i)).toBeNull()
  })

  it('names the target it just resolved', async () => {
    apiPost.mockResolvedValue({ state: 'active', target_name: 'Likor' })
    render(<AddGrudgeForm />)
    fireEvent.change(screen.getByLabelText(/profile link or ID/i), { target: { value: '5001' } })
    fireEvent.change(screen.getByLabelText(/what did they do/i), { target: { value: 'mugged me' } })
    fireEvent.click(screen.getByRole('button', { name: /add to the book/i }))
    expect(await screen.findByText(/Added to the list — Likor/)).toBeTruthy()
  })

  it('⚠️ renders no severity control when the faction configured none', () => {
    // No hardcoded Low/Medium/High. An absent control is honest; three
    // invented tiers are not.
    render(<AddGrudgeForm severities={[]} />)
    expect(screen.queryByLabelText(/severity/i)).toBeNull()
  })

  it('⚠️ does not ask for a name — the lookup is the only source for it', () => {
    // One source for the name means a rename is something we OBSERVE rather
    // than a guess somebody typed months ago and never revisited.
    render(<AddGrudgeForm />)
    expect(screen.queryByLabelText(/their name/i)).toBeNull()
  })

  it('renders the severities the faction did configure', () => {
    render(<AddGrudgeForm severities={[{ id: 'petty', label: 'Petty' }, { id: 'blood', label: 'Blood feud' }]} />)
    expect(screen.getByLabelText(/severity/i)).toBeTruthy()
    expect(screen.getByText('Blood feud')).toBeTruthy()
  })
})

describe('GrudgeList', () => {
  const many = [
    target({ id: 1, target_id: '1', target_name: 'Alpha', bsp_total: 9_000_000, status_state: 'Okay' }),
    target({ id: 2, target_id: '2', target_name: 'Beta', bsp_total: 10_000_000, status_state: 'Hospital' }),
    target({ id: 3, target_id: '3', target_name: 'Gamma', bsp_total: 2_000_000, status_state: 'Okay' }),
  ]

  it('⚠️ sorts battle stats numerically, not as text', () => {
    // 10,000,000 before 2,000,000 — the Hall of Fame shipped this bug and the
    // `sortColumnKinds` guard exists because of it.
    const { container } = render(<GrudgeList targets={many} viewerId={9010} />)
    fireEvent.click(container.querySelectorAll('thead th')[2].querySelector('button'))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('sorts by faction, with the unfactioned sinking', () => {
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'Alpha', faction_id: '2', faction_name: 'Zulu' }),
      target({ id: 2, target_id: '2', target_name: 'Beta', faction_id: null, faction_name: null }),
      target({ id: 3, target_id: '3', target_name: 'Gamma', faction_id: '1', faction_name: 'Alpha Co' }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    fireEvent.click(container.querySelectorAll('thead th')[1].querySelector('button'))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    // ⚠️ #351: unfactioned is ABSENT, not "last alphabetically", so it sinks.
    expect(names).toEqual(['Gamma', 'Alpha', 'Beta'])
  })

  it('links the faction, and shows an em dash when there is none', () => {
    const rows = [
      target({ id: 1, target_id: '1', faction_id: '10739', faction_name: 'TNL' }),
      target({ id: 2, target_id: '2', target_name: 'Loner', faction_id: null }),
    ]
    render(<GrudgeList targets={rows} viewerId={9010} />)
    const link = screen.getByRole('link', { name: 'TNL' })
    expect(link.getAttribute('href')).toContain('factions.php?step=profile&ID=10739')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('⚠️ sorts the grudge column by COUNT, not by reason text', () => {
    // "Who has upset the most of us" answers something; prose sorted
    // alphabetically answers nothing.
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'One', grudges: [{ id: 1, member_id: '1', reason: 'a' }] }),
      target({ id: 2, target_id: '2', target_name: 'Three', grudges: [
        { id: 2, member_id: '1', reason: 'b' }, { id: 3, member_id: '2', reason: 'c' }, { id: 4, member_id: '3', reason: 'd' },
      ] }),
      target({ id: 3, target_id: '3', target_name: 'Two', grudges: [
        { id: 5, member_id: '1', reason: 'e' }, { id: 6, member_id: '2', reason: 'f' },
      ] }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    const grudgeTh = container.querySelectorAll('thead th')[8]
    expect(grudgeTh.textContent).toContain('Grudges')
    fireEvent.click(grudgeTh.querySelector('button'))   // ascending
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['One', 'Two', 'Three'])
  })

  it('⚠️ leaves Attack as a plain header — it is an action, not data', () => {
    // A header that looks clickable and reorders nothing is worse than one
    // that plainly does not.
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} />)
    const attackTh = container.querySelectorAll('thead th')[10]
    expect(attackTh.textContent).toContain('Attack')
    expect(attackTh.querySelector('button')).toBeNull()
  })

  it('every other column IS sortable', () => {
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} />)
    const ths = [...container.querySelectorAll('thead th')]
    // All but the last (Attack) offer a sort control.
    expect(ths.slice(0, -1).every((th) => th.querySelector('button') !== null)).toBe(true)
  })

  it('hides anyone in hospital when asked', () => {
    const { container } = render(<GrudgeList targets={many} viewerId={9010} />)
    fireEvent.click(screen.getByLabelText(/hide anyone in hospital/i))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).not.toContain('Beta')
    expect(names).toHaveLength(2)
  })

  it('filters on the reason text, not just the name', () => {
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'Alpha', grudges: [{ id: 1, member_id: '1', reason: 'stole my loot' }] }),
      target({ id: 2, target_id: '2', target_name: 'Beta', grudges: [{ id: 2, member_id: '1', reason: 'taunted me' }] }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} />)
    fireEvent.change(screen.getByLabelText(/filter the list/i), { target: { value: 'taunted' } })
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['Beta'])
  })

  it('⚠️ links the attack button at Torn’s loader, in a new tab', () => {
    render(<GrudgeList targets={[target()]} viewerId={9010} />)
    const link = screen.getByRole('link', { name: /attack/i })
    expect(link.getAttribute('href')).toBe('https://www.torn.com/loader.php?sid=attack&user2ID=5001')
    expect(link.getAttribute('target')).toBe('_blank')
    // ⚠️ Without rel=noopener the opened tab can reach back into this one.
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('shows the target id when no name is known yet', () => {
    // Slice 1 cannot resolve a name — that needs a Torn call. The id is the
    // honest placeholder.
    render(<GrudgeList targets={[target({ target_name: null })]} viewerId={9010} />)
    expect(screen.getByRole('link', { name: '5001' })).toBeTruthy()
  })

  it('⚠️ offers edit and remove only on your own grudge', () => {
    const rows = [target({
      grudges: [
        { id: 11, member_id: '9010', member_name: 'Me', reason: 'mine' },
        { id: 12, member_id: '9999', member_name: 'Someone', reason: 'theirs' },
      ],
    })]
    render(<GrudgeList targets={rows} viewerId={9010} isLeadership={false} />)
    expect(screen.getByLabelText('Edit grudge by Me')).toBeTruthy()
    expect(screen.queryByLabelText('Edit grudge by Someone')).toBeNull()
  })

  it('lets leadership edit anyone’s', () => {
    const rows = [target({ grudges: [{ id: 12, member_id: '9999', member_name: 'Someone', reason: 'theirs' }] })]
    render(<GrudgeList targets={rows} viewerId={9010} isLeadership />)
    expect(screen.getByLabelText('Edit grudge by Someone')).toBeTruthy()
  })

  it('marks a pending target so nobody thinks it is live', () => {
    render(<GrudgeList targets={[target({ state: 'pending_approval' })]} viewerId={9010} />)
    expect(screen.getByText(/awaiting approval/i)).toBeTruthy()
  })

  it('⚠️ explains that FF is personal, and what a dash means', () => {
    // A dash is "we cannot work it out", NOT "bad target", and the two read
    // identically unless the page says so.
    render(<GrudgeList targets={[target()]} viewerId={9010} />)
    expect(screen.getByText(/it is what you would earn/i)).toBeTruthy()
    expect(screen.getByText(/A dash means we cannot work it out/i)).toBeTruthy()
  })

  // =========================================================================
  // ⚠️ FAIR FIGHT — personal to the viewer
  // =========================================================================
  const spied = (over = {}) => target({
    bsp_total: 4_000_000, bsp_str: 1_000_000, bsp_spd: 1_000_000,
    bsp_def: 1_000_000, bsp_dex: 1_000_000, spy_source: 'tornstats', ...over,
  })
  const mine = { strength: 1_000_000, speed: 1_000_000, defense: 1_000_000, dexterity: 1_000_000 }

  it('⚠️ shows a dash when the viewer has no stats of their own', () => {
    // FF is what YOU would earn. Without your own stats there is no answer,
    // and inventing one sends somebody at a target that pays nothing.
    const { container } = render(<GrudgeList targets={[spied()]} viewerId={9010} myBattleStats={null} />)
    const ffCell = container.querySelectorAll('tbody td')[3]
    expect(ffCell.textContent).toBe('—')
  })

  it('shows a dash when the TARGET has no stats', () => {
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} myBattleStats={mine} />)
    expect(container.querySelectorAll('tbody td')[3].textContent).toBe('—')
  })

  it('computes FF from the viewer’s own stats', () => {
    // Equal scores → ratio 1 → TRUE FF 1 + 8/3 = 3.67 (#995). Respect still
    // pays at the 3.00 cap; the display shows how far past it this is.
    const { container } = render(<GrudgeList targets={[spied()]} viewerId={9010} myBattleStats={mine} />)
    expect(container.querySelectorAll('tbody td')[3].textContent).toBe('3.67')
  })

  it('⚠️ the SAME target reads differently for a stronger viewer', () => {
    // The whole point of a per-viewer column: this is not a property of the
    // target, and a shared value would be wrong for everybody but one person.
    const weakTarget = spied({
      bsp_total: 40_000, bsp_str: 10_000, bsp_spd: 10_000, bsp_def: 10_000, bsp_dex: 10_000,
    })
    const { container } = render(<GrudgeList targets={[weakTarget]} viewerId={9010} myBattleStats={mine} />)
    const ff = container.querySelectorAll('tbody td')[3].textContent
    expect(ff).not.toBe('3.00')
    expect(Number(ff)).toBeGreaterThan(1)
  })

  it('⚠️ marks an estimate when one side has only a total', () => {
    // An even split was assumed, which inflates FF on the target side. A
    // number built on a bare total must not look as solid as a real spy.
    const totalOnly = target({ bsp_total: 4_000_000, spy_source: 'bsp' })
    const { container } = render(<GrudgeList targets={[totalOnly]} viewerId={9010} myBattleStats={mine} />)
    const span = container.querySelectorAll('tbody td')[3].querySelector('span')
    expect(span.className).toMatch(/decoration-dotted/)
    expect(span.getAttribute('title')).toMatch(/even split was assumed/i)
  })

  it('does not mark a reading built on a real spy', () => {
    const { container } = render(<GrudgeList targets={[spied()]} viewerId={9010} myBattleStats={mine} />)
    const span = container.querySelectorAll('tbody td')[3].querySelector('span')
    expect(span.className).not.toMatch(/decoration-dotted/)
  })

  it('⚠️ renders battle stats through the SHARED cell, not a lookalike', async () => {
    // Same component as the War Room and Member Overview (#355). The
    // measured-vs-estimated distinction must not be restated a third time in
    // different words, so the breakdown, source and age come from there.
    const row = spied({ ts_spy_at: '2026-01-15 12:00:00+00', bsp_fetched_at: '2026-10-04 12:00:00+00' })
    const { container } = render(<GrudgeList targets={[row]} viewerId={9010} myBattleStats={mine} />)
    const statsCell = container.querySelectorAll('tbody td')[2]
    // The trigger shows the total; the panel behind it carries the breakdown.
    expect(statsCell.textContent).toMatch(/4[.,]?0*0?m|4,000,000|4m/i)
    fireEvent.click(statsCell.querySelector('button'))
    expect(await screen.findByText('STR')).toBeTruthy()
    expect(screen.getByText('DEX')).toBeTruthy()
    // ⚠️ The age comes from the SPY time, not our fetch time — a TornStats
    // spy can be months older, and the fetch time would make it look current.
    expect(screen.getByText(/\(TS\)/)).toBeTruthy()
  })

  it('⚠️ shows "???" rather than a zero when there is no reading', () => {
    // A zero would put somebody at the bottom of every sort and make them
    // look like a free hit.
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} />)
    expect(container.querySelectorAll('tbody td')[2].textContent).toContain('???')
  })

  it('explains how FF is worked out, in the War Room’s own words', async () => {
    const { container } = render(<GrudgeList targets={[target()]} viewerId={9010} />)
    const ffTh = container.querySelectorAll('thead th')[3]
    const dot = [...ffTh.querySelectorAll('button')].pop()
    fireEvent.click(dot)
    expect(await screen.findByText(/FF = min\(3, 1 \+ 8\/3/)).toBeTruthy()
    expect(screen.getByText(/saturates at the 3.00 cap/i)).toBeTruthy()
  })

  it('⚠️ sorts FF, and sinks the targets it cannot compute', () => {
    const rows = [
      target({ id: 1, target_id: '1', target_name: 'Unknown' }),
      spied({ id: 2, target_id: '2', target_name: 'Strong' }),
      spied({
        id: 3, target_id: '3', target_name: 'Weak',
        bsp_total: 40_000, bsp_str: 10_000, bsp_spd: 10_000, bsp_def: 10_000, bsp_dex: 10_000,
      }),
    ]
    const { container } = render(<GrudgeList targets={rows} viewerId={9010} myBattleStats={mine} />)
    fireEvent.click(container.querySelectorAll('thead th')[3].querySelector('button'))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    // Ascending FF: Weak (low) then Strong (3.00); Unknown sinks (#351).
    expect(names).toEqual(['Weak', 'Strong', 'Unknown'])
  })

  it('renders an empty book without looking broken', () => {
    render(<GrudgeList targets={[]} viewerId={9010} />)
    expect(screen.getByText(/the book is empty/i)).toBeTruthy()
  })
})

describe('GrudgesSection', () => {
  it('shows the list once loaded', async () => {
    wire([target()])
    render(<GrudgesSection />)
    expect(await screen.findByText('Likor')).toBeTruthy()
  })

  it('⚠️ puts the approval queue in front of leadership', async () => {
    // A notification nobody sees is not a notification.
    wire([], { severities: [] }, [{ id: 7, target_id: '6001', target_name: 'Friendly', added_by: '9010' }])
    render(<GrudgesSection isLeadership />)
    expect(await screen.findByText(/1 target needs your approval/i)).toBeTruthy()
  })

  it('does not show the queue to a plain member', async () => {
    wire([target()])
    render(<GrudgesSection isLeadership={false} />)
    await screen.findByText('Likor')
    expect(screen.queryByText(/needs your approval/i)).toBeNull()
    expect(apiGet).not.toHaveBeenCalledWith('/api/grudges/pending')
  })

  it('approves from the queue and reloads', async () => {
    wire([], { severities: [] }, [{ id: 7, target_id: '6001', target_name: 'Friendly', added_by: '9010' }])
    apiPost.mockResolvedValue({ state: 'active' })
    render(<GrudgesSection isLeadership />)
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/grudges/targets/7/approve', {}))
  })

  it('⚠️ a failing approval queue must not blank the whole page', async () => {
    apiGet.mockImplementation(async (path) => {
      if (path === '/api/grudges') return { targets: [target()] }
      if (path === '/api/grudges/settings') return { severities: [] }
      throw new Error('queue exploded')
    })
    render(<GrudgesSection isLeadership />)
    expect(await screen.findByText('Likor')).toBeTruthy()
  })

  it('surfaces a load failure instead of spinning forever', async () => {
    apiGet.mockRejectedValue(new Error('upstream exploded'))
    render(<GrudgesSection />)
    expect(await screen.findByText('upstream exploded')).toBeTruthy()
  })
})
