// Authorization matrix: every role (plus unauthenticated) against every
// endpoint and guard. New slices append endpoints to the matrix; this is the
// harness the PRD's endpoint-by-role criterion refers to.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireAuth, requireRole } from '../src/authz.js'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

const ACTORS = ['unauthenticated', 'member', 'warlead', 'ocmanager', 'leadership', 'admin'] as const
type Actor = (typeof ACTORS)[number]

// Actor → Torn user id + DB-assigned roles. "member" is in the faction with no roles.
const ACTOR_SETUP: Record<Exclude<Actor, 'unauthenticated'>, { id: number; roles: string[]; inFaction: boolean }> = {
  member:     { id: 9102, roles: [],             inFaction: true },
  warlead:    { id: 9103, roles: ['warlead'],    inFaction: true },
  ocmanager:  { id: 9104, roles: ['ocmanager'],  inFaction: true },
  leadership: { id: 9105, roles: ['leadership'], inFaction: true },
  admin:      { id: 9106, roles: ['admin'],      inFaction: true },
}

let stack: TestStack
const tokens = new Map<Actor, string>()

beforeAll(async () => {
  stack = await startTestStack((app) => {
    // Probe routes exercising each guard at the HTTP seam.
    app.get('/probe/leadership', { preHandler: requireRole('leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/warlead', { preHandler: requireRole('warlead', 'leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/ocmanager', { preHandler: requireRole('ocmanager', 'leadership', 'admin') }, async () => ({ ok: true }))
    app.get('/probe/admin', { preHandler: requireRole('admin') }, async () => ({ ok: true }))
    // ⚠️ This probe was `requireNotVisitor()` until #922 removed that role. It
    // is now `requireAuth()`, which is exactly what the eight routes guarded
    // ONLY by the old visitor check were converted to — and that conversion is
    // the hazard of the whole removal: `requireNotVisitor()` also 401'd without
    // a session, so deleting it outright would have made those routes PUBLIC.
    // The `unauthenticated: 401` column below is what holds that line.
    app.get('/probe/authenticated', { preHandler: requireAuth() }, async () => ({ ok: true }))
  })

  // /api/members/:id 404s without a row — give the member actor one.
  await stack.db.query(`INSERT INTO members (member_id, member_name) VALUES ('9102', 'MatrixMember')`)
  // Live-crimes endpoints proxy the Torn fixture; give it a board to serve.
  stack.torn.setFactionCrimes({ crimes: [] })

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
    tokens.set(actor as Actor, ((await res.json()) as any).token)
  }
})

afterAll(async () => {
  await stack?.close()
})

// Matrix paths default to GET; prefix with a method ("POST /api/...") for
// writes. Writes send an empty JSON body — authorized actors then see 400,
// which proves they passed the guard without mutating anything.
async function hit(path: string, actor: Actor): Promise<number> {
  const [method, p] = path.includes(' ') ? (path.split(' ') as [string, string]) : ['GET', path]
  const token = tokens.get(actor)
  const res = await fetch(`${stack.baseUrl}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
    },
    body: method !== 'GET' ? '{}' : undefined,
  })
  return res.status
}

// path → expected status per actor
const MATRIX: Array<{ path: string; expected: Record<Actor, number> }> = [
  {
    path: '/api/bootstrap',
    expected: { unauthenticated: 200, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/leadership',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/warlead',
    expected: { unauthenticated: 401, member: 403, warlead: 200, ocmanager: 403, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/ocmanager',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: '/probe/admin',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 403, admin: 200 },
  },
  {
    path: '/probe/authenticated',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  // Slice #61 — member/dashboard reads: any authenticated session may read.
  ...[
    '/api/members',
    '/api/members/9102',
    '/api/members/9102/cpr',
    '/api/members/9102/daily-stats',
    '/api/members/9102/crimes',
    '/api/members/9102/payouts',
    '/api/members/9102/wars',
    '/api/members/9102/war-payouts',
    '/api/inventory/loaned',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // Slice #62 — OC reads: member-visible...
  ...[
    '/api/crimes',
    '/api/crimes/current',
    '/api/crimes/c1/slots',
    '/api/members/roster',
    '/api/oc-config',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // ...except the planner, which is role-gated server-side.
  {
    path: '/api/oc-planner/data',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 200, leadership: 200, admin: 200 },
  },
  // Slice #63 — payout reads are member-visible...
  ...[
    '/api/payouts/weeks',
    '/api/payouts/weeks/1/members',
    '/api/payouts/weeks/1/crimes',
    '/api/payouts/crime-data?from=1750000000&to=1750604800',
    '/api/members/with-cpr',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // Single-week fetch: every authenticated actor passes the guard (404 —
  // no week with id 1 exists in this stack's empty DB).
  {
    path: '/api/payouts/weeks/1',
    expected: { unauthenticated: 401, member: 404, warlead: 404, ocmanager: 404, leadership: 404, admin: 404 },
  },
  // ...and the save is leadership/admin-only.
  {
    path: 'POST /api/payouts/weeks',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 400, admin: 400 },
  },
  // Slice #64 — ranked-war reads are member-visible.
  ...[
    '/api/wars',
    '/api/wars/1/contributions',
    '/api/wars/1/revives',
    '/api/wars/1/payouts',
    '/api/attacks?from=1',
    '/api/war-payouts',
    '/api/war-payouts/1/members',
    '/api/factions?ids=9002',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // Single-war fetch: authenticated actors pass the guard (404 — no war
  // with id 1 in this stack's empty DB).
  {
    path: '/api/wars/1',
    expected: { unauthenticated: 401, member: 404, warlead: 404, ocmanager: 404, leadership: 404, admin: 404 },
  },
  // Slice #65 — RW payout save + war reclassification are leadership/admin
  // -only (400 = past the guard, empty body).
  ...['POST /api/war-payouts', 'POST /api/wars/1/is-termed'].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 400, admin: 400 } as Record<Actor, number>,
  })),
  // Slice #66 — leadership-tool reads: leadership/admin.
  ...[
    '/api/overview/views',
    '/api/overview/thresholds',
    '/api/overview/daily-stats?since=2026-01-01',
    '/api/inventory',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // ...and every write is purpose-built + leadership/admin-gated (400 = past
  // the guard with an empty body).
  ...[
    'POST /api/overview/views',
    'PUT /api/overview/views/00000000-0000-0000-0000-000000000000',
    'POST /api/overview/thresholds',
    'PUT /api/overview/thresholds/00000000-0000-0000-0000-000000000000',
    'PUT /api/members/1/tier-override',
    'POST /api/inventory/pricing-batches',
    'PUT /api/inventory/items/1/price',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 400, admin: 400 } as Record<Actor, number>,
  })),
  // Deletes pass the guard and 404 on the empty DB.
  ...[
    'DELETE /api/overview/views/00000000-0000-0000-0000-000000000000',
    'DELETE /api/overview/thresholds/00000000-0000-0000-0000-000000000000',
  ].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 404, admin: 404 } as Record<Actor, number>,
  })),
  // The Torn-backed inventory sync passes the guard and 502s (the matrix
  // stack's fixture serves no faction inventory).
  {
    path: 'POST /api/inventory/sync',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 502, admin: 502 },
  },
  // Slice #70 — on-demand sync triggers are leadership/admin-only. Authorized
  // callers get a 200 run record (a failed run in this empty-pool stack).
  ...['POST /api/sync/wars', 'POST /api/sync/attacks', 'POST /api/sync/wars/1/revives'].map((path) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 200, admin: 200 } as Record<Actor, number>,
  })),
  // Slice #72 — war-room writes. Dibs are open to any authenticated member
  // (400 = past the guard, empty body); releases are filtered no-ops.
  {
    path: 'POST /api/war-room/dibs',
    expected: { unauthenticated: 401, member: 400, warlead: 400, ocmanager: 400, leadership: 400, admin: 400 },
  },
  {
    path: 'DELETE /api/war-room/dibs/1',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  // Chain save + roll-call submit: any authenticated member.
  {
    path: 'POST /api/war-room/chain-save',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: 'DELETE /api/war-room/chain-save',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: 'POST /api/war-room/roll-call',
    expected: { unauthenticated: 401, member: 400, warlead: 400, ocmanager: 400, leadership: 400, admin: 400 },
  },
  // Roll-call rows are member-visible (legacy RLS surface).
  {
    path: '/api/war-room/roll-call?war_id=1',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: 'PUT /api/war-room/notes',
    expected: { unauthenticated: 401, member: 403, warlead: 400, ocmanager: 403, leadership: 400, admin: 400 },
  },
  {
    path: '/api/war-room/notes/1',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 },
  },
  {
    path: '/api/war-room/notes/1/private',
    expected: { unauthenticated: 401, member: 403, warlead: 200, ocmanager: 403, leadership: 200, admin: 200 },
  },
  // Slice #73 — manual war-room setup: leads only (400/503 = past the guard
  // with an empty body / empty key pool).
  ...(
    [
      ['PUT /api/war-room/config', 400],
      ['POST /api/war-room/clear-state', 200],
      ['POST /api/war-room/fetch-members', 400],
      ['POST /api/war-room/fetch-chains', 400],
      ['POST /api/war-room/fetch-spies', 400],
    ] as Array<[string, number]>
  ).map(([path, authorized]) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: authorized, ocmanager: 403, leadership: authorized, admin: authorized } as Record<Actor, number>,
  })),
  // Slice #74 — leadership settings surface (400/404 = past the guard with
  // an empty body / a nonexistent assignment).
  ...(
    [
      ['GET /api/admin/roles', 200],
      ['POST /api/admin/roles', 400],
      ['DELETE /api/admin/roles/424242/warlead', 404],
      ['GET /api/admin/settings', 200],
      ['PUT /api/admin/settings/payout_tickets', 400],
      ['PUT /api/admin/config', 400],
    ] as Array<[string, number]>
  ).map(([path, authorized]) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: authorized, admin: authorized } as Record<Actor, number>,
  })),
  // Slice #74 — global-admin oversight: faction leadership must NOT see it.
  ...(
    [
      ['GET /api/admin/scraper/jobs', 200],
      ['PUT /api/admin/scraper/jobs/items-sync', 400],
      ['POST /api/admin/scraper/jobs/items-sync/run', 200],
      ['GET /api/admin/scraper/runs', 200],
      ['GET /api/admin/key-pool', 200],
      ['GET /api/admin/secrets', 200],
      ['PUT /api/admin/secrets/bsp_api_key', 400],
    ] as Array<[string, number]>
  ).map(([path, authorized]) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 403, admin: authorized } as Record<Actor, number>,
  })),
  // #395 — faction calendar. Reads are open to every authenticated session;
  // the calendar is a view onto pages they can already see.
  {
    path: '/api/calendar',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  },
  // Typed-in entries are leadership-only (400 = past the guard on an empty
  // body, 404 = past it on a nonexistent row).
  ...(
    [
      ['POST /api/calendar/events', 400],
      ['PUT /api/calendar/events/424242', 400],
      ['DELETE /api/calendar/events/424242', 404],
    ] as Array<[string, number]>
  ).map(([path, authorized]) => ({
    path,
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: authorized, admin: authorized } as Record<Actor, number>,
  })),
  // ⚠️ A birthday is owned by the member it belongs to, so this row is NOT a
  // role check — it is an ownership check. Nobody here is member 424242, so
  // every non-leadership actor is refused on that ground alone, and leadership
  // passes to a 400 on the empty body.
  {
    path: 'PUT /api/calendar/birthdays/424242',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 400, admin: 400 } as Record<Actor, number>,
  },
  {
    path: 'DELETE /api/calendar/birthdays/424242',
    expected: { unauthenticated: 401, member: 403, warlead: 403, ocmanager: 403, leadership: 200, admin: 200 } as Record<Actor, number>,
  },
  // #459 — the calendar scope is owned by the member it belongs to, so this is
  // an ownership check, not a role check: everyone reads their OWN state, and
  // nobody can grant or withdraw it for anyone else (there is no route that
  // takes a member id). Visitors are refused because they have no key to
  // consent with; the actors here have none either, hence 409 rather than 200.
  {
    path: '/api/calendar/event-window/me',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
  },
  {
    path: 'PUT /api/calendar/event-window/me',
    expected: { unauthenticated: 401, member: 400, warlead: 400, ocmanager: 400, leadership: 400, admin: 400 } as Record<Actor, number>,
  },
  // #119 — silent session renewal: every authenticated actor may refresh;
  // anonymous cannot.
  {
    path: 'POST /api/auth/refresh',
    expected: { unauthenticated: 401, member: 200, warlead: 200, ocmanager: 200, leadership: 200, admin: 200 } as Record<Actor, number>,
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
      const body = await res.json() as any
      expect(body.user.roles.sort(), actor).toEqual([...setup.roles].sort())
    }
  })
})

/**
 * ⚠️ **The eight routes whose ONLY guard was the visitor check** (#922).
 *
 * `requireNotVisitor()` did two jobs: it rejected visitors with a 403 AND it
 * rejected anonymous callers with a 401. On a route where it was the only
 * `preHandler`, deleting it would have removed the authentication as well and
 * published the endpoint. Each was converted to `requireAuth()` instead.
 *
 * These are asserted BY PATH rather than through a probe, because the hazard is
 * not "does `requireAuth` work" — it is "did every one of these eight actually
 * get a replacement". A route that silently lost its guard would 200 here.
 */
describe('#922 — routes converted from requireNotVisitor() to requireAuth()', () => {
  const CONVERTED = [
    'PUT /api/calendar/event-window/me',
    'PUT /api/calendar/birthdays/9102',
    'DELETE /api/calendar/birthdays/9102',
    'POST /api/war-room/chain-save',
    'DELETE /api/war-room/chain-save',
    'POST /api/war-room/roll-call',
    'POST /api/war-room/revive',
    'POST /api/feedback',
  ]

  for (const spec of CONVERTED) {
    const [method, path] = spec.split(' ')
    it(`${spec} still rejects an anonymous caller`, async () => {
      const res = await fetch(`${stack.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      })
      // ⚠️ 401, never 200. A 404 would mean the path moved and this stopped
      // testing anything, so it is excluded too.
      expect(res.status, `${spec} answered ${res.status}`).toBe(401)
    })
  }
})
