// @vitest-environment jsdom
//
// Event bingo (#965): the member's card, asking for a square, and leadership's
// review and setup.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const api = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn(), fetch: vi.fn(),
}))
vi.mock('../../../utils/apiClient', () => ({
  apiGet: (...a) => api.get(...a), apiPost: (...a) => api.post(...a), apiPatch: (...a) => api.patch(...a),
  apiPut: (...a) => api.put(...a), apiDelete: (...a) => api.del(...a), apiFetch: (...a) => api.fetch(...a),
}))

import Bingo from '../Bingo'
import BingoSettings from '../BingoSettings'

const EVENT = { id: 4, name: 'Halloween', theme_color: '#f97316' }
const CARD = {
  configured: true, enabled: true, rows: 2, cols: 2,
  grid: { left: 0, top: 0, right: 100, bottom: 100 }, image_url: null,
  tiles: [
    { idx: 0, label: 'Send a gift', kind: 'proof', rule: null },
    { idx: 1, label: 'Over 10 respect', kind: 'auto', rule: 'respect_over_10' },
    { idx: 2, label: 'Free space', kind: 'free', rule: null },
    { idx: 3, label: 'Win a race', kind: 'proof', rule: null },
  ],
  auto_rules: [{ key: 'respect_over_10', label: 'Over 10 respect', source: 'attacks' }],
  member: { member_id: '7200', name: 'Pumpkin' },
  marks: [
    { id: 9, idx: 1, status: 'approved', source: 'auto', created_at: 1, reviewed_at: 2 },
    { id: 8, idx: 3, status: 'pending', source: 'proof', created_at: 1 },
  ],
  standings: [{ member_id: '7200', name: 'Pumpkin', squares: 1, lines: 0, pending: 1 }],
  pending_reviews: null,
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset()
  api.get.mockResolvedValue(CARD)
})
afterEach(cleanup)

describe('the member card', () => {
  it('shows crossed, pending and free squares, and the count excludes the free one', async () => {
    render(<Bingo event={EVENT} />)
    expect(await screen.findByText('1 of 3 squares · 0 lines')).toBeTruthy()
    expect(screen.getByLabelText('Over 10 respect — crossed')).toBeTruthy()
    expect(screen.getByLabelText('Win a race — waiting for review')).toBeTruthy()
    expect(screen.getByLabelText('Free space — crossed')).toBeTruthy()
    expect(screen.queryByText(/Review proof/)).toBeNull()
  })

  it('asks for a square with proof', async () => {
    api.post.mockResolvedValue({ id: 10, idx: 0, status: 'pending' })
    render(<Bingo event={EVENT} />)
    fireEvent.click(await screen.findByLabelText('Send a gift'))
    const send = screen.getByRole('button', { name: 'Send for review' })
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(/Paste the log line/), { target: { value: 'You sent a Pumpkin to Ghost' } })
    fireEvent.click(send)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/events/4/bingo/marks',
      { idx: 0, proof_text: 'You sent a Pumpkin to Ghost' }))
  })

  it('a waiting request can be withdrawn, and offers no second ask', async () => {
    api.del.mockResolvedValue({ ok: true })
    render(<Bingo event={EVENT} />)
    fireEvent.click(await screen.findByLabelText('Win a race — waiting for review'))
    expect(screen.queryByRole('button', { name: 'Send for review' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }))
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/api/events/4/bingo/marks/8'))
  })
})

describe('leadership', () => {
  it('reviews proof and approves it', async () => {
    api.get.mockImplementation(async (path) => (path.endsWith('/reviews')
      ? { marks: [{ id: 8, idx: 3, member_id: '7200', member_name: 'Pumpkin', status: 'pending',
          proof_text: 'Won race 123', has_image: false, created_at: 1 }] }
      : { ...CARD, pending_reviews: 1 }))
    api.patch.mockResolvedValue({})
    render(<Bingo event={EVENT} isLeadership />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review proof (1)' }))
    expect(await screen.findByText('Won race 123')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/events/4/bingo/marks/8', { decision: 'approved', note: '' }))
  })

  it('opens a member\'s card from the standings', async () => {
    render(<Bingo event={EVENT} isLeadership />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pumpkin' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/events/4/bingo?member=7200'))
  })

  it('sets the card up and saves it', async () => {
    api.put.mockResolvedValue(CARD)
    render(<BingoSettings event={EVENT} />)
    const first = await screen.findByLabelText('Square 1 text')
    fireEvent.change(first, { target: { value: 'Send a gift to a faction mate' } })
    fireEvent.change(screen.getByLabelText('Columns'), { target: { value: '3' } })
    expect(screen.getByLabelText('Square 6 text')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save bingo card' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const body = api.put.mock.calls[0][1]
    expect(body).toMatchObject({ enabled: true, rows: 2, cols: 3 })
    expect(body.tiles).toHaveLength(6)
    expect(body.tiles[0]).toMatchObject({ label: 'Send a gift to a faction mate', kind: 'proof' })
    expect(body.tiles[1]).toMatchObject({ kind: 'auto', rule: 'respect_over_10' })
  })
})
