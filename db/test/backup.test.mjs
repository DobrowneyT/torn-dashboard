// Backup helpers (#76 / slice 18) — the pure, deterministic pieces of the
// nightly dump job: per-faction DB discovery, archive naming, and 14-day
// retention selection. The pg_dump / psql / rclone shell-outs are exercised
// by the compose E2E against a real postgres:17 (embedded-postgres ships no
// pg_dump), not here.
import { describe, it, expect } from 'vitest'
import { factionDbsFromRows, backupName, parseBackup, selectExpired, remotePruneArgs } from '../backupLib.mjs'

describe('factionDbsFromRows', () => {
  it('keeps only faction_* databases and derives the slug', () => {
    const rows = [
      { datname: 'postgres' }, { datname: 'template1' },
      { datname: 'faction_forge' }, { datname: 'faction_tnl' },
    ]
    expect(factionDbsFromRows(rows)).toEqual([
      { db: 'faction_forge', slug: 'forge' },
      { db: 'faction_tnl', slug: 'tnl' },
    ])
  })
})

describe('backupName / parseBackup', () => {
  it('names an archive per faction and UTC instant, and round-trips', () => {
    const at = new Date('2026-07-12T13:15:00.000Z')
    const name = backupName('forge', at)
    expect(name).toBe('faction_forge_20260712T131500Z.sql.gz')
    const parsed = parseBackup(name)
    expect(parsed.slug).toBe('forge')
    expect(parsed.at.toISOString()).toBe('2026-07-12T13:15:00.000Z')
  })

  it('returns null time for names that are not backup archives', () => {
    expect(parseBackup('not-a-backup.txt').at).toBeNull()
  })
})

describe('remotePruneArgs — remote retention is scoped to OUR archives (#117)', () => {
  it('deletes only past-retention faction archives, never other files in the remote', () => {
    const args = remotePruneArgs('b2:tnl-backups', 14)
    expect(args[0]).toBe('delete')
    expect(args[args.length - 1]).toBe('b2:tnl-backups')
    // Retention window: rclone's --min-age selects files OLDER than the age.
    expect(args).toContain('--min-age')
    expect(args[args.indexOf('--min-age') + 1]).toBe('14d')
    // The safety scope: a shared or dirty bucket path must never lose foreign
    // files to our prune — only names shaped like our archives qualify.
    expect(args).toContain('--include')
    expect(args[args.indexOf('--include') + 1]).toBe('faction_*.sql.gz')
  })
})

describe('selectExpired — 14-day retention', () => {
  const now = new Date('2026-07-12T00:00:00.000Z')
  it('selects archives older than the retention window, keeps the rest', () => {
    const names = [
      backupName('forge', new Date('2026-07-11T00:00:00Z')), // 1 day — keep
      backupName('forge', new Date('2026-06-28T00:00:00Z')), // 14 days — keep (boundary)
      backupName('forge', new Date('2026-06-27T00:00:00Z')), // 15 days — prune
      'keep-me.txt', // not an archive — never touched
    ]
    const expired = selectExpired(names, now, 14)
    expect(expired).toEqual([backupName('forge', new Date('2026-06-27T00:00:00Z'))])
  })
})
