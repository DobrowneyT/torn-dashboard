// @vitest-environment jsdom
//
// The four numbers that decide what a chain watch pays.
//
// ⚠️ Every figure on the sheet is DERIVED from these, never stamped onto a
// sign-up when it was claimed — so changing one corrects hours already served.
// That is the point: the spreadsheet this replaced froze its bonus into a
// column position and paid 59 slots where 31 were marked.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import PayoutSettings from '../PayoutSettings'

afterEach(cleanup)

const EVENT = {
  id: 1, payout_per_slot: 1_500_000,
  bonus_hours: [5, 6], bonus_multiplier: 2, bonus_applies_to: 'tickets',
}
const draw = (props = {}) =>
  render(<PayoutSettings event={EVENT} onSave={() => {}} onClose={() => {}} {...props} />)

describe('the form', () => {
  it('opens on the event current settings', () => {
    draw()
    expect(screen.getByTestId('per-slot').value).toBe('1500000')
    expect(screen.getByTestId('bonus-hours').value).toBe('5, 6')
    expect(screen.getByTestId('bonus-multiplier').value).toBe('2')
  })

  it('sends numbers, not strings', async () => {
    // ⚠️ The server validates `bonus_hours` as integers 0..23; a string array
    // would 400, and the form would look broken rather than wrong.
    const onSave = vi.fn().mockResolvedValue()
    draw({ onSave })
    fireEvent.change(screen.getByTestId('per-slot'), { target: { value: '2000000' } })
    fireEvent.change(screen.getByTestId('bonus-hours'), { target: { value: '7, 8 , 9' } })
    fireEvent.click(screen.getByTestId('save-settings'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toEqual({
      payout_per_slot: 2000000,
      bonus_hours: [7, 8, 9],
      bonus_multiplier: 2,
      bonus_applies_to: 'tickets',
    })
  })

  it('refuses an hour outside 0..23 before it reaches the server', () => {
    // ⚠️ Validated here AND on the server. The server is the boundary; this is
    // so a leader finds out before pressing save rather than reading a 400.
    draw()
    fireEvent.change(screen.getByTestId('bonus-hours'), { target: { value: '5, 99' } })
    expect(screen.getByTestId('settings-error').textContent).toContain('0 to 23')
    expect(screen.getByTestId('save-settings').disabled).toBe(true)
  })

  it('refuses a multiplier below 1, which would pay a bonus hour LESS', () => {
    draw()
    fireEvent.change(screen.getByTestId('bonus-multiplier'), { target: { value: '0.5' } })
    expect(screen.getByTestId('settings-error').textContent).toContain('at least 1')
  })

  it('accepts no bonus hours at all', () => {
    const onSave = vi.fn().mockResolvedValue()
    draw({ onSave })
    fireEvent.change(screen.getByTestId('bonus-hours'), { target: { value: '' } })
    expect(screen.queryByTestId('settings-error')).toBeNull()
    fireEvent.click(screen.getByTestId('save-settings'))
    return waitFor(() => expect(onSave.mock.calls[0][0].bonus_hours).toEqual([]))
  })

  it('⚠️ shows a failed save rather than swallowing it', async () => {
    // A save that silently failed leaves the sheet showing numbers nobody
    // agreed to.
    const onSave = vi.fn().mockRejectedValue(new Error('nope'))
    const onClose = vi.fn()
    draw({ onSave, onClose })
    fireEvent.click(screen.getByTestId('save-settings'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-error').textContent).toContain('nope'))
    expect(onClose, 'a failed save must not close the form').not.toHaveBeenCalled()
  })
})
