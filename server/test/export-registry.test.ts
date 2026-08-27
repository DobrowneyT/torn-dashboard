// The registry IS the security model for #517, so these tests are about what
// is absent and who is refused as much as about what is present.
import { describe, expect, it } from 'vitest'
import {
  EXPORT_TABLES,
  canExport,
  exportableFor,
  lookupExportTable,
} from '../src/exportRegistry.js'

describe('the allowlist', () => {
  it('never exposes member_secrets, which holds API keys', () => {
    expect(lookupExportTable('member_secrets')).toBeNull()
  })

  it('rejects a table that merely exists in the schema', () => {
    expect(lookupExportTable('war_room_dibs_v2')).toBeNull()
    expect(lookupExportTable('faction_secrets')).toBeNull()
  })

  it('cannot be tricked through the prototype chain', () => {
    // `EXPORT_TABLES[name]` alone would hand back Object.prototype's method
    // for these, which is truthy and would reach the SQL builder.
    expect(lookupExportTable('constructor')).toBeNull()
    expect(lookupExportTable('toString')).toBeNull()
    expect(lookupExportTable('__proto__')).toBeNull()
  })

  it('rejects non-string names', () => {
    expect(lookupExportTable(undefined)).toBeNull()
    expect(lookupExportTable(['crimes'])).toBeNull()
  })

  it('resolves a listed table', () => {
    expect(lookupExportTable('faction_attacks')?.timeCol).toBe('started')
  })
})

describe('the time-column trap', () => {
  // The reason the registry declares timeCol AND timeType per table: the same
  // column NAME carries opposite meanings, and both exports look correct.
  it('filters crimes on Torn epochs, not on our write time', () => {
    expect(EXPORT_TABLES.crimes.timeCol).toBe('executed_at')
    expect(EXPORT_TABLES.crimes.timeType).toBe('epoch')
  })

  it('filters attacks on the attack, not on when we inserted the row', () => {
    expect(EXPORT_TABLES.faction_attacks.timeCol).toBe('started')
    expect(EXPORT_TABLES.faction_attacks.timeType).toBe('epoch')
    expect(EXPORT_TABLES.faction_attacks.timeCol).not.toBe('created_at')
  })

  it('declares every filter column of epoch type among its epoch columns', () => {
    for (const [name, spec] of Object.entries(EXPORT_TABLES)) {
      if (spec.timeType !== 'epoch') continue
      expect(spec.epochCols ?? [], name).toContain(spec.timeCol)
    }
  })

  it('never resolves names on a table that already stores them as-of-event', () => {
    // Joining `members` here would blank every opponent and rewrite history.
    expect(EXPORT_TABLES.faction_attacks.resolveNames ?? []).toEqual([])
    expect(EXPORT_TABLES.faction_revives.resolveNames ?? []).toEqual([])
  })
})

describe('role floors', () => {
  it('keeps personal member data at admin', () => {
    expect(canExport(EXPORT_TABLES.members.role, ['leadership'])).toBe(false)
    expect(canExport(EXPORT_TABLES.member_cpr_v2.role, ['leadership'])).toBe(false)
    expect(canExport(EXPORT_TABLES.members.role, ['admin'])).toBe(true)
  })

  it('lets admins take anything leadership can', () => {
    expect(canExport('leadership', ['admin'])).toBe(true)
    expect(canExport('warlead', ['admin'])).toBe(true)
  })

  it('does not treat ocmanager as a rung on the ladder', () => {
    // A role-ORDER comparison would quietly hand ocmanager leadership data.
    expect(canExport('leadership', ['ocmanager'])).toBe(false)
    expect(canExport('warlead', ['ocmanager'])).toBe(false)
  })

  it('refuses a plain member everything', () => {
    expect(exportableFor([])).toEqual([])
  })

  it('refuses visitors even when they somehow also carry leadership', () => {
    // Visitors are read-only OUTSIDERS. A bulk download is the thing they must
    // not have, however read-only it is.
    expect(canExport('leadership', ['leadership', 'visitor'])).toBe(false)
    expect(exportableFor(['visitor'])).toEqual([])
  })
})

describe('exportableFor', () => {
  it('gives leadership the Torn returns but not the roster', () => {
    const names = exportableFor(['leadership']).map((t) => t.table)
    expect(names).toContain('faction_attacks')
    expect(names).toContain('oc_payout_weeks')
    expect(names).not.toContain('members')
    expect(names).not.toContain('member_cpr_v2')
  })

  it('gives leadership the RW payout and war tables alongside the OC ones', () => {
    const names = exportableFor(['leadership']).map((t) => t.table)
    expect(names).toContain('war_payouts')
    expect(names).toContain('war_payout_members')
    expect(names).toContain('war_member_contributions')
    expect(names).toContain('ranked_wars')
    expect(names).toContain('crime_participation_v2')
  })

  it('keeps member_battle_stats at admin, not leadership', () => {
    expect(canExport(EXPORT_TABLES.member_battle_stats.role, ['leadership'])).toBe(false)
    expect(canExport(EXPORT_TABLES.member_battle_stats.role, ['admin'])).toBe(true)
  })

  it('describes each table well enough to pick the right one', () => {
    for (const entry of exportableFor(['admin'])) {
      expect(entry.label, entry.table).toBeTruthy()
      expect(entry.note, entry.table).toBeTruthy()
      expect(entry.timeCol, entry.table).toBeTruthy()
    }
  })
})
