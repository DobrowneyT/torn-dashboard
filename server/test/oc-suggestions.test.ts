// #1020 — the OC action feed: lifecycle and the bot's routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { deriveTenantToken } from '../src/fleetMetricsAuth.js'
import { chainWatchScope } from '../../db/chainWatchTokenLib.mjs'
import { reportSuggestions, housekeep, type SuggestionInput } from '../src/ocSuggestions.js'

const TOKEN = deriveTenantToken('chain-watch-secret-for-tests', chainWatchScope(TEST_FACTION.slug))
let stack: TestStack

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const feed = async () => (await call('GET', '/api/internal/oc-watch')).body
const swap = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  key: 'swap:9001:7001-7002', kind: 'swap', crimeId: '9001', memberIds: ['7001', '7002'],
  title: 'Swap two seats', body: '+6.1% success', steps: ['Bob → free seat', 'Alice → Hacker', 'Bob → Picklock'],
  value: { success_pp: 6.1 }, ...over,
})
const row = async () => (await stack.db.query(`SELECT * FROM oc_suggestions WHERE key = 'swap:9001:7001-7002'`)).rows[0]

beforeAll(async () => { stack = await startTestStack(undefined, {}, { chainWatchToken: TOKEN }) }, 60000)
afterAll(async () => { await stack?.close() })
beforeEach(async () => { await stack.db.query('DELETE FROM oc_suggestions') })

describe('lifecycle', () => {
  it('opens once, and a repeat with the same content is not a new message or a new version', async () => {
    expect(await reportSuggestions(stack.db, 'swap', [swap()])).toMatchObject({ opened: 1 })
    await reportSuggestions(stack.db, 'swap', [swap()])
    expect((await stack.db.query('SELECT count(*)::int AS n FROM oc_suggestions')).rows[0].n).toBe(1)
    expect((await row()).version).toBe(1)
  })

  it('changed content bumps the version so the bot edits', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    await reportSuggestions(stack.db, 'swap', [swap({ body: '+7.0% success' })])
    expect((await row()).version).toBe(2)
  })

  it('gone from the live set: resolved when seen happening, expired otherwise', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    await reportSuggestions(stack.db, 'swap', [], new Set(['swap:9001:7001-7002']))
    expect(await row()).toMatchObject({ status: 'resolved', close_reason: 'Seen happening' })
    await stack.db.query('DELETE FROM oc_suggestions')
    await reportSuggestions(stack.db, 'swap', [swap()])
    await reportSuggestions(stack.db, 'swap', [])
    expect((await row()).status).toBe('expired')
  })

  it('a closed one coming back is a fresh message; a done one never comes back', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    await stack.db.query(`UPDATE oc_suggestions SET message_id = '555', rendered_version = version`)
    await reportSuggestions(stack.db, 'swap', [])
    await reportSuggestions(stack.db, 'swap', [swap()])
    expect(await row()).toMatchObject({ status: 'open', message_id: null, rendered_version: 0 })

    await stack.db.query(`UPDATE oc_suggestions SET status = 'done'`)
    await reportSuggestions(stack.db, 'swap', [swap({ body: 'changed' })])
    expect(await row()).toMatchObject({ status: 'done', body: '+6.1% success' })
  })

  it('other kinds are left alone', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    await reportSuggestions(stack.db, 'too_low', [])
    expect((await row()).status).toBe('open')
  })

  it('expires on time, and a snooze wakes up', async () => {
    await reportSuggestions(stack.db, 'swap', [swap({ expiresAt: Date.now() - 1000 })])
    await housekeep(stack.db)
    expect(await row()).toMatchObject({ status: 'expired', close_reason: 'Ran out of time' })
    await stack.db.query('DELETE FROM oc_suggestions')
    await reportSuggestions(stack.db, 'swap', [swap()])
    await stack.db.query(`UPDATE oc_suggestions SET status = 'snoozed', snoozed_until = now() - interval '1 minute'`)
    await housekeep(stack.db)
    expect(await row()).toMatchObject({ status: 'open', snoozed_until: null })
  })
})

describe('the bot\'s routes', () => {
  it('the feed carries what needs drawing and the ping list; drawing it clears it', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    let f = await feed()
    expect(f.ping_member_ids).toEqual(['2250591'])
    expect(f.findings).toHaveLength(1)
    const s = f.findings[0]
    expect(s).toMatchObject({ kind: 'swap', status: 'open', version: 1, message_id: null, steps: ['Bob → free seat', 'Alice → Hacker', 'Bob → Picklock'] })
    expect((await call('POST', `/api/internal/oc-watch/suggestions/${s.id}/rendered`, { version: 1, message_id: '777', channel_id: '42' })).status).toBe(200)
    f = await feed()
    expect(f.findings).toEqual([])
    expect(await row()).toMatchObject({ message_id: '777', channel_id: '42' })
    expect((await row()).posted_at).not.toBeNull()
  })

  it('Done and Not now record who, and come back for a redraw', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    const id = (await row()).id
    await call('POST', `/api/internal/oc-watch/suggestions/${id}/rendered`, { version: 1, message_id: '777' })
    const snoozed = await call('POST', `/api/internal/oc-watch/suggestions/${id}/act`, { action: 'snooze', by: 'MonChoon', minutes: 30 })
    expect(snoozed.body.suggestion).toMatchObject({ status: 'snoozed', acted_by: 'MonChoon', version: 2 })
    expect((await feed()).findings[0]).toMatchObject({ status: 'snoozed' })
    const done = await call('POST', `/api/internal/oc-watch/suggestions/${id}/act`, { action: 'done', by: 'MonChoon' })
    expect(done.body.suggestion).toMatchObject({ status: 'done', close_reason: 'Marked done' })
    // Twice is refused rather than re-recorded.
    expect((await call('POST', `/api/internal/oc-watch/suggestions/${id}/act`, { action: 'done', by: 'x' })).status).toBe(409)
  })

  it('a test suggestion can be sent, and stats count per kind', async () => {
    await call('POST', '/api/internal/oc-watch/suggestions/test', { by: 'MonChoon' })
    await call('POST', '/api/internal/oc-watch/suggestions/test', { by: 'MonChoon' })
    const tests = (await stack.db.query(`SELECT status FROM oc_suggestions WHERE kind = 'test' ORDER BY id`)).rows.map((r: any) => r.status)
    // The second replaces the first, which expires rather than piling up.
    expect(tests).toEqual(['expired', 'open'])
    const stats = (await call('GET', '/api/internal/oc-watch/suggestions/stats')).body.stats
    expect(stats.test).toMatchObject({ open: 1, expired: 1 })
  })

  it('every route needs the token', async () => {
    for (const [m, p] of [['POST', '/api/internal/oc-watch/suggestions/1/act'], ['GET', '/api/internal/oc-watch/suggestions/stats']]) {
      const res = await fetch(`${stack.baseUrl}${p}`, { method: m })
      expect(res.status).toBe(401)
    }
  })

  it('a closed suggestion whose message the bot deleted forgets the message', async () => {
    await reportSuggestions(stack.db, 'swap', [swap()])
    const id = (await row()).id
    await call('POST', `/api/internal/oc-watch/suggestions/${id}/rendered`, { version: 1, message_id: '777' })
    await reportSuggestions(stack.db, 'swap', [])
    const v = (await row()).version
    await call('POST', `/api/internal/oc-watch/suggestions/${id}/rendered`, { version: v, deleted: true })
    expect(await row()).toMatchObject({ status: 'expired', message_id: null })
    expect((await feed()).findings).toEqual([])
  })
})

