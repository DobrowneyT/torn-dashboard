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
  state: 'active', battle_stats: null, stats_source: null,
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

  it('⚠️ renders no severity control when the faction configured none', () => {
    // No hardcoded Low/Medium/High. An absent control is honest; three
    // invented tiers are not.
    render(<AddGrudgeForm severities={[]} />)
    expect(screen.queryByLabelText(/severity/i)).toBeNull()
  })

  it('renders the severities the faction did configure', () => {
    render(<AddGrudgeForm severities={[{ id: 'petty', label: 'Petty' }, { id: 'blood', label: 'Blood feud' }]} />)
    expect(screen.getByLabelText(/severity/i)).toBeTruthy()
    expect(screen.getByText('Blood feud')).toBeTruthy()
  })
})

describe('GrudgeList', () => {
  const many = [
    target({ id: 1, target_id: '1', target_name: 'Alpha', battle_stats: 9_000_000, status_state: 'Okay' }),
    target({ id: 2, target_id: '2', target_name: 'Beta', battle_stats: 10_000_000, status_state: 'Hospital' }),
    target({ id: 3, target_id: '3', target_name: 'Gamma', battle_stats: 2_000_000, status_state: 'Okay' }),
  ]

  it('⚠️ sorts battle stats numerically, not as text', () => {
    // 10,000,000 before 2,000,000 — the Hall of Fame shipped this bug and the
    // `sortColumnKinds` guard exists because of it.
    const { container } = render(<GrudgeList targets={many} viewerId={9010} />)
    fireEvent.click(container.querySelectorAll('thead th')[1].querySelector('button'))
    const names = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('a').textContent)
    expect(names).toEqual(['Gamma', 'Alpha', 'Beta'])
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

  it('⚠️ says WHY battle stats and status are empty', () => {
    // An unexplained blank column reads as a broken scrape and gets reported
    // as a bug. It is switched off on purpose, pending #894.
    render(<GrudgeList targets={[target()]} viewerId={9010} />)
    expect(screen.getByText(/not being fetched yet/i)).toBeTruthy()
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
