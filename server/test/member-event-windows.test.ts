// Per-member Torn event start windows (#459).
//
// Two properties carry this job, and both are about consent rather than
// correctness:
//
//   1. It touches ONLY members who granted the scope.
//   2. It uses each member's OWN key. `/user/calendar` answers for the caller,
//      so a pooled key would report one person's hour under everyone's name —
//      a failure that produces perfectly plausible data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createTornClient } from '../src/scraper/tornClient.js'
import { memberEventWindowsJob } from '../src/scraper/jobs/memberEventWindows.js'

let stack: TestStack
const ENCRYPTION_KEY = 'd'.repeat(64)

const deps = () => ({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY }),
  client: createTornClient({ baseUrl: stack.tornBaseUrl, budget: { requests: 200, perMs: 1000 } }),
  encryptionKey: ENCRYPTION_KEY,
})

/** Each key gets its own start time, so a mixed-up key is visible in the data. */
const BY_KEY: Record<string, string> = {
  OPTEDIN1001AAAAA: '08:00 TCT',
  OPTEDIN1002BBBBB: '20:30 TCT',
  DECLINED1003CCCC: '03:00 TCT',
}
const seenKeys: string[] = []

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, is_current) VALUES
      ('1001', 'Early', true), ('1002', 'Late', true), ('1003', 'Private', true)
  `)
  const pool = createKeyPool({ db: stack.db, encryptionKey: ENCRYPTION_KEY })
  await pool.store('1001', 'OPTEDIN1001AAAAA', { consentVersion: 'v2' })
  await pool.store('1002', 'OPTEDIN1002BBBBB', { consentVersion: 'v2' })
  await pool.store('1003', 'DECLINED1003CCCC', { consentVersion: 'v2' })

  // 1001 and 1002 granted the calendar scope; 1003 has a key but did not.
  await stack.db.query(
    `UPDATE member_secrets SET calendar_scope_at = now(), calendar_scope_version = 'calendar-v1'
      WHERE member_id IN ('1001', '1002')`
  )

  stack.torn.setHandler('/v2/user/calendar', (url: URL) => {
    const key = url.searchParams.get('key') ?? ''
    seenKeys.push(key)
    const startTime = BY_KEY[key]
    return startTime ? { calendar: { start_time: startTime } } : { calendar: {} }
  })
}, 30000)

afterAll(async () => { await stack?.close() })

describe('member-event-windows job', () => {
  it('⚠️ calls Torn with each member\'s OWN key, not a pooled one', async () => {
    seenKeys.length = 0
    const result = await memberEventWindowsJob(deps())
    expect(result.rows).toBe(2)
    // Both scoped keys were used exactly once each — a pooled claim would have
    // used one key twice and reported its owner's hour for both members.
    expect(seenKeys.sort()).toEqual(['OPTEDIN1001AAAAA', 'OPTEDIN1002BBBBB'])
  })

  it('stores each member\'s own time', async () => {
    const rows = await stack.db.query('SELECT member_id, start_time FROM member_event_settings ORDER BY member_id')
    expect(rows.rows).toEqual([
      { member_id: '1001', start_time: '08:00 TCT' },
      { member_id: '1002', start_time: '20:30 TCT' },
    ])
  })

  it('⚠️ never touches a member who has a key but did not grant the scope', async () => {
    expect(seenKeys).not.toContain('DECLINED1003CCCC')
    const rows = await stack.db.query('SELECT * FROM member_event_settings WHERE member_id = $1', ['1003'])
    expect(rows.rowCount).toBe(0)
  })

  it('stores the string verbatim rather than parsing it on write', async () => {
    // A format change would otherwise be silently wrong for every member at
    // once, with no raw value left to re-read.
    const row = await stack.db.query('SELECT start_time FROM member_event_settings WHERE member_id = $1', ['1001'])
    expect(row.rows[0].start_time).toBe('08:00 TCT')
  })

  it('⚠️ removes the row when a member clears their start time in Torn', async () => {
    // No row, rather than a row saying "unknown". Both render as a dash, but
    // only one of them is something we are storing about a person.
    BY_KEY.OPTEDIN1001AAAAA = ''
    await memberEventWindowsJob(deps())
    const rows = await stack.db.query('SELECT * FROM member_event_settings WHERE member_id = $1', ['1001'])
    expect(rows.rowCount).toBe(0)
    BY_KEY.OPTEDIN1001AAAAA = '08:00 TCT'
  })

  it('⚠️ sweeps up data whose consent vanished by another route', async () => {
    // The withdrawal endpoint deletes immediately; this is the backstop for a
    // grant that disappeared with a removed key or a departed member, so
    // stored data never outlives its permission.
    await stack.db.query(`UPDATE member_secrets SET calendar_scope_at = NULL WHERE member_id = '1002'`)
    const result = await memberEventWindowsJob(deps())
    expect((result.details as any).orphans_removed).toBe(1)
    const rows = await stack.db.query('SELECT * FROM member_event_settings WHERE member_id = $1', ['1002'])
    expect(rows.rowCount).toBe(0)
  })

  it('does nothing at all when nobody has opted in', async () => {
    await stack.db.query('UPDATE member_secrets SET calendar_scope_at = NULL')
    seenKeys.length = 0
    const result = await memberEventWindowsJob(deps())
    expect(result.rows).toBe(0)
    expect(seenKeys).toEqual([])
    expect((result.details as any).note).toContain('opted into')
  })
})
