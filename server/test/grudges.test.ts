import { describe, expect, it } from 'vitest'
import {
  parseTargetId, isWatchedFaction, initialState, canSeeTarget,
  canModifyEntry, normaliseReason, planStatusRefresh, departedFromFaction,
} from '../src/grudges.js'

describe('parseTargetId', () => {
  it('takes a pasted profile link, which is how people will actually add', () => {
    expect(parseTargetId('https://www.torn.com/profiles.php?XID=2576356')).toBe('2576356')
    expect(parseTargetId('torn.com/profiles.php?XID=2576356&tab=info')).toBe('2576356')
    expect(parseTargetId('/profiles.php?sid=UserList&XID=90210')).toBe('90210')
  })

  it('⚠️ matches XID case-insensitively — links in the wild are not consistent', () => {
    expect(parseTargetId('https://www.torn.com/profiles.php?xid=2576356')).toBe('2576356')
  })

  it('takes a bare id, which is what people type when they do not paste', () => {
    expect(parseTargetId('2576356')).toBe('2576356')
    expect(parseTargetId('  2576356  ')).toBe('2576356')
  })

  it('refuses anything it cannot resolve rather than guessing', () => {
    expect(parseTargetId('')).toBeNull()
    expect(parseTargetId(null)).toBeNull()
    expect(parseTargetId('Likor')).toBeNull()
    expect(parseTargetId('https://www.torn.com/factions.php?step=profile&ID=123')).toBeNull()
  })
})

describe('watched factions and the approval gate', () => {
  it('⚠️ compares ids as strings, because Torn sends numbers and the DB sends text', () => {
    // A mixed-type lookup silently matches nothing, which here would mean an
    // own-faction target sailing straight onto the public list.
    expect(isWatchedFaction(10739, ['10739'])).toBe(true)
    expect(isWatchedFaction('10739', [10739])).toBe(true)
  })

  it('holds a target in a watched faction for leadership', () => {
    expect(initialState('10739', ['10739', '8103'])).toBe('pending_approval')
  })

  it('lets an unrelated target straight onto the list', () => {
    expect(initialState('99999', ['10739', '8103'])).toBe('active')
  })

  it('⚠️ treats an unfactioned target as unwatched, not as a match on null', () => {
    expect(isWatchedFaction(null, ['10739'])).toBe(false)
    expect(isWatchedFaction('', ['10739'])).toBe(false)
    expect(initialState(null, ['10739'])).toBe('active')
  })

  it('watches nothing when leadership has configured nothing', () => {
    expect(initialState('10739', [])).toBe('active')
  })
})

describe('visibility', () => {
  const leader = { memberId: '1', isLeadership: true }
  const author = { memberId: '7', isLeadership: false }
  const other = { memberId: '9', isLeadership: false }

  it('shows an active target to everyone', () => {
    const t = { state: 'active', added_by: '7' }
    expect(canSeeTarget(t, other)).toBe(true)
  })

  it('⚠️ keeps a pending target off the public list', () => {
    // Surfacing it while leadership decides is the exact outcome the gate
    // exists to prevent.
    const t = { state: 'pending_approval', added_by: '7' }
    expect(canSeeTarget(t, other)).toBe(false)
    expect(canSeeTarget(t, leader)).toBe(true)
  })

  it('still shows a pending target to whoever added it', () => {
    // Otherwise their submission appears to have vanished.
    const t = { state: 'pending_approval', added_by: '7' }
    expect(canSeeTarget(t, author)).toBe(true)
  })

  it('hides a rejected target from everyone but leadership', () => {
    const t = { state: 'rejected', added_by: '7' }
    expect(canSeeTarget(t, author)).toBe(false)
    expect(canSeeTarget(t, leader)).toBe(true)
  })
})

describe('who may change a grudge', () => {
  it('lets the author edit their own', () => {
    expect(canModifyEntry({ member_id: '7' }, { memberId: '7', isLeadership: false })).toBe(true)
  })

  it('lets leadership edit anyone’s', () => {
    expect(canModifyEntry({ member_id: '7' }, { memberId: '1', isLeadership: true })).toBe(true)
  })

  it('refuses an unrelated member', () => {
    expect(canModifyEntry({ member_id: '7' }, { memberId: '9', isLeadership: false })).toBe(false)
  })

  it('⚠️ compares member ids as strings', () => {
    expect(canModifyEntry({ member_id: 7 as any }, { memberId: '7', isLeadership: false })).toBe(true)
  })
})

describe('reason is mandatory', () => {
  it('refuses whitespace, which is how a required field gets bypassed', () => {
    expect(normaliseReason('   ')).toBeNull()
    expect(normaliseReason('\n\t')).toBeNull()
    expect(normaliseReason('')).toBeNull()
    expect(normaliseReason(null)).toBeNull()
  })

  it('keeps a real reason, trimmed', () => {
    expect(normaliseReason('  mugged me twice  ')).toBe('mugged me twice')
  })
})

describe('planStatusRefresh', () => {
  const t = (target_id: string, faction_id: string | null) => ({ target_id, faction_id })

  it('batches a faction holding several targets into one call', () => {
    const plan = planStatusRefresh([t('1', '100'), t('2', '100'), t('3', '100')])
    expect(plan.factions).toEqual(['100'])
    expect(plan.individuals).toEqual([])
  })

  it('⚠️ does NOT batch a faction holding exactly one target', () => {
    // Same single call either way, but the faction call drags back every other
    // member of that faction for nothing.
    const plan = planStatusRefresh([t('1', '100')])
    expect(plan.factions).toEqual([])
    expect(plan.individuals).toEqual(['1'])
  })

  it('⚠️ never batches unfactioned targets — there is no call that would', () => {
    const plan = planStatusRefresh([t('1', null), t('2', null), t('3', '')])
    expect(plan.factions).toEqual([])
    expect(plan.individuals.sort()).toEqual(['1', '2', '3'])
  })

  it('mixes the three cases the way a real list would', () => {
    const plan = planStatusRefresh([
      t('1', '100'), t('2', '100'),   // batched
      t('3', '200'),                   // alone in its faction
      t('4', null),                    // unfactioned
    ])
    expect(plan.factions).toEqual(['100'])
    expect(plan.individuals.sort()).toEqual(['3', '4'])
  })

  it('counts the saving, which is the whole reason for grouping', () => {
    const targets = [
      ...Array.from({ length: 20 }, (_, i) => t(`a${i}`, '100')),
      ...Array.from({ length: 15 }, (_, i) => t(`b${i}`, '200')),
      ...Array.from({ length: 5 }, (_, i) => t(`c${i}`, null)),
    ]
    const plan = planStatusRefresh(targets)
    // 40 targets in 7 calls rather than 40.
    expect(plan.factions.length + plan.individuals.length).toBe(7)
  })

  it('survives an empty list without inventing a call', () => {
    expect(planStatusRefresh([])).toEqual({ factions: [], individuals: [] })
  })
})

describe('departedFromFaction', () => {
  it('spots a target who is no longer in the faction we grouped them under', () => {
    expect(departedFromFaction(['1', '2', '3'], ['1', '3'])).toEqual(['2'])
  })

  it('⚠️ compares as strings — the API sends numbers, we store text', () => {
    expect(departedFromFaction(['1', '2'], [1, 2])).toEqual([])
  })

  it('reports everyone when a faction returns nothing', () => {
    expect(departedFromFaction(['1', '2'], [])).toEqual(['1', '2'])
  })
})
