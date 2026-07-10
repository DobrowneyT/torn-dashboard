// Admin surface (slice #74): leadership self-serve settings + global-admin
// oversight, black-box at the HTTP seam. Role grants, faction settings
// documents, branding, scraper visibility/triggers, key-pool health.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let leadershipToken: string
let adminToken: string

async function loginAs(key: string, id: string, opts: { inFaction?: boolean } = {}) {
  stack.torn.addKey(key, {
    id,
    factionId: opts.inFaction === false ? '42' : TEST_FACTION.tornFactionId,
  })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

async function api(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO role_assignments (torn_user_id, role) VALUES (7100, 'leadership')`
  )
  leadershipToken = await loginAs('LEADERADMIN7100X', '7100')
})

afterAll(async () => {
  await stack?.close()
})

describe('role management', () => {
  it('leadership grants a role and the grantee’s next login carries the claim', async () => {
    const grant = await api('POST', '/api/admin/roles', leadershipToken, {
      torn_user_id: 7200,
      role: 'warlead',
    })
    expect(grant.status).toBe(200)

    // The grant is attributed to the granting leader.
    const list = await api('GET', '/api/admin/roles', leadershipToken)
    expect(list.status).toBe(200)
    const row = list.body.roles.find(
      (r: any) => r.torn_user_id === '7200' && r.role === 'warlead'
    )
    expect(row).toBeTruthy()
    expect(row.granted_by).toBe('7100')

    // Access changes on the target's next login — the acceptance criterion.
    const granteeToken = await loginAs('NEWWARLEAD7200XX', '7200')
    const boot = await api('GET', '/api/bootstrap', granteeToken)
    expect(boot.body.user.roles).toContain('warlead')
  })

  it('revoking a role removes access on the target’s next login', async () => {
    await api('POST', '/api/admin/roles', leadershipToken, {
      torn_user_id: 7300,
      role: 'ocmanager',
    })
    const revoke = await api('DELETE', '/api/admin/roles/7300/ocmanager', leadershipToken)
    expect(revoke.status).toBe(200)

    const list = await api('GET', '/api/admin/roles', leadershipToken)
    expect(
      list.body.roles.find((r: any) => r.torn_user_id === '7300' && r.role === 'ocmanager')
    ).toBeUndefined()

    const token = await loginAs('EXOCMANAGER7300X', '7300')
    const boot = await api('GET', '/api/bootstrap', token)
    expect(boot.body.user.roles).not.toContain('ocmanager')
  })

  it('rejects an unknown role name', async () => {
    const res = await api('POST', '/api/admin/roles', leadershipToken, {
      torn_user_id: 7400,
      role: 'superuser',
    })
    expect(res.status).toBe(400)
  })
})

describe('faction settings documents', () => {
  it('leadership edits a policy document and members read the new value — no redeploy', async () => {
    // Seeded defaults are visible to any member via the existing OC policy
    // read (the OC/tier pages consume this endpoint).
    const memberToken = await loginAs('PLAINMEMBER7500X', '7500')
    const before = await api('GET', '/api/oc-config', memberToken)
    expect(before.status).toBe(200)
    expect(before.body.payout_tickets['1']).toBe(40)

    const put = await api('PUT', '/api/admin/settings/payout_tickets', leadershipToken, {
      value: { '1': 45, '2': 30, '3': 15, '4': 7, '5': 2, '6': 1 },
    })
    expect(put.status).toBe(200)

    const after = await api('GET', '/api/oc-config', memberToken)
    expect(after.body.payout_tickets['1']).toBe(45)
  })

  it('the settings editor reads every policy document with its last-edited time', async () => {
    const res = await api('GET', '/api/admin/settings', leadershipToken)
    expect(res.status).toBe(200)
    const byKey = Object.fromEntries(res.body.settings.map((s: any) => [s.key, s]))
    expect(byKey.tier_requirements.value['1']).toBeInstanceOf(Array)
    expect(byKey.cpr_requirements.value['Break the Bank'].difficulty).toBe(8)
    expect(byKey.payout_tickets.updated_at).toBeTruthy()
  })

  it('rejects a settings key outside the known policy documents', async () => {
    const res = await api('PUT', '/api/admin/settings/arbitrary_key', leadershipToken, {
      value: { anything: true },
    })
    expect(res.status).toBe(400)
  })
})

describe('global-admin scraper surface', () => {
  beforeAll(async () => {
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (7900, 'admin')`)
    adminToken = await loginAs('GLOBALADMIN7900X', '7900')
    // The trigger claims a pooled key; a member login is what enrolls one.
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('7600', 'KeyDonor', 3, true)`
    )
    await loginAs('KEYDONORKEY7600X', '7600')
  })

  it('admin triggers a job manually and the run lands in the visible history', async () => {
    stack.torn.setPath('/v2/torn/items', {
      items: [{ id: 66, name: 'Morphine', value: { market_price: 20000, sell_price: 15000, buy_price: 0 } }],
    })

    const run = await api('POST', '/api/admin/scraper/jobs/items-sync/run', adminToken, {})
    expect(run.status).toBe(200)
    expect(run.body.run.status).toBe('success')
    expect(run.body.run.rows_written).toBe(1)

    const history = await api('GET', '/api/admin/scraper/runs', adminToken)
    expect(history.status).toBe(200)
    const row = history.body.runs.find((r: any) => r.job_name === 'items-sync')
    expect(row.status).toBe('success')
    expect(row.rows_written).toBe(1)
  })

  it('a failing job is reported as a failed run, not an API error', async () => {
    // wars-sync will claim a key then hit an unconfigured fixture path.
    const run = await api('POST', '/api/admin/scraper/jobs/wars-sync/run', adminToken, {})
    expect(run.status).toBe(200)
    expect(run.body.run.status).toBe('failure')
    expect(run.body.run.error).toBeTruthy()
  })

  it('rejects an unknown job name', async () => {
    const res = await api('POST', '/api/admin/scraper/jobs/definitely-not-a-job/run', adminToken, {})
    expect(res.status).toBe(404)
  })

  it('lists every known job and lets the admin disable one', async () => {
    const list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    expect(list.status).toBe(200)
    const names = list.body.jobs.map((j: any) => j.job_name)
    expect(names).toContain('items-sync')
    expect(names).toContain('war-lifecycle')
    const itemsJob = list.body.jobs.find((j: any) => j.job_name === 'items-sync')
    expect(itemsJob.enabled).toBe(true)
    expect(itemsJob.cron_schedule).toBeTruthy()

    const toggle = await api('PUT', '/api/admin/scraper/jobs/items-sync', adminToken, { enabled: false })
    expect(toggle.status).toBe(200)
    const after = await api('GET', '/api/admin/scraper/jobs', adminToken)
    expect(after.body.jobs.find((j: any) => j.job_name === 'items-sync').enabled).toBe(false)
  })
})

describe('key-pool health', () => {
  it('admin sees pool membership and claim recency — but never key material', async () => {
    const res = await api('GET', '/api/admin/key-pool', adminToken)
    expect(res.status).toBe(200)

    // 7600 enrolled at login and was claimed by the items-sync trigger above.
    const donor = res.body.keys.find((k: any) => k.member_id === '7600')
    expect(donor).toBeTruthy()
    expect(donor.member_name).toBe('KeyDonor')
    expect(donor.consent_version).toBe('login-v1')
    expect(donor.disabled).toBe(false)
    expect(donor.last_claimed_at).toBeTruthy()

    // Metadata only: no row may carry the encrypted blob or any key-shaped field.
    for (const k of res.body.keys) {
      expect(k.cpr_api_key).toBeUndefined()
      expect(JSON.stringify(k)).not.toContain('KEYDONORKEY7600X')
    }
  })
})

describe('branding & identity', () => {
  it('leadership renames the faction and re-brands; /api/bootstrap reflects it to everyone', async () => {
    const put = await api('PUT', '/api/admin/config', leadershipToken, {
      display_name: 'Forge Reborn',
      branding: { hero_image: '/img/hero-v2.png', favicon: '/img/fav.ico', accent: '#ff6600' },
    })
    expect(put.status).toBe(200)

    // Bootstrap is the public identity surface — even unauthenticated.
    const res = await fetch(`${stack.baseUrl}/api/bootstrap`)
    const body = (await res.json()) as any
    expect(body.faction.display_name).toBe('Forge Reborn')
    expect(body.faction.branding.hero_image).toBe('/img/hero-v2.png')
    expect(body.faction.branding.accent).toBe('#ff6600')
  })

  it('a partial update leaves the other identity fields untouched', async () => {
    const put = await api('PUT', '/api/admin/config', leadershipToken, {
      display_name: 'Forge Final',
    })
    expect(put.status).toBe(200)
    const res = await fetch(`${stack.baseUrl}/api/bootstrap`)
    const body = (await res.json()) as any
    expect(body.faction.display_name).toBe('Forge Final')
    // Branding from the previous test survives an update that omits it.
    expect(body.faction.branding.favicon).toBe('/img/fav.ico')
  })
})
