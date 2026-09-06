// #609 slice 1 — the tenant's read-only view of the shared `global` database.
//
// The theme throughout: an unreachable control plane is an EXPECTED state, not
// an error. The #608 audit chose "tenants read `global` directly" precisely so
// that killing the admin container cannot take a tenant down, and these tests
// are what hold that promise to account.
import { describe, expect, it } from 'vitest'
import { readFleetMeta, itemsAreFresh, ITEMS_STALE_AFTER_MS } from '../src/globalDb.js'

const pool = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as any
const failing = () => ({ query: async () => { throw new Error('ECONNREFUSED') } }) as any

// ⚠️ ISO STRINGS, not Date objects, and the change is a correction rather than
// a preference. This fake used to hand back `Date`s, which node-pg does not
// produce in this process — `src/db.ts` installs a process-wide timestamptz
// parser for PostgREST compatibility, so the column really arrived as
// `2026-09-05T07:00:00-05`, which `new Date()` rejects. readFleetMeta then
// threw inside its own `catch { return null }` and every tenant would have read
// the control plane as permanently unavailable the moment `items_synced_at`
// became non-null (#609 slice 7 is the first thing that writes it).
//
// readFleetMeta now formats these columns as UTC ISO text in SQL, so this is
// what the query returns. The end-to-end proof, against a real connection with
// the parser installed, lives in fleet-items.test.ts — a fake cannot catch a
// bug that is about what the driver actually does.
const META = {
  schema_version: 1,
  oc_model_version: '2026.09.05',
  oc_model_built_at: '2026-09-05T10:00:00.000Z',
  items_synced_at: '2026-09-05T12:00:00.000Z',
}

describe('readFleetMeta', () => {
  it('reads the singleton row', async () => {
    const meta = await readFleetMeta(pool([META]))
    expect(meta).toMatchObject({ schemaVersion: 1, ocModelVersion: '2026.09.05' })
    expect(meta?.itemsSyncedAt).toBe('2026-09-05T12:00:00.000Z')
  })

  it('⚠️ returns null instead of throwing when global is unreachable', async () => {
    // The single most important behaviour in this module. A throw here would
    // propagate into /api/health/ready and turn "the control plane is down" —
    // which the architecture guarantees is survivable — into a tenant outage.
    await expect(readFleetMeta(failing())).resolves.toBeNull()
  })

  it('returns null when the tenant has no global connection at all', async () => {
    // A tenant deployed before the control plane existed, or one deliberately
    // running without it. Not an error state.
    await expect(readFleetMeta(undefined)).resolves.toBeNull()
  })

  it('returns null for an empty global database rather than inventing a row', async () => {
    await expect(readFleetMeta(pool([]))).resolves.toBeNull()
  })

  it('keeps a never-published model distinguishable from version zero', async () => {
    // NULL means "no model has been published"; it must not read as a version.
    const meta = await readFleetMeta(pool([{ ...META, oc_model_version: null, oc_model_built_at: null }]))
    expect(meta?.ocModelVersion).toBeNull()
    expect(meta?.ocModelBuiltAt).toBeNull()
  })
})

describe('itemsAreFresh', () => {
  const at = (iso: string) => ({ schemaVersion: 1, ocModelVersion: null, ocModelBuiltAt: null, itemsSyncedAt: iso })
  const NOW = Date.parse('2026-09-05T12:00:00Z')

  it('trusts a recent sync', () => {
    expect(itemsAreFresh(at('2026-09-05T11:00:00Z'), NOW)).toBe(true)
  })

  it('⚠️ refuses prices past the staleness window', () => {
    // Centralising items-sync trades five-fold pool redundancy for one key.
    // When that key dies the prices do not error — they just stop moving, and
    // every faction keeps valuing payouts off them. Refusing is what makes the
    // failure loud (see #123/#124 for how long a silent decay runs).
    expect(itemsAreFresh(at('2026-09-05T05:00:00Z'), NOW)).toBe(false)
  })

  it('⚠️ treats "never synced" as stale, not as fresh', () => {
    // NULL and "synced long ago" are the same answer to the only question that
    // matters — may I price a payout with this? Defaulting the unknown case to
    // yes is exactly how a silent mis-valuation happens (the #351 rule).
    expect(itemsAreFresh({ schemaVersion: 1, ocModelVersion: null, ocModelBuiltAt: null, itemsSyncedAt: null }, NOW)).toBe(false)
  })

  it('treats an unreachable control plane as stale', () => {
    expect(itemsAreFresh(null, NOW)).toBe(false)
  })

  it('refuses an unparseable timestamp rather than coercing it', () => {
    expect(itemsAreFresh(at('not a date'), NOW)).toBe(false)
  })

  it('is exactly at the boundary, not one side of it by accident', () => {
    const boundary = new Date(NOW - ITEMS_STALE_AFTER_MS).toISOString()
    expect(itemsAreFresh(at(boundary), NOW)).toBe(true)
    expect(itemsAreFresh(at(new Date(NOW - ITEMS_STALE_AFTER_MS - 1).toISOString()), NOW)).toBe(false)
  })
})
