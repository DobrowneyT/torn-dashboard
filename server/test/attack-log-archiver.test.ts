// The attack-log archive (#973), against real Postgres and a fake Torn.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, TEST_KEY_ENCRYPTION_KEY, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { createAttackLogArchiver } from '../src/events/attackLogArchiver.js'

let stack: TestStack
const US = Number(TEST_FACTION.tornFactionId)
const HOUR = 3_600_000
let clock: number
let calls: Array<{ code: string; key: string }>
// What Torn answers for a given log code.
let answer: (code: string) => unknown

const logBody = (code: string, lines = 3) => ({
  attacklog: {
    log: Array.from({ length: lines }, (_, i) => ({ text: `${code} line ${i}`, timestamp: 1, action: 'hit' })),
    summary: [],
  },
  _metadata: { links: { prev: null, next: null } },
})

let seq = 1
function attack(o: { at?: number; incoming?: boolean; faction?: number; code?: string | null } = {}) {
  const id = seq++
  return stack.db.query(
    `INSERT INTO faction_attacks (attack_id, code, started, attacker_id, attacker_faction_id, defender_id, defender_faction_id, result, is_incoming)
     VALUES ($1, $2, $3, 1, $4, 50, $5, 'Mugged', $6) RETURNING attack_id`,
    [id, o.code === undefined ? `code${id}` : o.code, Math.floor((o.at ?? clock - HOUR) / 1000),
      o.incoming ? 999 : (o.faction ?? US), o.incoming ? US : 777, !!o.incoming],
  ).then((r) => Number(r.rows[0].attack_id))
}

async function event(over: { start?: number; ended?: number | null } = {}) {
  const r = await stack.db.query(
    `INSERT INTO faction_events (name, starts_at, daily_from, min_ends_at, ended_at)
     VALUES ('Halloween', to_timestamp($1 / 1000.0), to_timestamp($1 / 1000.0), to_timestamp($2 / 1000.0),
             to_timestamp($3 / 1000.0)) RETURNING id`,
    [over.start ?? clock - 2 * HOUR, clock + 24 * HOUR, over.ended ?? null])
  return Number(r.rows[0].id)
}

const archiver = () => createAttackLogArchiver({
  db: stack.db,
  pool: createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY }),
  tornBaseUrl: stack.tornBaseUrl,
  now: () => clock,
})
const logs = async () => (await stack.db.query('SELECT * FROM event_attack_logs ORDER BY attack_id')).rows
const state = async (id: number) =>
  (await stack.db.query('SELECT * FROM event_attack_log_state WHERE event_id = $1', [id])).rows[0]

async function keys(n: number) {
  const pool = createKeyPool({ db: stack.db, encryptionKey: TEST_KEY_ENCRYPTION_KEY })
  for (let i = 0; i < n; i++) {
    const id = String(6000 + i)
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, is_current) VALUES ($1, $2, true) ON CONFLICT (member_id) DO NOTHING`,
      [id, `m${id}`])
    await pool.store(id, `ARCHIVEKEY${id}XXXXX`, { consentVersion: 'v2' })
  }
}

beforeAll(async () => {
  stack = await startTestStack()
  stack.torn.setHandler('/v2/torn/attacklog', (url) => {
    const code = url.searchParams.get('log') ?? ''
    calls.push({ code, key: url.searchParams.get('key') ?? '' })
    return answer(code)
  })
}, 30_000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => {
  clock = Date.UTC(2026, 9, 26, 12)
  calls = []
  answer = (code) => logBody(code)
  await stack.db.query('DELETE FROM faction_events')
  await stack.db.query('DELETE FROM faction_attacks')
  await stack.db.query('DELETE FROM member_secrets')
  await keys(1)
})

describe('what is due', () => {
  it('⚠️ archives every event attack, outgoing AND incoming, raw', async () => {
    const id = await event()
    const out = await attack()
    const inc = await attack({ incoming: true })
    expect((await archiver().runOnce()).archived).toBe(2)
    const rows = await logs()
    expect(rows.map((r) => Number(r.attack_id))).toEqual([out, inc])
    expect(rows[0].status).toBe('archived')
    expect(Number(rows[0].event_id)).toBe(id)
    // Unparsed: Torn's own body, kept whole.
    expect(rows[0].raw.pages[0].attacklog.log[0].text).toBe(`code${out} line 0`)
    expect(rows[0].lines).toBe(3)
  })

  it('skips attacks outside the event, other factions\' attacks, and attacks without a code', async () => {
    await event()
    await attack({ at: clock - 3 * HOUR })
    await attack({ faction: 4242 })
    await attack({ code: null })
    expect((await archiver().runOnce()).due).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('makes no call with no event', async () => {
    await attack()
    expect((await archiver().runOnce()).events).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('⚠️ resumes from what is missing — an archived log is never fetched twice', async () => {
    await event()
    await attack()
    const a = archiver()
    await a.runOnce()
    await attack()
    clock += 120_000
    await a.runOnce()
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((c) => c.code)).size).toBe(2)
  })

  it('keeps collecting an ended event\'s stragglers for a while', async () => {
    await event({ start: clock - 48 * HOUR, ended: clock - 24 * HOUR })
    await attack({ at: clock - 30 * HOUR })
    expect((await archiver().runOnce()).archived).toBe(1)
  })
})

describe('⚠️ key courtesy limit', () => {
  it('never takes more than 10 calls a minute from one key', async () => {
    const id = await event()
    for (let i = 0; i < 25; i++) await attack()
    const a = archiver()
    expect((await a.runOnce()).archived).toBe(10)
    clock += 15_000
    expect((await a.runOnce()).archived).toBe(0)
    clock += 60_000
    expect((await a.runOnce()).archived).toBe(10)
    expect(Number((await state(id)).backlog)).toBe(5)
  })

  it('spreads the work across keys', async () => {
    await stack.db.query('DELETE FROM member_secrets')
    await keys(3)
    await event()
    for (let i = 0; i < 25; i++) await attack()
    expect((await archiver().runOnce()).archived).toBe(25)
    const perKey = new Map<string, number>()
    for (const c of calls) perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1)
    expect(Math.max(...perKey.values())).toBeLessThanOrEqual(10)
    expect(perKey.size).toBe(3)
  })
})

describe('failures', () => {
  it('⚠️ marks an expired log gone and never asks again', async () => {
    await event()
    await attack()
    answer = () => ({ error: { code: 28, error: 'Incorrect log ID' } })
    const a = archiver()
    expect((await a.runOnce()).gone).toBe(1)
    clock += 2 * HOUR
    await a.runOnce()
    expect(calls).toHaveLength(1)
    expect((await logs())[0].status).toBe('gone')
  })

  it('⚠️ an outage stops the run and leaves everything due', async () => {
    const id = await event()
    await attack(); await attack()
    answer = () => ({ error: { code: 9, error: 'API disabled' } })
    const a = archiver()
    expect((await a.runOnce()).outage).toBe(true)
    expect(await logs()).toEqual([])
    expect((await state(id)).last_error).toMatch(/9/)
    answer = (code) => logBody(code)
    clock += 120_000
    expect((await a.runOnce()).archived).toBe(2)
  })

  it('retries an odd failure later, not straight away', async () => {
    await event()
    await attack()
    let n = 0
    answer = (code) => (n++ === 0 ? { nonsense: true, error: { code: 99, error: 'odd' } } : logBody(code))
    const a = archiver()
    expect((await a.runOnce()).failed).toBe(1)
    clock += 60_000
    expect((await a.runOnce()).archived).toBe(0)
  })

  it('disables a key Torn rejects', async () => {
    await event()
    await attack()
    answer = () => ({ error: { code: 2, error: 'Incorrect key' } })
    await archiver().runOnce()
    const k = (await stack.db.query(`SELECT disabled FROM member_secrets`)).rows[0]
    expect(k.disabled).toBe(true)
  })

  it('records an empty pool', async () => {
    const id = await event()
    await attack()
    await stack.db.query('DELETE FROM member_secrets')
    await archiver().runOnce()
    expect((await state(id)).last_error).toMatch(/no pooled key/)
    expect(Number((await state(id)).backlog)).toBe(1)
  })
})

describe('⚠️ a growing backlog is reported, not silent', () => {
  it('stamps growing_since when the backlog keeps climbing', async () => {
    const id = await event()
    await stack.db.query('DELETE FROM member_secrets')
    const a = archiver()
    for (let step = 0; step < 4; step++) {
      for (let i = 0; i < 5; i++) await attack()
      await a.runOnce()
      clock += 3 * 60_000
    }
    expect((await state(id)).growing_since).not.toBeNull()
  })
})
