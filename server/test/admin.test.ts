// Admin surface (slice #74): leadership self-serve settings + global-admin
// oversight, black-box at the HTTP seam. Role grants, faction settings
// documents, branding, scraper visibility/triggers, key-pool health.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { CURRENT_DISCLOSURE_VERSION } from '../src/consent.js'

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

  it('leadership sets the faction payout mode (a plain string) and members read it back', async () => {
    const memberToken = await loginAs('PLAINMEMBER7500X', '7500')

    const put = await api('PUT', '/api/admin/settings/payout_mode', leadershipToken, {
      value: 'tiered',
    })
    expect(put.status).toBe(200)

    const after = await api('GET', '/api/oc-config', memberToken)
    expect(after.body.payout_mode).toBe('tiered')
  })

  it('rejects a payout mode that is not one of the three known modes', async () => {
    const res = await api('PUT', '/api/admin/settings/payout_mode', leadershipToken, {
      value: 'random-mode',
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

  // The trigger backgrounds the job (returns a 'running' record at once so a
  // minutes-long job can't hold the HTTP request open past the nginx timeout).
  // Poll the visible history until the run settles.
  async function waitForRun(runId: number, tries = 50): Promise<any> {
    for (let i = 0; i < tries; i++) {
      const history = await api('GET', '/api/admin/scraper/runs', adminToken)
      const row = history.body.runs.find((r: any) => r.id === runId)
      if (row && row.status !== 'running') return row
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`run ${runId} did not settle`)
  }

  it('admin triggers a job manually and the run lands in the visible history', async () => {
    stack.torn.setPath('/v2/torn/items', {
      items: [{ id: 66, name: 'Morphine', value: { market_price: 20000, sell_price: 15000, buy_price: 0 } }],
    })

    const run = await api('POST', '/api/admin/scraper/jobs/items-sync/run', adminToken, {})
    expect(run.status).toBe(200)
    // Returns immediately with a 'running' record; the job runs in the background.
    expect(run.body.run.status).toBe('running')

    const row = await waitForRun(run.body.run.id)
    expect(row.job_name).toBe('items-sync')
    expect(row.status).toBe('success')
    expect(row.rows_written).toBe(1)
  })

  it('a failing job is reported as a failed run, not an API error', async () => {
    // wars-sync will claim a key then hit an unconfigured fixture path.
    const run = await api('POST', '/api/admin/scraper/jobs/wars-sync/run', adminToken, {})
    expect(run.status).toBe(200)
    expect(run.body.run.status).toBe('running')

    const row = await waitForRun(run.body.run.id)
    expect(row.status).toBe('failure')
    expect(row.error).toBeTruthy()
  })

  it('rejects an unknown job name', async () => {
    const res = await api('POST', '/api/admin/scraper/jobs/definitely-not-a-job/run', adminToken, {})
    expect(res.status).toBe(404)
  })

  it('admin edits a job’s cadence; invalid cron expressions are rejected', async () => {
    // Frequency is per-faction admin config (applies on the API's next
    // restart — the scheduler arms cron tasks from scraper_jobs at start).
    const put = await api('PUT', '/api/admin/scraper/jobs/crimes-sync', adminToken, {
      cron_schedule: '0 */15 * * * *',
    })
    expect(put.status).toBe(200)

    const list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    expect(list.body.jobs.find((j: any) => j.job_name === 'crimes-sync').cron_schedule)
      .toBe('0 */15 * * * *')

    const bad = await api('PUT', '/api/admin/scraper/jobs/crimes-sync', adminToken, {
      cron_schedule: 'every day at teatime',
    })
    expect(bad.status).toBe(400)
  })

  it('lists every known job — disabled by default — and lets the admin enable one', async () => {
    const list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    expect(list.status).toBe(200)
    const names = list.body.jobs.map((j: any) => j.job_name)
    expect(names).toContain('items-sync')
    expect(names).toContain('war-lifecycle')
    // Bring-up is explicit: nothing scrapes until the admin turns it on.
    const itemsJob = list.body.jobs.find((j: any) => j.job_name === 'items-sync')
    expect(itemsJob.enabled).toBe(false)
    // ⚠️ #609 slice 5: `cron_schedule` is now this faction's OVERRIDE, and null
    // means "follow the fleet default" — a real setting, not a missing one. The
    // cadence the scheduler will actually use is `effective_schedule`, and
    // `schedule_source` says which of the three layers supplied it.
    expect(itemsJob.cron_schedule).toBeNull()
    expect(itemsJob.effective_schedule).toBeTruthy()
    expect(itemsJob.schedule_source).toBe('default')
    expect(itemsJob.effective_schedule).toBe(itemsJob.default_schedule)

    const toggle = await api('PUT', '/api/admin/scraper/jobs/items-sync', adminToken, { enabled: true })
    expect(toggle.status).toBe(200)
    const after = await api('GET', '/api/admin/scraper/jobs', adminToken)
    expect(after.body.jobs.find((j: any) => j.job_name === 'items-sync').enabled).toBe(true)
  })
})

describe('feature flags (#609 slice 5)', () => {
  it('stores, resolves and clears a tenant flag', async () => {
    const put = await api('PUT', '/api/admin/flags/scraper.schedule.items-sync', adminToken, {
      value: '0 0 */12 * * *',
    })
    expect(put.status).toBe(200)
    expect(put.body.flag).toMatchObject({ value: '0 0 */12 * * *', source: 'tenant' })

    const list = await api('GET', '/api/admin/flags', adminToken)
    expect(list.status).toBe(200)
    expect(list.body.flags).toContainEqual(
      expect.objectContaining({ key: 'scraper.schedule.items-sync', source: 'tenant' })
    )

    const del = await api('DELETE', '/api/admin/flags/scraper.schedule.items-sync', adminToken)
    expect(del.status).toBe(200)
    expect(del.body.flag).toMatchObject({ source: 'unset' })
  })

  it('⚠️ a flag write takes effect on the scheduler view immediately', async () => {
    // The resolver caches for a minute, so a write that did not invalidate it
    // would leave the console showing a value the scheduler is not using —
    // exactly the confusion this feature is supposed to remove.
    await api('PUT', '/api/admin/flags/scraper.schedule.crimes-sync', adminToken, {
      value: '0 0 */4 * * *',
    })
    const list = await api('GET', '/api/admin/flags', adminToken)
    expect(list.body.flags.find((f: any) => f.key === 'scraper.schedule.crimes-sync'))
      .toMatchObject({ value: '0 0 */4 * * *' })
    await api('DELETE', '/api/admin/flags/scraper.schedule.crimes-sync', adminToken)
  })

  it('⚠️ refuses a null value rather than storing a row that means nothing', async () => {
    // A stored null would produce a row that EXISTS — and therefore counts as
    // "set", beating any fleet default — while holding nothing. Unsetting is a
    // DELETE, and only a DELETE.
    const bad = await api('PUT', '/api/admin/flags/some.flag', adminToken, { value: null })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('DELETE')
  })

  it('⚠️ keeps a tenant-set 0, which is a real setting in this codebase', async () => {
    // member_stats_poll_interval_sec = 0 already means "off" (warLifecycle.ts).
    const put = await api('PUT', '/api/admin/flags/war.member_stats_poll_interval_sec', adminToken, {
      value: 0,
    })
    expect(put.status).toBe(200)
    expect(put.body.flag.value).toBe(0)
    expect(put.body.flag.source).toBe('tenant')
    await api('DELETE', '/api/admin/flags/war.member_stats_poll_interval_sec', adminToken)
  })

  it('rejects a malformed key', async () => {
    const bad = await api('PUT', '/api/admin/flags/Bad Key!', adminToken, { value: 1 })
    expect(bad.status).toBe(400)
  })

  it('is global-admin only', async () => {
    const asLeader = await api('GET', '/api/admin/flags', leadershipToken)
    expect(asLeader.status).toBe(403)
  })
})

describe('scraper cadence override (#609 slice 5)', () => {
  it('⚠️ an explicit null clears the override and returns to the fleet default', async () => {
    // Distinct from omitting the field, which means "leave it alone".
    // Collapsing the two would leave a faction with no way back short of a DB
    // edit.
    const set = await api('PUT', '/api/admin/scraper/jobs/items-sync', adminToken, {
      cron_schedule: '0 0 */3 * * *',
    })
    expect(set.status).toBe(200)
    let list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    let job = list.body.jobs.find((j: any) => j.job_name === 'items-sync')
    expect(job).toMatchObject({ cron_schedule: '0 0 */3 * * *', schedule_source: 'tenant' })

    const clear = await api('PUT', '/api/admin/scraper/jobs/items-sync', adminToken, {
      cron_schedule: null,
    })
    expect(clear.status).toBe(200)
    list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    job = list.body.jobs.find((j: any) => j.job_name === 'items-sync')
    expect(job.cron_schedule).toBeNull()
    expect(job.schedule_source).toBe('default')
    expect(job.effective_schedule).toBe(job.default_schedule)
  })

  it('toggling enabled does not disturb an existing override', async () => {
    await api('PUT', '/api/admin/scraper/jobs/crimes-sync', adminToken, { cron_schedule: '0 0 */5 * * *' })
    await api('PUT', '/api/admin/scraper/jobs/crimes-sync', adminToken, { enabled: true })
    const list = await api('GET', '/api/admin/scraper/jobs', adminToken)
    const job = list.body.jobs.find((j: any) => j.job_name === 'crimes-sync')
    expect(job).toMatchObject({ cron_schedule: '0 0 */5 * * *', enabled: true })
    await api('PUT', '/api/admin/scraper/jobs/crimes-sync', adminToken, { cron_schedule: null, enabled: false })
  })
})

describe('spy-provider secrets (#105)', () => {
  it('admin sets a provider key; reads expose configured-state and last-4 hint only', async () => {
    const put = await api('PUT', '/api/admin/secrets/tornstats_api_key', adminToken, {
      value: 'TS-SECRET-KEY-9876',
    })
    expect(put.status).toBe(200)

    const list = await api('GET', '/api/admin/secrets', adminToken)
    expect(list.status).toBe(200)
    const ts = list.body.secrets.find((s: any) => s.name === 'tornstats_api_key')
    expect(ts).toMatchObject({ configured: true, hint: '9876' })
    const bsp = list.body.secrets.find((s: any) => s.name === 'bsp_api_key')
    expect(bsp).toMatchObject({ configured: false })
    // The value itself never crosses the boundary.
    expect(JSON.stringify(list.body)).not.toContain('TS-SECRET-KEY-9876')

    // Encrypted at rest — never plaintext in the DB.
    const raw = await stack.db.query(`SELECT value_enc FROM faction_secrets WHERE name = 'tornstats_api_key'`)
    expect((raw.rows[0].value_enc as Buffer).toString('utf8')).not.toContain('TS-SECRET-KEY-9876')
  })

  it('rejects unknown secret names and empty values', async () => {
    expect((await api('PUT', '/api/admin/secrets/other_thing', adminToken, { value: 'x' })).status).toBe(400)
    expect((await api('PUT', '/api/admin/secrets/bsp_api_key', adminToken, {})).status).toBe(400)
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
    // ⚠️ Asserts the CURRENT disclosure, not a literal. Login records
    // whatever the disclosure says today — the login modal will not submit
    // until the member ticks it — so pinning a string here would break on
    // every future bump and tempt somebody to 'fix' it by hardcoding the
    // old value, which is the trap this replaced (#889 slice 0).
    expect(donor.consent_version).toBe(CURRENT_DISCLOSURE_VERSION)
    expect(donor.disabled).toBe(false)
    // The fresh-faction bootstrap enrolls every in-faction login in this
    // file, and claims rotate least-recently-claimed — so the items-sync
    // trigger above claimed one of them, not necessarily the donor.
    expect(res.body.keys.some((k: any) => k.last_claimed_at)).toBe(true)

    // Metadata only: no row may carry the encrypted blob or any key-shaped field.
    for (const k of res.body.keys) {
      expect(k.cpr_api_key).toBeUndefined()
      expect(JSON.stringify(k)).not.toContain('KEYDONORKEY7600X')
    }
  })

  it('lists current members with no key as missing rows', async () => {
    // A current member who never logged in → no member_secrets row.
    await stack.db.query(
      `INSERT INTO members (member_id, member_name, tier, is_current) VALUES ('7601', 'NoKeyGuy', 3, true)
       ON CONFLICT (member_id) DO NOTHING`
    )
    const res = await api('GET', '/api/admin/key-pool', adminToken)
    const missing = res.body.keys.find((k: any) => k.member_id === '7601')
    expect(missing).toBeTruthy()
    expect(missing.missing).toBe(true)
    expect(missing.member_name).toBe('NoKeyGuy')
    expect(missing.key_level).toBeNull()
    expect(missing.consent_version).toBeNull()
    expect(missing.last_claimed_at).toBeNull()
    // Enrolled members are marked not-missing.
    const donor = res.body.keys.find((k: any) => k.member_id === '7600')
    expect(donor.missing).toBe(false)
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
