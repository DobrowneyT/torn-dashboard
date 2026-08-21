// Backup helpers (#76 / slice 18) — the pure, deterministic pieces of the
// nightly dump job: per-faction DB discovery, archive naming, and 14-day
// retention selection. The pg_dump / psql / rclone shell-outs are exercised
// by the compose E2E against a real postgres:17 (embedded-postgres ships no
// pg_dump), not here.
import { describe, it, expect } from 'vitest'
import {
  factionDbsFromRows, backupName, parseBackup, selectExpired, remotePruneArgs, rcloneFlags, summarize,
  hasFreshBackup, remoteCleanupArgs,
} from '../backupLib.mjs'

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

// ── Deploy-day backup volume (#510) ─────────────────────────────────────────
//
// A quiet day is exactly 6 backups — one per faction DB. Deploy days measured
// 65, 70 and 95, because every deploy dumps all six TWICE: update.sh takes a
// pre-deploy archive, then the restarted sidecar dumps the lot again on start.
// The pre-deploy one is the rollback path and must always run; the sidecar's
// start-up run is the one that can stand down when the day is already covered.
describe('hasFreshBackup — the deploy-day double-dump (#510)', () => {
  const now = new Date('2026-08-19T12:00:00.000Z')

  it('is true when this faction already has an archive inside the window', () => {
    const names = [backupName('forge', new Date('2026-08-19T04:00:00Z'))] // 8h old
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(true)
  })

  it('is false once the newest archive falls outside the window', () => {
    const names = [backupName('forge', new Date('2026-08-18T04:00:00Z'))] // 32h old
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(false)
  })

  it('is false when this faction has no archive at all', () => {
    expect(hasFreshBackup([], 'forge', now, 20)).toBe(false)
  })

  it('⚠️ never lets one faction’s archive vouch for another’s', () => {
    // The failure that would matter: a new tenant silently never backed up
    // because its busier neighbour keeps the window warm.
    const names = [backupName('tnl', new Date('2026-08-19T04:00:00Z'))]
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(false)
  })

  it('⚠️ never confuses a slug with one that merely starts the same', () => {
    // faction_forge_dev parses to slug "forge_dev". If that satisfied "forge",
    // a staging archive would stand in for the production database's.
    const names = [backupName('forge_dev', new Date('2026-08-19T04:00:00Z'))]
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(false)
  })

  it('ignores files that are not our archives', () => {
    expect(hasFreshBackup(['notes.txt', 'faction_forge.sql'], 'forge', now, 20)).toBe(false)
  })

  it('judges on the NEWEST archive, not whichever is listed first', () => {
    const names = [
      backupName('forge', new Date('2026-08-01T04:00:00Z')), // ancient, listed first
      backupName('forge', new Date('2026-08-19T04:00:00Z')), // fresh
    ]
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(true)
  })

  it('treats an archive dated in the future as fresh, not as absent', () => {
    // Clock skew between the box and a restored volume should never cause an
    // extra dump — and must never read as a negative age that fails the check.
    const names = [backupName('forge', new Date('2026-08-19T18:00:00Z'))]
    expect(hasFreshBackup(names, 'forge', now, 20)).toBe(true)
  })
})

// ── Bounded rclone + honest summaries (B2 maintenance, 2026-08-12) ───────────
//
// A Backblaze maintenance window left `rclone copy` waiting indefinitely. It
// ran in the foreground of deploy/update.sh while that script held the deploy
// flock, so for over an hour every 5-minute auto-deploy logged "another update
// is already running" and skipped. The stack stopped updating with nothing
// anywhere reporting a problem.
describe('rcloneFlags', () => {
  it('bounds both the connection and the transfer', () => {
    const flags = rcloneFlags()
    expect(flags).toContain('--contimeout')
    expect(flags).toContain('--timeout')
    // Retries must be finite; rclone's default keeps trying long past useful.
    expect(flags).toContain('--retries')
  })

  it('pairs every flag with a value', () => {
    const flags = rcloneFlags()
    expect(flags.length % 2).toBe(0)
    for (let i = 0; i < flags.length; i += 2) {
      expect(flags[i].startsWith('--')).toBe(true)
      expect(flags[i + 1].startsWith('--')).toBe(false)
    }
  })
})

describe('summarize', () => {
  const base = { archived: 6, pruned: 2, retentionDays: 14, remote: 'b2:torn-dashboard-backups' }

  it('says so plainly when every upload landed', () => {
    const line = summarize({ ...base, uploadFailures: 0 })
    expect(line).toContain('6 archived')
    expect(line).toContain('6 uploaded')
    expect(line).not.toMatch(/FAILED/)
  })

  it('SHOUTS when the offsite copy did not happen', () => {
    // The failure mode this exists for: "6 archived" alone reads as success
    // while the only copy that survives losing the box never got made.
    const line = summarize({ ...base, uploadFailures: 6 })
    expect(line).toMatch(/UPLOAD\(S\) FAILED/)
    expect(line).toContain('local only')
  })

  it('flags a partial failure, not just a total one', () => {
    expect(summarize({ ...base, uploadFailures: 1 })).toMatch(/1 UPLOAD\(S\) FAILED/)
  })

  it('claims nothing about uploads when no remote is configured', () => {
    const line = summarize({ ...base, uploadFailures: 0, remote: undefined })
    expect(line).toContain('6 archived')
    expect(line).not.toMatch(/uploaded|FAILED/)
  })

  it('reports databases skipped as already covered (#510)', () => {
    const line = summarize({ ...base, archived: 0, uploadFailures: 0, skipped: 6 })
    expect(line).toContain('6 already fresh')
  })

  it('stays silent about skips when there were none', () => {
    expect(summarize({ ...base, uploadFailures: 0, skipped: 0 })).not.toMatch(/already fresh/)
  })
})

describe('remoteCleanupArgs — the hidden versions retention never removed (#510)', () => {
  it('purges old versions for the configured remote', () => {
    // 3 GiB of the 9.34 GiB billed was deleted files B2 still stored: the
    // 14-day prune removes the live version, B2 keeps a hidden one, and
    // nothing ever collected them.
    const args = remoteCleanupArgs('b2:torn-dashboard-backups')
    expect(args[0]).toBe('cleanup')
    expect(args[args.length - 1]).toBe('b2:torn-dashboard-backups')
  })
})
