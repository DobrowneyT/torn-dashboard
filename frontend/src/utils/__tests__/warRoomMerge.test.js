// Delta merge ordering (#371) — the fix for enemies flickering in and out of
// hospital as they came out.
import { describe, it, expect } from 'vitest'
import { isAtLeastAsNew, mergeVersionedRows, liveRows } from '../warRoomMerge'

// Postgres renders the offset as a bare "-05", which Date.parse rejects — the
// #140 trap. parseDbTime handles it; these fixtures use the real shape so the
// guard is exercised against what actually arrives.
const at = (hhmmss) => `2026-08-08T${hhmmss}.000000-05`

const row = (id, state, updated) => ({
  member_id: id,
  updated_at: updated,
  state: { status: { state } },
})

describe('isAtLeastAsNew', () => {
  it('accepts anything into an empty slot', () => {
    expect(isAtLeastAsNew(row(1, 'Okay', at('12:00:00')), undefined)).toBe(true)
    expect(isAtLeastAsNew(row(1, 'Okay', at('12:00:00')), null)).toBe(true)
  })

  it('accepts a newer row', () => {
    expect(isAtLeastAsNew(row(1, 'Okay', at('12:00:01')), row(1, 'Hospital', at('12:00:00')))).toBe(true)
  })

  it('REJECTS an older row', () => {
    // The whole bug: a REST response in flight since before the write lands
    // after the socket frame and puts the member back in hospital.
    expect(isAtLeastAsNew(row(1, 'Hospital', at('12:00:00')), row(1, 'Okay', at('12:00:01')))).toBe(false)
  })

  it('accepts an equal timestamp', () => {
    // Re-sends are routine — the delta endpoint reads server_now before it
    // reads the rows, so its watermark always lags the data slightly. Dropping
    // equal timestamps would also discard a genuine same-millisecond update.
    const t = at('12:00:00')
    expect(isAtLeastAsNew(row(1, 'Okay', t), row(1, 'Okay', t))).toBe(true)
  })

  it('parses the bare Postgres offset rather than giving up on it', () => {
    // If this fell through to the unparseable path, the guard would accept
    // everything and the flicker would come straight back.
    expect(isAtLeastAsNew(
      { updated_at: '2026-08-08T12:00:00.000000-05' },
      { updated_at: '2026-08-08T12:00:05.000000-05' },
    )).toBe(false)
  })

  it('accepts when either side is unversioned', () => {
    // Falling back to the old arrival-order behaviour beats silently dropping
    // rows we cannot version.
    expect(isAtLeastAsNew({ updated_at: null }, row(1, 'Okay', at('12:00:00')))).toBe(true)
    expect(isAtLeastAsNew(row(1, 'Okay', at('12:00:00')), { updated_at: 'nonsense' })).toBe(true)
  })
})

describe('mergeVersionedRows', () => {
  it('applies rows in version order regardless of arrival order', () => {
    const map = new Map()
    mergeVersionedRows(map, [row(1, 'Okay', at('12:00:01'))], 'member_id')
    // The stale REST response lands second.
    mergeVersionedRows(map, [row(1, 'Hospital', at('12:00:00'))], 'member_id')
    expect(map.get(1).state.status.state).toBe('Okay')
  })

  it('reproduces the reported sequence and holds steady', () => {
    // Hospital → Okay over the socket, then the racing REST response, then the
    // next poll. Before #371 this read Okay, Hospital, Okay — the flicker.
    const map = new Map()
    mergeVersionedRows(map, [row(7, 'Hospital', at('12:00:00'))], 'member_id')
    mergeVersionedRows(map, [row(7, 'Okay', at('12:00:02'))], 'member_id')
    mergeVersionedRows(map, [row(7, 'Hospital', at('12:00:01'))], 'member_id')  // stale
    mergeVersionedRows(map, [row(7, 'Okay', at('12:00:03'))], 'member_id')
    expect(map.get(7).state.status.state).toBe('Okay')
  })

  it('keeps a tombstone in the map instead of deleting it', () => {
    // Deleting throws away the only thing that can reject a stale row for that
    // member.
    const map = new Map()
    mergeVersionedRows(map, [row(2, 'Okay', at('12:00:00'))], 'member_id')
    mergeVersionedRows(map, [{ member_id: 2, updated_at: at('12:00:01'), deleted_at: at('12:00:01') }], 'member_id')
    expect(map.has(2)).toBe(true)
    expect(liveRows(map)).toEqual([])
  })

  it('does not resurrect a tombstoned member from an in-flight response', () => {
    // The tombstone is written once, so a resurrected member would stay on the
    // board indefinitely with nothing to remove them again.
    const map = new Map()
    mergeVersionedRows(map, [{ member_id: 3, updated_at: at('12:00:05'), deleted_at: at('12:00:05') }], 'member_id')
    mergeVersionedRows(map, [row(3, 'Okay', at('12:00:04'))], 'member_id')
    expect(liveRows(map)).toEqual([])
  })

  it('still lets a genuine rejoin through', () => {
    // Undelete is a real event: the sync clears deleted_at when they come back.
    const map = new Map()
    mergeVersionedRows(map, [{ member_id: 4, updated_at: at('12:00:00'), deleted_at: at('12:00:00') }], 'member_id')
    mergeVersionedRows(map, [row(4, 'Okay', at('12:00:09'))], 'member_id')
    expect(liveRows(map)).toHaveLength(1)
  })

  it('merges by whichever key the channel uses', () => {
    const map = new Map()
    mergeVersionedRows(map, [{ target_id: 88, updated_at: at('12:00:00') }], 'target_id')
    expect(map.has(88)).toBe(true)
  })

  it('ignores rows with no key rather than storing them under undefined', () => {
    const map = new Map()
    mergeVersionedRows(map, [{ updated_at: at('12:00:00') }, null], 'member_id')
    expect(map.size).toBe(0)
  })

  it('tolerates an absent row list', () => {
    expect(mergeVersionedRows(new Map(), undefined, 'member_id').size).toBe(0)
    expect(mergeVersionedRows(new Map(), null, 'member_id').size).toBe(0)
  })
})
