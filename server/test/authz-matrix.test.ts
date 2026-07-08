// Authorization matrix: every role (plus unauthenticated) against every
// endpoint and guard. New slices append endpoints to the matrix; this is the
// harness the PRD's endpoint-by-role criterion refers to.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireRole, requireNotVisitor } from '../src/authz.js'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

const ACTORS = ['unauthenticated', 'visitor', 'member', 'warlead', 'ocmanager', 'leadership', 'admin'] as const
type Actor = (typeof ACTORS)[number]

// Actor → Torn user id + DB-assigned roles. "member" is in the faction with no roles.
const ACTOR_SETUP: Record<Exclude<Actor, 'unauthenticated'>, { id: number; roles: string[]; inFaction: boolean }> = {
  visitor:    { id: 9101, roles: ['visitor'],    inFaction: false },
  member:     { id: 9102, roles: [],             inFaction: true },
  warlead:    { id: 9103, roles: ['warlead'],    inFaction: true },
  ocmanager:  { id: 9104, roles: ['ocmanager'],  inFaction: true },
  leadership: { id: 9105, roles: ['leadership'], inFaction: true },
  admin:      { id: 9106, roles: ['admin'],      inFaction: true },
}

let stack: TestStack
const tokens = new Map<Actor, string>()

beforeAll(async () => {
  stack = await startTestStack(55445, (app) => {
    // Probe routes exercising each guard at the HTTP seam.
    app.get('/probe/leadership', { preHandler: requireRole('leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/warlead', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/ocmanager', { preHandler: requireRole('ocmanager', 'leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/admin', { preHandler: requireRole('admin') }, async () => ({ ok: true }))
    app.get('/probe/writes', { preHandler: requireNotVisitor() }, async () => ({ ok: true }))
  })

  for (const [actor, setup] of Object.entries(ACTOR_SETUP)) {
    const key = `${actor.toUpperCase().padEnd(12, 'X')}${setup.id}`
    stack.torn.addKey(key, {
      id: String(setup.id),
      factionId: setup.inFaction ? TEST_FACTION.tornFactionId : '42',
    })
    for (const role of setup.roles) {
      await stack.db.query('INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)', [setup.id, role])
    }
    const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    expect(res.status, `${actor} must be able to log in`).toBe(200)
    tokens.set(actor as Actor, (await res.json()).token)
  }
})

afterAll(async () => {
  await stack?.close()
})

async function hit(path: string, actor: Actor): Promise<number> {
  const token = tokens.get(actor)
  const res = await fetch(`${stack.baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return res.status
}

// path → expected status per actor
const MATRIX: Array<{ path: string; expected: Record<Actor, number> }> = [
  {
    path: '/api/bootstrap',
    expected: { unauthenticated: 200, visitor: 200, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/leadership',
    expected: { unauthenticated: 401, visitor: 403, member: 403, warlead: 403, ocmanager: 403, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/warlead',
    expected: { unauthenticated: 401, visitor: 403, member: 403, warlead: 200, ocmanager: 403, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/ocmanager',
    expected: { unauthenticated: 401, visitor: 403, member: 403, warlead: 403, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/admin',
    expected: { unauthenticated: 401, visitor: 403, member: 403, warlead: 403, ocmanager: 403, leadership: 403, admin: 200 },
  },
  {
    path: '/probe/writes',
    expected: { unauthenticated: 401, visitor: 403, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
]

describe('authorization matrix', () => {
  for (const row of MATRIX) {
    for (const actor of ACTORS) {
      it(`${actor} → GET ${row.path} = ${row.expected[actor]}`, async () => {
        expect(await hit(row.path, actor)).toBe(row.expected[actor])
      })
    }
  }

  it('bootstrap reports each actor exactly the roles the DB assigned', async () => {
    for (const [actor, setup] of Object.entries(ACTOR_SETUP)) {
      const res = await fetch(`${stack.baseUrl}/api/bootstrap`, {
        headers: { authorization: `Bearer ${tokens.get(actor as Actor)}` },
      })
      const body = await res.json()
      expect(body.user.roles.sort(), actor).toEqual([...setup.roles].sort())
    }
  })
})
