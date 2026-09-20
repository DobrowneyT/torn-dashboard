// War Room per-member flags (#339).
import { describe, it, expect } from 'vitest'
import {
  REVIVE_EVERYONE, REVIVE_FRIENDS, REVIVE_NO_ONE,
  reviveAudience, isOverdosedAnySource, memberFlags,
} from '../warRoomFlags'

const keys = (member, opts) => memberFlags(member, opts).map(f => f.key)

describe('reviveAudience', () => {
  it('reports anyone when the member allows Everyone', () => {
    // The only case where a HIRED reviver actually works.
    expect(reviveAudience({ is_revivable: true, revive_setting: REVIVE_EVERYONE })).toBe('anyone')
  })

  it('reports friends when the member restricts to friends & faction', () => {
    // Revivable in Torn's sense, but not by anyone we can pay — the whole
    // reason the boolean alone is not enough.
    expect(reviveAudience({ is_revivable: true, revive_setting: REVIVE_FRIENDS })).toBe('friends')
  })

  it('reports nobody when the member has revives switched off', () => {
    expect(reviveAudience({ is_revivable: true, revive_setting: REVIVE_NO_ONE })).toBeNull()
  })

  it('reports nobody when the member is not revivable right now', () => {
    // is_revivable stays the gate — a permissive setting on someone who is not
    // currently revivable must not light the flag.
    expect(reviveAudience({ is_revivable: false, revive_setting: REVIVE_EVERYONE })).toBeNull()
    expect(reviveAudience({})).toBeNull()
    expect(reviveAudience(null)).toBeNull()
  })

  it('treats an unknown setting as revivable by anyone', () => {
    // Torn reports Unknown when it will not disclose the preference, which is
    // the normal case for an ENEMY — i.e. most of the roster. is_revivable is
    // already computed from our vantage point, so the revive is possible; only
    // the stated preference is missing. Muting these painted the whole enemy
    // roster grey and buried the real distinction (#342).
    expect(reviveAudience({ is_revivable: true, revive_setting: 'Unknown' })).toBe('anyone')
    expect(reviveAudience({ is_revivable: true, revive_setting: null })).toBe('anyone')
    expect(reviveAudience({ is_revivable: true })).toBe('anyone')
  })

  it('only mutes when Torn explicitly states the restriction', () => {
    // In practice that means our own members, whose real setting we can see.
    expect(reviveAudience({ is_revivable: true, revive_setting: REVIVE_FRIENDS })).toBe('friends')
    expect(reviveAudience({ is_revivable: true, revive_setting: 'Faction only' })).toBe('anyone')
  })
})

describe('isOverdosedAnySource', () => {
  const hospitalOd = { status_state: 'Hospital', status_details: 'Overdosed' }

  it('flags an overdose visible in the hospital status (#199)', () => {
    expect(isOverdosedAnySource(hospitalOd, null)).toBe(true)
  })

  it('flags an overdose visible only in the drug cooldown (#336)', () => {
    // Released from hospital, so the status signal is gone, but still out of
    // action — this is the gap the second detector exists to cover.
    const released = { status_state: 'Okay', status_details: '' }
    expect(isOverdosedAnySource(released, { cooldown_drug: 40_000 })).toBe(true)
  })

  it('does not flag a normal hospital stay or a normal dose', () => {
    expect(isOverdosedAnySource({ status_state: 'Hospital', status_details: 'Mugged' }, null)).toBe(false)
    expect(isOverdosedAnySource({ status_state: 'Okay' }, { cooldown_drug: 8 * 3600 })).toBe(false)
  })

  it('is false, never null, with no data on either side', () => {
    expect(isOverdosedAnySource(null, null)).toBe(false)
    expect(isOverdosedAnySource({}, {})).toBe(false)
  })
})

describe('memberFlags', () => {
  it('no longer emits the In OC flag', () => {
    // Removed in #339: being in an organised crime says nothing about whether
    // a member can be hit or revived, and it crowded the column.
    const flags = memberFlags({ is_in_oc: true })
    expect(flags).toEqual([])
    expect(keys({ is_in_oc: true, is_on_wall: true })).toEqual(['wall'])
  })

  it('emits flying, revivable, early discharge, overdose and wall', () => {
    const member = {
      is_revivable: true, revive_setting: REVIVE_EVERYONE,
      has_early_discharge: true, is_on_wall: true,
      status_state: 'Hospital', status_details: 'Overdosed',
    }
    expect(keys(member, { isFlying: true })).toEqual([
      'flying', 'revive-anyone', 'ed', 'od', 'wall',
    ])
  })

  it('distinguishes the two revivable states with different tooltips', () => {
    // Same glyph, different promise — the tooltip is what a lead checks before
    // paying a reviver, so the two must not read alike.
    const anyone = memberFlags({ is_revivable: true, revive_setting: REVIVE_EVERYONE })[0]
    const friends = memberFlags({ is_revivable: true, revive_setting: REVIVE_FRIENDS })[0]
    expect(anyone.key).toBe('revive-anyone')
    expect(friends.key).toBe('revive-friends')
    // The labels were trimmed to the fact itself (MonChoon, 2026-09-16) — the
    // glyph already implies a reviver is involved, so the sentence explaining
    // that was padding. What must survive is the RESTRICTION: paying an outside
    // reviver for a friends-only target buys nothing.
    expect(anyone.title).toBe('Revivable')
    expect(friends.title).toMatch(/friends & faction only/i)
    expect(friends.title).not.toBe(anyone.title)
    expect(anyone.tone).not.toBe(friends.tone)
  })

  it('emits no revive flag at all when revives are switched off', () => {
    expect(keys({ is_revivable: true, revive_setting: REVIVE_NO_ONE })).toEqual([])
  })

  it('returns an empty list for a member with nothing worth flagging', () => {
    expect(memberFlags({ is_revivable: false })).toEqual([])
    expect(memberFlags(null)).toEqual([])
  })

  it('puts the act-on-it flags first', () => {
    // Scan order: where they are and whether you can get them up, before the
    // flags that merely colour the picture.
    const member = {
      is_on_wall: true, has_early_discharge: true,
      is_revivable: true, revive_setting: REVIVE_EVERYONE,
    }
    const k = keys(member, { isFlying: true })
    expect(k.indexOf('flying')).toBeLessThan(k.indexOf('ed'))
    expect(k.indexOf('revive-anyone')).toBeLessThan(k.indexOf('wall'))
  })

  it('reads the overdose cooldown from stats, not the member row', () => {
    // Cooldowns are our-roster only (#336) and live in a separate table, so a
    // member row alone can never carry them.
    expect(keys({ status_state: 'Okay' }, { stats: { cooldown_drug: 40_000 } })).toEqual(['od'])
  })

  // #528 Part 2's loadout flag was removed from here (2026-08-23) — the
  // shield icon next to the member's name (LoadoutShieldIcon.test.jsx) is
  // the only place that observation renders now.
})
