// @vitest-environment jsdom
//
// The sign-up grid, and the boundary between claiming an hour and back-filling
// one (MonChoon, 2026-10-01 — spotted on dev).
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SignUpGrid, { claimedLabel } from '../SignUpGrid'

afterEach(cleanup)

const EVENT = {
  id: 1, slots_per_hour: 1, payout_per_slot: 1_500_000,
  bonus_hours: [], bonus_multiplier: 2, bonus_applies_to: 'tickets',
}

const HOUR_ISO = '2027-11-03T04:00:00.000Z'
const row = (over = {}) => ({
  hourIso: HOUR_ISO, ms: Date.parse('2027-11-03T04:00:00Z'),
  tct: '04:00', isPast: true, isNow: false, slots: [null], openSlots: 1, ...over,
})

const draw = (props = {}) => render(
  <SignUpGrid rows={[row()]} event={EVENT} meId="1" canEdit={false}
    onClaim={() => {}} onRelease={() => {}} onAssign={() => {}} busyKey={null}
    {...props} />)

describe('a finished hour is read-only for members', () => {
  // ⚠️ The hole this closes: the "Sign up" button was rendered unconditionally,
  // so from the history tab ANY member could back-fill every elapsed hour of an
  // open event — and `is_payable` only asks whether an hour fell before the
  // chain ended, not whether the claim came before the hour ran. They would
  // have been paid for each.

  it('offers a member nothing to click on an hour that has run', () => {
    draw()
    expect(screen.queryByTestId(`claim-${HOUR_ISO}-0`)).toBeNull()
    expect(screen.getByTestId(`closed-${HOUR_ISO}-0`)).toBeTruthy()
  })

  it('⚠️ gives leadership the ASSIGN button, not a Sign-up button', () => {
    // A leader filling a slot after the fact is assigning somebody; "Sign up"
    // would claim it for the leader themselves, which is never what they meant.
    draw({ canEdit: true })
    expect(screen.queryByTestId(`claim-${HOUR_ISO}-0`)).toBeNull()
    expect(screen.getByTestId(`closed-${HOUR_ISO}-0`)).toBeTruthy()
    expect(screen.getByLabelText(/Assign someone to/)).toBeTruthy()
  })

  it('gives a member no assign button either', () => {
    draw()
    expect(screen.queryByLabelText(/Assign someone to/)).toBeNull()
  })

  it('still lets a member claim the hour they are IN', () => {
    // ⚠️ The boundary is the hour's END, not its start — you are watching it.
    draw({ rows: [row({ isPast: false, isNow: true })] })
    expect(screen.getByTestId(`claim-${HOUR_ISO}-0`)).toBeTruthy()
  })

  it('still lets a member claim a future hour', () => {
    draw({ rows: [row({ isPast: false, isNow: false })] })
    expect(screen.getByTestId(`claim-${HOUR_ISO}-0`)).toBeTruthy()
  })

  it('⚠️ says "Not filled" rather than offering a disabled button', () => {
    // A greyed-out control invites a click and then refuses it. This says what
    // the slot IS — an hour that ran with nobody on it, which is the thing a
    // post-mortem wants to see.
    draw()
    const cell = screen.getByTestId(`closed-${HOUR_ISO}-0`)
    expect(cell.tagName).toBe('SPAN')
    expect(cell.textContent).toBe('Not filled')
  })
})

describe('claimedLabel', () => {
  const r = { ms: Date.parse('2027-11-03T04:00:00Z') }

  it('says when a slot was claimed', () => {
    expect(claimedLabel({ created_ms: Date.parse('2027-11-02T14:02:00Z') }, r))
      .toBe('Claimed 14:02 TCT')
  })

  it('⚠️ marks a claim made after the hour ran', () => {
    // A back-fill by leadership is legitimate — it just has to be visible, or
    // nobody can tell it apart from somebody who signed up in advance.
    expect(claimedLabel({ created_ms: Date.parse('2027-11-03T09:00:00Z') }, r))
      .toContain('after the hour ran')
  })

  it('does not mark a claim made during the hour', () => {
    expect(claimedLabel({ created_ms: Date.parse('2027-11-03T04:30:00Z') }, r))
      .not.toContain('after')
  })

  it('says nothing when the server sent no timestamp', () => {
    // ⚠️ `created_ms` is an epoch NUMBER. If it is ever absent, show no tooltip
    // rather than "Invalid Date" — the #140 failure mode.
    expect(claimedLabel({}, r)).toBeUndefined()
    expect(claimedLabel({ created_ms: 'not a number' }, r)).toBeUndefined()
  })
})

describe('where a sign-up came from (#1007)', () => {
  const held = (via) => ({
    member_id: '7', member_name: 'Goosey', created_ms: Date.parse(HOUR_ISO) - 3_600_000, via,
  })

  it('marks a sign-up made from the Discord board', () => {
    draw({ rows: [row({ slots: [held('discord')], openSlots: 0 })] })
    expect(screen.getByLabelText('Signed up from Discord')).toBeTruthy()
  })

  it('leaves a website sign-up unmarked', () => {
    draw({ rows: [row({ slots: [held('web')], openSlots: 0 })] })
    expect(screen.queryByLabelText('Signed up from Discord')).toBeNull()
  })
})
