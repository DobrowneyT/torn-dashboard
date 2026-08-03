import { describe, it, expect } from 'vitest'
import { isOverdosed, canEditMemberNotes, notesByMember } from '../memberNotes'

describe('isOverdosed', () => {
  it('flags a hospitalised member whose status reason mentions overdose', () => {
    expect(isOverdosed({ status_state: 'Hospital', status_details: 'Overdosed' })).toBe(true)
    expect(isOverdosed({ status_state: 'Hospital', status_details: 'overdosed on xanax' })).toBe(true)
  })
  it('does not flag other hospital reasons, non-hospital states, or missing data', () => {
    expect(isOverdosed({ status_state: 'Hospital', status_details: 'Attacked by someone' })).toBe(false)
    expect(isOverdosed({ status_state: 'Okay', status_details: 'Overdosed' })).toBe(false) // not currently hospitalised
    expect(isOverdosed({ status_state: 'Hospital', status_details: null })).toBe(false)
    expect(isOverdosed(null)).toBe(false)
  })
})

describe('canEditMemberNotes', () => {
  it('allows war leads / leadership / admin but never visitors', () => {
    expect(canEditMemberNotes({ isWarLead: true })).toBe(true)
    expect(canEditMemberNotes({ isLeadership: true })).toBe(true)
    expect(canEditMemberNotes({ isAdmin: true })).toBe(true)
    expect(canEditMemberNotes({ isLeadership: true, isVisitor: true })).toBe(false)
    expect(canEditMemberNotes({})).toBe(false)
  })
})

describe('notesByMember', () => {
  it('keys the note list by member_id (as strings)', () => {
    const map = notesByMember([{ member_id: '501', note: 'a' }, { member_id: 502, note: 'b' }])
    expect(map['501']).toBe('a')
    expect(map['502']).toBe('b')
  })
})
