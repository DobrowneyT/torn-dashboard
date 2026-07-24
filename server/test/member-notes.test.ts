// Per-member war notes (#199): war leads / leadership edit, all members read,
// visitors read-only. Black-box HTTP against the templated Postgres.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let warleadToken: string
let memberToken: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function api(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (7100, 'warlead')`)
  warleadToken = await loginAs('NOTELEAD7100XXXX', '7100')
  memberToken = await loginAs('NOTEMEMBER7200XX', '7200')
}, 30000)

afterAll(async () => { await stack?.close() })

describe('member notes (#199)', () => {
  it('a war lead writes a note; everyone can read it back', async () => {
    const put = await api('PUT', '/api/member-notes/501', warleadToken, { note: 'wears smurf armour, EU timezone' })
    expect(put.status).toBe(200)
    expect(put.body.note).toBe('wears smurf armour, EU timezone')

    // A plain member can read it (all notes + the single lookup).
    const all = await api('GET', '/api/member-notes', memberToken)
    expect(all.body.notes.find((n: any) => n.member_id === '501')?.note).toBe('wears smurf armour, EU timezone')
    const one = await api('GET', '/api/member-notes/501', memberToken)
    expect(one.body.note.note).toBe('wears smurf armour, EU timezone')
  })

  it('a plain member cannot write a note', async () => {
    expect((await api('PUT', '/api/member-notes/502', memberToken, { note: 'nope' })).status).toBe(403)
  })

  it('an empty note clears the row (icon disappears)', async () => {
    await api('PUT', '/api/member-notes/503', warleadToken, { note: 'temporary' })
    expect((await api('GET', '/api/member-notes/503', memberToken)).body.note.note).toBe('temporary')
    const clear = await api('PUT', '/api/member-notes/503', warleadToken, { note: '   ' })
    expect(clear.status).toBe(200)
    expect(clear.body.note).toBe('')
    // Gone from both the list and the single lookup.
    expect((await api('GET', '/api/member-notes/503', memberToken)).body.note).toBe(null)
    const all = await api('GET', '/api/member-notes', memberToken)
    expect(all.body.notes.find((n: any) => n.member_id === '503')).toBeUndefined()
  })

  it('rejects a non-numeric member id and an over-long note', async () => {
    expect((await api('PUT', '/api/member-notes/abc', warleadToken, { note: 'x' })).status).toBe(400)
    expect((await api('PUT', '/api/member-notes/504', warleadToken, { note: 'x'.repeat(2001) })).status).toBe(400)
  })
})
