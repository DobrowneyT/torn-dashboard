// Branding uploads (#173): base64 → bytea in the tenant DB, served back
// publicly; branding.<kind> repointed at the served path. Black-box HTTP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let leadershipToken: string
let memberToken: string

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (8100, 'leadership')`)
  leadershipToken = await loginAs('BRANDLEAD8100XXX', '8100')
  memberToken = await loginAs('BRANDMEMBER8200X', '8200')
}, 30000)

afterAll(async () => { await stack?.close() })

describe('branding uploads (#173)', () => {
  it('leadership uploads a logo; it serves back with its content-type; branding points at it', async () => {
    const put = await api('PUT', '/api/admin/branding/logo', leadershipToken, { content_type: 'image/png', data_base64: PNG })
    expect(put.status).toBe(200)
    expect(put.body.url).toMatch(/^\/api\/branding\/logo\?v=\d+$/)

    // Served back publicly (no auth), with the right content-type + the bytes.
    const res = await fetch(`${stack.baseUrl}/api/branding/logo`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(Buffer.from(PNG, 'base64').length)

    // branding.logo now points at the served path.
    const cfg = await stack.db.query(`SELECT branding->>'logo' AS logo FROM faction_config LIMIT 1`)
    expect(cfg.rows[0].logo).toMatch(/^\/api\/branding\/logo/)
  })

  it('accepts a data: URL and favicon .ico', async () => {
    const put = await api('PUT', '/api/admin/branding/favicon', leadershipToken, {
      content_type: 'image/x-icon', data_base64: `data:image/x-icon;base64,${PNG}`,
    })
    expect(put.status).toBe(200)
    expect((await fetch(`${stack.baseUrl}/api/branding/favicon`)).status).toBe(200)
  })

  it('rejects a disallowed type, an unknown kind, and a non-leadership uploader', async () => {
    expect((await api('PUT', '/api/admin/branding/logo', leadershipToken, { content_type: 'application/pdf', data_base64: PNG })).status).toBe(400)
    expect((await api('PUT', '/api/admin/branding/bogus', leadershipToken, { content_type: 'image/png', data_base64: PNG })).status).toBe(404)
    expect((await api('PUT', '/api/admin/branding/logo', memberToken, { content_type: 'image/png', data_base64: PNG })).status).toBe(403)
    // favicon type list is stricter — a jpeg is fine for logo but not favicon.
    expect((await api('PUT', '/api/admin/branding/favicon', leadershipToken, { content_type: 'image/jpeg', data_base64: PNG })).status).toBe(400)
  })

  it('404s serving an asset that was never uploaded', async () => {
    expect((await fetch(`${stack.baseUrl}/api/branding/hero`)).status).toBe(404)
  })
})
