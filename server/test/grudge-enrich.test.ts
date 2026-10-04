// Book of Grudges enrichment (#889, slice 4).
//
// The theme: this is the layer that turns a bare id into a person, and the
// ways it can lie are all quiet ones — a faction of 0, a rename recorded from
// a failed read, a gate decided once and never revisited.
import { describe, expect, it } from 'vitest'
import {
  readProfile, readFactionName, readFactionMembers, identityChanges, regateOnFactionChange,
} from '../src/grudgeEnrich.js'

const profile = (over: any = {}) => ({
  profile: {
    id: 2576356, name: 'Likor', level: 74, faction_id: 10739,
    status: { state: 'Hospital', until: 1759600000, description: 'In hospital for 2 hrs' },
    ...over,
  },
})

describe('readProfile', () => {
  it('reads name, level, faction and status', () => {
    expect(readProfile(profile())).toEqual({
      name: 'Likor', level: 74, factionId: '10739',
      statusState: 'Hospital', statusUntil: 1759600000,
      statusDescription: 'In hospital for 2 hrs',
    })
  })

  it('⚠️ reads Torn’s faction_id of 0 as NO faction', () => {
    // Storing '0' would group every unfactioned target under a faction that
    // does not exist, and the batched refresh would make a call for it.
    expect(readProfile(profile({ faction_id: 0 }))?.factionId).toBeNull()
  })

  it('⚠️ keeps status.until as Torn’s epoch SECONDS', () => {
    // Not every timestamp is a database timestamp. Treating this one as a
    // timestamptz, or running it through parseDbTime, lands it in 1970.
    expect(readProfile(profile())?.statusUntil).toBe(1759600000)
  })

  it('treats a status with no until as unknown, not as zero', () => {
    const r = readProfile(profile({ status: { state: 'Okay', until: 0 } }))
    expect(r?.statusState).toBe('Okay')
    expect(r?.statusUntil).toBeNull()
  })

  it('refuses a payload with no id rather than inventing a blank target', () => {
    expect(readProfile({ profile: { name: 'Nobody' } })).toBeNull()
    expect(readProfile(null)).toBeNull()
    expect(readProfile({})).toBeNull()
  })
})

describe('readFactionName', () => {
  it('reads the display name', () => {
    expect(readFactionName({ basic: { id: 10739, name: 'The Next Level' } })).toBe('The Next Level')
  })
  it('is null rather than empty when Torn says nothing', () => {
    expect(readFactionName({ basic: {} })).toBeNull()
    expect(readFactionName(null)).toBeNull()
  })
})

describe('readFactionMembers', () => {
  it('maps every member to their status in one read', () => {
    const m = readFactionMembers({
      members: [
        { id: 1, name: 'A', level: 10, status: { state: 'Okay', until: 0 } },
        { id: 2, name: 'B', level: 20, status: { state: 'Hospital', until: 1759600000 } },
      ],
    })
    expect(m.size).toBe(2)
    expect(m.get('2')?.statusState).toBe('Hospital')
    expect(m.get('2')?.statusUntil).toBe(1759600000)
  })

  it('⚠️ keys by STRING id, because that is what the column holds', () => {
    const m = readFactionMembers({ members: [{ id: 2576356, name: 'Likor' }] })
    expect(m.has('2576356')).toBe(true)
  })

  it('survives an empty or malformed response without throwing', () => {
    expect(readFactionMembers({ members: [] }).size).toBe(0)
    expect(readFactionMembers(null).size).toBe(0)
    expect(readFactionMembers({ members: [{ name: 'no id' }] }).size).toBe(0)
  })
})

describe('identityChanges', () => {
  const before = { target_name: 'Likor', faction_id: '10739' }

  it('records a rename, which is what the history view shows', () => {
    const c = identityChanges(before, readProfile(profile({ name: 'LikorTwo' }))!)
    expect(c).toEqual([{ field: 'target_name', from: 'Likor', to: 'LikorTwo' }])
  })

  it('records a faction move', () => {
    const c = identityChanges(before, readProfile(profile({ faction_id: 8103 }))!)
    expect(c).toEqual([{ field: 'faction_id', from: '10739', to: '8103' }])
  })

  it('records leaving a faction entirely', () => {
    const c = identityChanges(before, readProfile(profile({ faction_id: 0 }))!)
    expect(c).toEqual([{ field: 'faction_id', from: '10739', to: null }])
  })

  it('⚠️ reports NOTHING when nothing changed', () => {
    // The refresh runs constantly. A compare that is wrong in the "always
    // changed" direction writes an audit row every sweep and buries the three
    // events the trail exists for.
    expect(identityChanges(before, readProfile(profile())!)).toEqual([])
  })

  it('⚠️ compares faction ids as strings', () => {
    // Torn sends a number, the column is text. A mixed-type compare reports a
    // change on every single refresh.
    expect(identityChanges({ target_name: 'Likor', faction_id: '10739' },
      readProfile(profile({ faction_id: 10739 }))!)).toEqual([])
  })

  it('⚠️ never records a rename from a read that returned no name', () => {
    // A failed read is "Torn did not say", not "they are now called nothing".
    // A lie in a record whose entire value is that it is not one.
    const c = identityChanges(before, { ...readProfile(profile())!, name: null })
    expect(c.find((x) => x.field === 'target_name')).toBeUndefined()
  })
})

describe('regateOnFactionChange', () => {
  const watched = (id: string | null) => id === '10739'

  it('⚠️ sends an active target back to pending when they join a watched faction', () => {
    // The gate cannot be decided once at add time: a target's faction is only
    // known after a lookup, and it can change afterwards.
    expect(regateOnFactionChange(
      { state: 'active', faction_id: '99999' }, '10739', watched
    )).toBe('pending_approval')
  })

  it('leaves a target alone when the new faction is not watched', () => {
    expect(regateOnFactionChange(
      { state: 'active', faction_id: '99999' }, '8888', watched
    )).toBeNull()
  })

  it('⚠️ does NOT re-gate somebody leadership already approved in that faction', () => {
    // They were in the watched faction when approved; approving was a
    // decision, and re-raising it every sweep would nag leadership forever.
    expect(regateOnFactionChange(
      { state: 'active', faction_id: '10739' }, '10739', watched
    )).toBeNull()
  })

  it('⚠️ never moves a target OUT of pending or rejected', () => {
    // Un-approving on a sweep would undo a human decision without asking.
    expect(regateOnFactionChange(
      { state: 'pending_approval', faction_id: '10739' }, '99999', watched
    )).toBeNull()
    expect(regateOnFactionChange(
      { state: 'rejected', faction_id: '10739' }, '99999', watched
    )).toBeNull()
  })

  it('treats leaving all factions as not watched', () => {
    expect(regateOnFactionChange(
      { state: 'active', faction_id: '10739' }, null, watched
    )).toBeNull()
  })
})
