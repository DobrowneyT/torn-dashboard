// #609 slice 4 — alert rules, incident state, and the two delivery channels.
//
// The theme running through this file is the one the issue is most emphatic
// about, and the one this project has already been burned by (#598): a monitor
// that cries wolf gets muted, and a muted monitor is worse than none. So most
// of what is asserted here is about NOT sending — the blip that never becomes a
// message, the ongoing outage that stays one message, the feature that is not
// in service yet and must therefore stay silent.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateAlerts, DEFAULT_THRESHOLDS, type Alert } from '../src/adminPlane/alertRules.js'
import { reconcile, openIncidents, type Incident } from '../src/adminPlane/incidents.js'
import { buildPayload, notifyDiscord } from '../src/adminPlane/discord.js'
import { composeDigest } from '../src/adminPlane/digest.js'
import { digestIsDue, runCycle, DIGEST_STATE_KEY } from '../src/adminPlane/monitor.js'
import type { FleetStatus, TenantStatus } from '../src/adminPlane/statusCollector.js'
import type { AlertEvent, IncidentStore } from '../src/adminPlane/incidentStore.js'
import type { Reconciliation } from '../src/adminPlane/incidents.js'
import { buildAdminApp } from '../src/adminPlane/app.js'
import { hashPassword } from '../src/adminPlane/password.js'
import { generateTotpSecret } from '../src/adminPlane/totp.js'
import { mintAdminSession } from '../src/adminPlane/session.js'

const NOW = '2026-09-05T12:00:00.000Z'

const status = (over: Partial<FleetStatus> = {}): FleetStatus => ({
  generatedAt: NOW,
  postgres: { state: 'ok' },
  tenants: [],
  backups: { newestAgeHours: 3, count: 5, missing: [] },
  disk: { path: '/backups', totalBytes: 100e9, freeBytes: 60e9, usedPercent: 40 },
  global: { schemaVersion: 2, ocModelVersion: null, itemsSyncedAt: null },
  ...over,
})

const tenant = (slug: string, over: Partial<TenantStatus> = {}): TenantStatus =>
  ({ slug, state: 'ok', db: 'up', ...over })

const keys = (alerts: Alert[]) => alerts.map((a) => a.key).sort()

describe('evaluateAlerts', () => {
  it('says nothing about a healthy fleet', () => {
    expect(evaluateAlerts(status({ tenants: [tenant('tnl'), tenant('forge')] }))).toEqual([])
  })

  it('reports a down tenant as urgent', () => {
    const a = evaluateAlerts(status({ tenants: [tenant('tnl', { state: 'down', error: 'ECONNREFUSED' })] }))
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ key: 'tenant-down:tnl', severity: 'urgent' })
    expect(a[0].detail).toContain('ECONNREFUSED')
  })

  it('⚠️ treats degraded as urgent too, under its own key', () => {
    // "Degraded" means the process answered but its database did not — a
    // faction's dashboard that is up and broken. That gets reported as a
    // mystery bug rather than an outage, which is exactly why it needs to page.
    const a = evaluateAlerts(status({ tenants: [tenant('tnl', { state: 'degraded', db: 'down' })] }))
    expect(a[0]).toMatchObject({ key: 'tenant-degraded:tnl', severity: 'urgent' })
  })

  it('reports the control plane losing Postgres', () => {
    const a = evaluateAlerts(status({ postgres: { state: 'down', error: 'ECONNREFUSED' } }))
    expect(a[0].key).toBe('postgres-down')
  })

  describe('backups', () => {
    it('separates "none at all" from "old"', () => {
      expect(keys(evaluateAlerts(status({ backups: { newestAgeHours: null, count: 0, missing: [] } }))))
        .toEqual(['backups-none'])
      expect(keys(evaluateAlerts(status({ backups: { newestAgeHours: 70, count: 5, missing: [] } }))))
        .toEqual(['backups-stale'])
    })

    it('a single missed night is a notice, not a page', () => {
      const a = evaluateAlerts(status({ backups: { newestAgeHours: 30, count: 5, missing: [] } }))
      expect(a[0]).toMatchObject({ key: 'backups-late', severity: 'notice' })
    })

    it('⚠️ a faction with no backup at all is a NOTICE, on purpose', () => {
      // Urgent would be a self-inflicted false alarm: provisioning creates the
      // database immediately and the first dump only at the next nightly run,
      // so every new faction would page someone minutes after being created.
      // The danger being guarded against takes weeks to matter.
      const a = evaluateAlerts(status({ backups: { newestAgeHours: 2, count: 1, missing: ['forge'] } }))
      expect(a[0]).toMatchObject({ key: 'backups-missing', severity: 'notice' })
      expect(a[0].detail).toContain('forge')
    })

    it('an unreadable backup directory is urgent', () => {
      const a = evaluateAlerts(status({ backups: { newestAgeHours: null, count: 0, missing: [], error: 'ENOENT' } }))
      expect(a[0]).toMatchObject({ key: 'backups-unreadable', severity: 'urgent' })
    })
  })

  it('splits disk by whether tonight matters', () => {
    const at = (usedPercent: number) =>
      keys(evaluateAlerts(status({ disk: { path: '/b', totalBytes: 100e9, freeBytes: 1e9, usedPercent } })))
    expect(at(70)).toEqual([])
    expect(at(85)).toEqual(['disk-low'])
    expect(at(95)).toEqual(['disk-critical'])
  })

  describe('item price staleness', () => {
    it('⚠️ says NOTHING when items-sync is not in service', () => {
      // itemsSyncedAt is null on every fleet running this code, because
      // items-sync does not move to the control plane until slice 7. Reading
      // null as "infinitely stale" would fire on every cycle from the moment
      // this ships — for a feature that does not exist. Same bug class as
      // Number(null) === 0, which bit chainedValue in #585.
      expect(evaluateAlerts(status({ global: { schemaVersion: 2, ocModelVersion: null, itemsSyncedAt: null } })))
        .toEqual([])
      expect(evaluateAlerts(status({ global: null }))).toEqual([])
    })

    it('alerts once prices exist and go stale', () => {
      const syncedAt = new Date(Date.parse(NOW) - 9 * 3_600_000).toISOString()
      const a = evaluateAlerts(status({ global: { schemaVersion: 2, ocModelVersion: 'v1', itemsSyncedAt: syncedAt } }))
      expect(a[0]).toMatchObject({ key: 'items-stale', severity: 'urgent' })
    })

    it('stays quiet inside the freshness window', () => {
      const syncedAt = new Date(Date.parse(NOW) - 60_000).toISOString()
      expect(evaluateAlerts(status({ global: { schemaVersion: 2, ocModelVersion: 'v1', itemsSyncedAt: syncedAt } })))
        .toEqual([])
    })
  })

  it('⚠️ keeps the key stable while the wording changes', () => {
    // The key is the entire basis of "this is the same problem I already told
    // you about". If a live number leaked into it, every poll would look like a
    // brand new incident and the flap suppression below would never engage.
    const a = evaluateAlerts(status({ disk: { path: '/b', totalBytes: 100e9, freeBytes: 8e9, usedPercent: 92 } }))
    const b = evaluateAlerts(status({ disk: { path: '/b', totalBytes: 100e9, freeBytes: 5e9, usedPercent: 95 } }))
    expect(a[0].key).toBe(b[0].key)
    expect(a[0].title).not.toBe(b[0].title)
  })

  it('honours custom thresholds', () => {
    const s = status({ backups: { newestAgeHours: 30, count: 1, missing: [] } })
    expect(keys(evaluateAlerts(s, { ...DEFAULT_THRESHOLDS, backupUrgentHours: 24 }))).toEqual(['backups-stale'])
  })
})

describe('key pool and scrapers (#632)', () => {
  // The two numbers that would have caught #645 on day one instead of day
  // thirteen. capacityx went from 7 usable keys to ZERO in one run, and
  // members-sync then logged `no pooled key available` 312 times while every
  // health surface reported the tenant fine.
  const withMetrics = (slug: string, metrics: unknown) =>
    status({ tenants: [{ ...tenant(slug), metrics } as never] })

  it('⚠️ says NOTHING when metrics were not measured', () => {
    // `metrics === undefined` means no secret configured, or a tenant too old
    // to serve the endpoint. Reading unmeasured as zero would fire on every
    // tenant the moment this shipped, for a fact nobody had established —
    // exactly the mistake the null items timestamp guards against.
    expect(evaluateAlerts(status({ tenants: [tenant('tnl')] }))).toEqual([])
  })

  it('⚠️ fires when a faction has no usable key at all', () => {
    const a = evaluateAlerts(withMetrics('capacityx', {
      keys: { claimable: 0, enrolled: 7, disabled: 6 },
      scrapers: { enabledJobs: 19, failing: [], runsLast24h: 0, failuresLast24h: 0 },
    }))
    expect(a[0]).toMatchObject({ key: 'keys-empty:capacityx', severity: 'urgent' })
    expect(a[0].detail).toContain('until a member logs in')
  })

  it('does not fire "empty" for a faction that has enrolled nobody', () => {
    // A freshly provisioned faction has no keys because nobody has logged in
    // yet. That is a bring-up state, not an outage.
    expect(evaluateAlerts(withMetrics('newbie', {
      keys: { claimable: 0, enrolled: 0, disabled: 0 },
      scrapers: { enabledJobs: 0, failing: [], runsLast24h: 0, failuresLast24h: 0 },
    }))).toEqual([])
  })

  it('⚠️ fires at ONE key — how #123/#124 started', () => {
    const a = evaluateAlerts(withMetrics('tnl', {
      keys: { claimable: 1, enrolled: 5, disabled: 4 },
      scrapers: { enabledJobs: 19, failing: [], runsLast24h: 10, failuresLast24h: 0 },
    }))
    expect(a[0]).toMatchObject({ key: 'keys-low:tnl', severity: 'urgent' })
  })

  it('stays quiet on a healthy pool', () => {
    expect(evaluateAlerts(withMetrics('tnl', {
      keys: { claimable: 6, enrolled: 7, disabled: 1 },
      scrapers: { enabledJobs: 19, failing: [], runsLast24h: 40, failuresLast24h: 1 },
    }))).toEqual([])
  })

  it('⚠️ names the failing JOB rather than counting them', () => {
    // "3 jobs failing" is not actionable at 3am; "members-sync has failed 12
    // times and never succeeded" is.
    const a = evaluateAlerts(withMetrics('capacityx', {
      keys: { claimable: 2, enrolled: 7, disabled: 5 },
      scrapers: {
        enabledJobs: 19, runsLast24h: 24, failuresLast24h: 24,
        failing: [
          { jobName: 'members-sync', consecutiveFailures: 12, lastSuccessAt: null, lastError: 'no pooled key available' },
          { jobName: 'crimes-sync', consecutiveFailures: 1, lastSuccessAt: '2026-09-06T10:00:00.000Z', lastError: 'blip' },
        ],
      },
    }))
    expect(a.map((x) => x.key)).toEqual(['scraper-failing:capacityx:members-sync'])
    expect(a[0].title).toContain('12 times')
    // ⚠️ "never succeeded" is a different fact from "succeeded a while ago".
    expect(a[0].detail).toContain('never succeeded')
  })

  it('ignores a job that has failed once', () => {
    expect(evaluateAlerts(withMetrics('tnl', {
      keys: { claimable: 5, enrolled: 5, disabled: 0 },
      scrapers: {
        enabledJobs: 19, runsLast24h: 40, failuresLast24h: 1,
        failing: [{ jobName: 'wars-sync', consecutiveFailures: 1, lastSuccessAt: '2026-09-06T09:00:00.000Z', lastError: 'blip' }],
      },
    }))).toEqual([])
  })

  it('⚠️ keeps the key stable so a worsening streak stays ONE incident', () => {
    const at = (n: number) => evaluateAlerts(withMetrics('tnl', {
      keys: { claimable: 5, enrolled: 5, disabled: 0 },
      scrapers: {
        enabledJobs: 19, runsLast24h: 40, failuresLast24h: n,
        failing: [{ jobName: 'wars-sync', consecutiveFailures: n, lastSuccessAt: null, lastError: 'x' }],
      },
    }))[0]
    expect(at(3).key).toBe(at(30).key)
    expect(at(3).title).not.toBe(at(30).title)
  })
})

describe('reconcile', () => {
  const down: Alert = { key: 'tenant-down:tnl', severity: 'urgent', title: 'tnl is down', detail: 'x' }
  const t = (n: number) => new Date(Date.parse(NOW) + n * 60_000).toISOString()

  it('⚠️ does not announce on the first observation', () => {
    // A container restarting during `update.sh` is unreachable for a few
    // seconds. Announcing on the first miss means every routine deploy pages.
    const r = reconcile([], [down], t(0))
    expect(r.opened).toEqual([])
    expect(r.incidents[0]).toMatchObject({ observations: 1, openedAt: null })
  })

  it('announces once it is confirmed, and then never again', () => {
    let state: Incident[] = []
    const announced: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const r = reconcile(state, [down], t(i))
      announced.push(r.opened.length)
      state = r.incidents
    }
    // ⚠️ THE acceptance criterion: "one incident produces one Discord message,
    // not one per check cycle". Six polls of an ongoing outage, one message.
    expect(announced).toEqual([0, 1, 0, 0, 0, 0])
    expect(state[0].observations).toBe(6)
  })

  it('⚠️ does not resolve on the first clear poll', () => {
    // A container in a restart loop answers every other poll. Resolving on the
    // first success gives an up/down/up/down stream — the classic flap, and the
    // loudest possible way to report one ongoing incident.
    let state = reconcile(reconcile([], [down], t(0)).incidents, [down], t(1)).incidents
    const r = reconcile(state, [], t(2))
    expect(r.resolved).toEqual([])
    expect(r.incidents[0].misses).toBe(1)
  })

  it('resolves once it has been gone for the clear window', () => {
    let state = reconcile(reconcile([], [down], t(0)).incidents, [down], t(1)).incidents
    state = reconcile(state, [], t(2)).incidents
    const r = reconcile(state, [], t(3))
    expect(r.resolved.map((i) => i.key)).toEqual(['tenant-down:tnl'])
    expect(r.incidents).toEqual([])
  })

  it('⚠️ a blip that never got announced produces no resolution message either', () => {
    // Otherwise the recovery notice is the FIRST thing the operator hears about
    // an incident that, as far as anyone was told, never happened.
    let state = reconcile([], [down], t(0)).incidents
    state = reconcile(state, [], t(1)).incidents
    const r = reconcile(state, [], t(2))
    expect(r.resolved).toEqual([])
    expect(r.incidents).toEqual([])
  })

  it('⚠️ a flapping tenant is still ONE message', () => {
    // Present on two of three polls: genuinely broken, so it must be announced
    // (an unbroken-run requirement would leave it permanently silent) — but the
    // sticky clear is what stops it announcing more than once.
    let state: Incident[] = []
    let opens = 0
    let closes = 0
    for (const present of [true, false, true, false, true, false, true]) {
      const r = reconcile(state, present ? [down] : [], t(0))
      opens += r.opened.length
      closes += r.resolved.length
      state = r.incidents
    }
    expect(opens).toBe(1)
    expect(closes).toBe(0)
  })

  it('refreshes the wording of an ongoing incident', () => {
    const first = reconcile([], [down], t(0)).incidents
    const r = reconcile(first, [{ ...down, title: 'tnl is down (still)' }], t(1))
    expect(r.incidents[0].title).toBe('tnl is down (still)')
    expect(r.incidents[0].firstSeenAt).toBe(t(0))
  })

  it('handles several independent incidents at once', () => {
    const other: Alert = { key: 'disk-critical', severity: 'urgent', title: 'Disk 95% full', detail: '' }
    let state = reconcile([], [down, other], t(0)).incidents
    const r = reconcile(state, [down, other], t(1))
    expect(r.opened.map((i) => i.key).sort()).toEqual(['disk-critical', 'tenant-down:tnl'])
  })

  it('openIncidents excludes the unconfirmed', () => {
    const r = reconcile([], [down], t(0))
    expect(openIncidents(r.incidents)).toEqual([])
  })
})

describe('the Discord channel', () => {
  const inc = (key: string, severity: 'urgent' | 'notice' = 'urgent'): Incident => ({
    key, severity, title: `${key} title`, detail: 'detail',
    firstSeenAt: NOW, lastSeenAt: NOW, observations: 2, misses: 0, openedAt: NOW,
  })

  it('sends nothing when there is nothing urgent', () => {
    expect(buildPayload({ opened: [], resolved: [] })).toBeNull()
  })

  it('⚠️ leaves notices to the digest', () => {
    // Three channels is three times the chance of training an operator to mute
    // the one that matters (#598). Disk at 82% is worthless at 3am.
    expect(buildPayload({ opened: [inc('disk-low', 'notice')], resolved: [] })).toBeNull()
  })

  it('carries an opened incident with its detail', () => {
    const p = buildPayload({ opened: [inc('tenant-down:tnl')], resolved: [] })!
    expect(p.embeds).toHaveLength(1)
    expect(p.embeds[0].title).toContain('tenant-down:tnl title')
    expect(p.embeds[0].description).toContain('detail')
  })

  it('says how long a resolved incident was open', () => {
    const opened = { ...inc('tenant-down:tnl'), lastSeenAt: new Date(Date.parse(NOW) + 3 * 3_600_000).toISOString() }
    const p = buildPayload({ opened: [], resolved: [opened] })!
    expect(p.embeds[0].description).toContain('3h')
  })

  it('⚠️ rolls a storm up into ONE embed', () => {
    // The cycle that opens twelve incidents at once is Postgres dying and
    // taking every tenant with it — precisely when a message per incident would
    // meet Discord's rate limit.
    const many = Array.from({ length: 12 }, (_, i) => inc(`tenant-down:f${i}`))
    const p = buildPayload({ opened: many, resolved: [] })!
    expect(p.embeds).toHaveLength(1)
    expect(p.embeds[0].title).toContain('12 incident(s) opened')
  })

  it('⚠️ makes exactly ONE request per cycle even for several incidents', () => {
    const calls: unknown[] = []
    const fetchImpl = (async (...args: unknown[]) => {
      calls.push(args)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    return notifyDiscord('https://discord.test/hook', {
      opened: [inc('a'), inc('b')], resolved: [inc('c')],
    }, fetchImpl).then((r) => {
      expect(r).toBe('sent')
      expect(calls).toHaveLength(1)
    })
  })

  it('is a no-op when no webhook is configured', async () => {
    expect(await notifyDiscord(undefined, { opened: [inc('a')], resolved: [] })).toBe('not_configured')
  })

  it('⚠️ reports a delivery failure rather than throwing it into the monitor', async () => {
    // An exception here would stop the fleet being polled at all: a
    // notification failure taking down the monitoring is strictly worse than a
    // missed message.
    const boom = (async () => { throw new Error('DNS is on fire') }) as unknown as typeof fetch
    const r = await notifyDiscord('https://discord.test/hook', { opened: [inc('a')], resolved: [] }, boom)
    expect(r).toMatch(/^failed: /)
    expect(r).toContain('DNS is on fire')
  })

  it('reports a non-2xx as a failure', async () => {
    const bad = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    expect(await notifyDiscord('https://x/y', { opened: [inc('a')], resolved: [] }, bad))
      .toBe('failed: HTTP 404')
  })
})

describe('the daily digest', () => {
  const base = {
    status: status({ tenants: [tenant('tnl'), tenant('forge')] }),
    open: [] as Incident[],
    events: [] as AlertEvent[],
    since: '2026-09-04T08:00:00.000Z',
    now: '2026-09-05T08:00:00.000Z',
  }

  it('⚠️ still composes a digest on a day when nothing happened', () => {
    // Mailing only on bad days makes silence ambiguous: an empty inbox means
    // either "healthy" or "the monitor died three weeks ago". The key pool
    // decayed to one key in July (#123/#124) precisely because nothing was
    // supposed to announce anything. A daily digest is its own heartbeat.
    const d = composeDigest(base)
    expect(d.subject).toContain('all clear')
    expect(d.subject).toContain('2/2 tenants up')
    expect(d.text).toContain('OPEN INCIDENTS — none')
  })

  it('leads the subject with the number that decides whether to open it', () => {
    const open: Incident[] = [{
      key: 'tenant-down:tnl', severity: 'urgent', title: 'tnl is down', detail: '',
      firstSeenAt: base.since, lastSeenAt: base.now, observations: 9, misses: 0, openedAt: base.since,
    }]
    const d = composeDigest({ ...base, open })
    expect(d.subject).toMatch(/^\[fleet\] 1 urgent/)
  })

  it('⚠️ reports incidents that opened AND closed inside the window', () => {
    // Nobody was awake for them, the status page no longer shows them, and a
    // tenant that restarts itself every night at 4am is invisible everywhere
    // else in this system.
    const events: AlertEvent[] = [
      { key: 'tenant-down:tnl', kind: 'opened', severity: 'urgent', title: 'tnl is down', detail: '', at: '2026-09-05T04:00:00.000Z' },
      { key: 'tenant-down:tnl', kind: 'resolved', severity: 'urgent', title: 'tnl is down', detail: '', at: '2026-09-05T04:06:00.000Z' },
    ]
    const d = composeDigest({ ...base, events })
    expect(d.text).toContain('ACTIVITY (2)')
    expect(d.text).toContain('04:00')
    expect(d.text).toContain('CLEAR')
  })

  it('names what has never been backed up', () => {
    const d = composeDigest({
      ...base,
      status: status({ tenants: [tenant('tnl')], backups: { newestAgeHours: 2, count: 1, missing: ['forge'] } }),
    })
    expect(d.text).toContain('No backup for   forge')
  })

  it('says "not in service" rather than implying stale prices', () => {
    expect(composeDigest(base).text).toContain('Item prices     not in service')
  })

  it('escapes tenant-supplied strings into the HTML part', () => {
    const d = composeDigest({
      ...base,
      status: status({ tenants: [tenant('tnl', { state: 'down', error: '<script>x</script>' })] }),
    })
    expect(d.html).not.toContain('<script>')
    expect(d.html).toContain('&lt;script&gt;')
  })
})

describe('digestIsDue', () => {
  const at = (iso: string) => Date.parse(iso)

  it('⚠️ is never due on a control plane that has never sent one', () => {
    // Otherwise a container started at 23:00 fires a digest covering nothing,
    // seconds after a deploy. The caller seeds the timestamp instead.
    expect(digestIsDue(at('2026-09-05T23:00:00Z'), null, 8)).toBe(false)
  })

  it('waits for the scheduled hour', () => {
    expect(digestIsDue(at('2026-09-05T07:59:00Z'), '2026-09-04T08:00:00Z', 8)).toBe(false)
    expect(digestIsDue(at('2026-09-05T08:00:00Z'), '2026-09-04T08:00:00Z', 8)).toBe(true)
  })

  it('sends once a day, not once a cycle', () => {
    expect(digestIsDue(at('2026-09-05T12:00:00Z'), '2026-09-05T08:00:30Z', 8)).toBe(false)
  })

  it('⚠️ does not drift later each day', () => {
    // An elapsed-time check ("24h since the last one") walks the send time
    // later on every cycle and eventually crosses midnight into the wrong date.
    // Anchored to the scheduled instant, a send at 08:04 still lets tomorrow's
    // 08:00 fire.
    expect(digestIsDue(at('2026-09-06T08:00:10Z'), '2026-09-05T08:04:00Z', 8)).toBe(true)
  })
})

// ── The loop, end to end ────────────────────────────────────────────────────

function fakeStore(): IncidentStore & { events: AlertEvent[]; state: Map<string, unknown> } {
  let incidents: Incident[] = []
  const events: AlertEvent[] = []
  const state = new Map<string, unknown>()
  return {
    events,
    state,
    async load() { return incidents.map((i) => ({ ...i })) },
    async save(r: Reconciliation, nowIso: string) {
      incidents = r.incidents.map((i) => ({ ...i }))
      for (const [kind, list] of [['opened', r.opened], ['resolved', r.resolved]] as const) {
        for (const i of list) {
          events.unshift({ key: i.key, kind, severity: i.severity, title: i.title, detail: i.detail, at: nowIso })
        }
      }
    },
    async recentEvents() { return events },
    async getState<T>(key: string) { return (state.has(key) ? (state.get(key) as T) : null) },
    async setState(key: string, value: unknown) { state.set(key, value) },
  }
}

/** A backup directory with one fresh dump, so backup rules stay quiet. */
function healthyBackupDir(slug: string) {
  const dir = mkdtempSync(join(tmpdir(), 'alerting-'))
  writeFileSync(join(dir, `faction_${slug}_20260905T010000Z.sql.gz`), 'x')
  return dir
}

describe('runCycle', () => {
  const fakeDb = (rows: unknown[]) => ({
    query: async (sql: string) =>
      sql.includes('pg_database')
        ? { rows }
        : { rows: [{ schema_version: 2, oc_model_version: null, items_synced_at: null }] },
  }) as any

  // Disk thresholds are pinned past 100 so the CI runner's real free space
  // cannot make this suite pass or fail on something unrelated.
  const thresholds = { ...DEFAULT_THRESHOLDS, diskUrgentPercent: 101, diskNoticePercent: 101 }

  it('⚠️ polls a down tenant repeatedly and sends exactly one Discord message', async () => {
    const posts: string[] = []
    const store = fakeStore()
    const backupDir = healthyBackupDir('tnl')
    const deps = {
      collector: {
        db: fakeDb([{ datname: 'faction_tnl' }]),
        backupDir,
        fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      },
      store,
      thresholds,
      discordWebhookUrl: 'https://discord.test/hook',
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        posts.push(String(init?.body))
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    }

    for (let i = 0; i < 5; i += 1) {
      await runCycle({ ...deps, now: () => Date.parse(NOW) + i * 60_000 })
    }

    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain('tnl is down')
    expect(store.events.filter((e) => e.kind === 'opened')).toHaveLength(1)
  })

  it('announces the recovery once, and only once', async () => {
    const posts: string[] = []
    const store = fakeStore()
    const backupDir = healthyBackupDir('tnl')
    let healthy = false
    const tenantFetch = (async () => {
      if (!healthy) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ status: 'ok', db: 'up' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const deps = {
      collector: { db: fakeDb([{ datname: 'faction_tnl' }]), backupDir, fetchImpl: tenantFetch },
      store,
      thresholds,
      discordWebhookUrl: 'https://discord.test/hook',
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        posts.push(String(init?.body))
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    }

    for (let i = 0; i < 3; i += 1) await runCycle({ ...deps, now: () => Date.parse(NOW) + i * 60_000 })
    healthy = true
    for (let i = 3; i < 8; i += 1) await runCycle({ ...deps, now: () => Date.parse(NOW) + i * 60_000 })

    expect(posts).toHaveLength(2)
    expect(posts[1]).toContain('Resolved')
  })

  it('⚠️ seeds the digest clock on the first run instead of mailing immediately', async () => {
    const store = fakeStore()
    const backupDir = healthyBackupDir('tnl')
    const r = await runCycle({
      collector: {
        db: fakeDb([{ datname: 'faction_tnl' }]),
        backupDir,
        fetchImpl: (async () => new Response(JSON.stringify({ status: 'ok', db: 'up' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      },
      store,
      thresholds,
      now: () => Date.parse('2026-09-05T23:00:00Z'),
    })
    expect(r.digest).toBe('not_due')
    expect(store.state.get(DIGEST_STATE_KEY)).toBe('2026-09-05T23:00:00.000Z')
  })

  it('⚠️ records the digest as sent even when SMTP is unconfigured', async () => {
    // Otherwise one broken credential becomes 1,440 delivery attempts a day —
    // and a retried daily summary is a duplicate of tomorrow's mail, not a
    // recovery of today's.
    const store = fakeStore()
    const backupDir = healthyBackupDir('tnl')
    store.state.set(DIGEST_STATE_KEY, '2026-09-04T08:00:00.000Z')
    const deps = {
      collector: {
        db: fakeDb([{ datname: 'faction_tnl' }]),
        backupDir,
        fetchImpl: (async () => new Response(JSON.stringify({ status: 'ok', db: 'up' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      },
      store,
      thresholds,
      now: () => Date.parse('2026-09-05T08:30:00Z'),
    }
    expect((await runCycle(deps)).digest).toBe('not_configured')
    expect(store.state.get(DIGEST_STATE_KEY)).toBe('2026-09-05T08:30:00.000Z')
    // Second cycle in the same day must not try again.
    expect((await runCycle({ ...deps, now: () => Date.parse('2026-09-05T08:31:00Z') })).digest).toBe('not_due')
  })
})

// ── Routes ──────────────────────────────────────────────────────────────────

describe('the alert routes', () => {
  const SECRET = 'admin-session-secret-for-alerting'
  const TOTP = generateTotpSecret()

  const build = async (surface: 'public' | 'local' = 'public') => {
    const store = fakeStore()
    const collector = {
      db: {
        query: async (sql: string) =>
          sql.includes('pg_database')
            ? { rows: [{ datname: 'faction_tnl' }] }
            : { rows: [{ schema_version: 2, oc_model_version: null, items_synced_at: null }] },
      } as any,
      backupDir: '/nonexistent',
      fetchImpl: (async () => new Response(JSON.stringify({ status: 'ok', db: 'up' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    }
    const app = await buildAdminApp({
      surface, username: 'u', passwordHash: await hashPassword('a-long-test-password'),
      totpSecret: TOTP, sessionSecret: SECRET, version: '9.9.9',
      collector, alerts: { collector, store },
    })
    return { app, store }
  }

  const auth = async (surface: 'public' | 'local' = 'public') =>
    ({ authorization: `Bearer ${await mintAdminSession(SECRET, 'u', surface)}` })

  it('requires authentication', async () => {
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: '/api/admin/alerts' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/admin/digest' })).statusCode).toBe(401)
    await app.close()
  })

  it('reports open incidents and recent events', async () => {
    const { app, store } = await build()
    await store.save(
      reconcile(reconcile([], [{ key: 'k', severity: 'urgent', title: 'boom', detail: 'd' }], NOW).incidents,
        [{ key: 'k', severity: 'urgent', title: 'boom', detail: 'd' }], NOW),
      NOW
    )
    const res = await app.inject({ method: 'GET', url: '/api/admin/alerts', headers: await auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().open).toHaveLength(1)
    expect(res.json().events[0]).toMatchObject({ kind: 'opened', title: 'boom' })
    await app.close()
  })

  it('previews the digest without sending anything', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/admin/digest', headers: await auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().subject).toContain('[fleet]')
    expect(res.json().text).toContain('TENANTS')
    await app.close()
  })

  it('⚠️ will not send a real digest from the public surface', async () => {
    // Sending mail on demand is the one route here that makes the container
    // reach outward — an amplifier for anyone who got past the login. It is
    // registered only on the tunnel-only listener, so this 404s because it does
    // not exist rather than because a guard said no.
    const { app } = await build('public')
    expect((await app.inject({
      method: 'POST', url: '/api/admin/local/digest/send', headers: await auth(),
    })).statusCode).toBe(404)
    await app.close()
  })

  it('offers it on the local surface, where SMTP can be proved to work', async () => {
    const { app } = await build('local')
    const res = await app.inject({
      method: 'POST', url: '/api/admin/local/digest/send', headers: await auth('local'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().result).toBe('not_configured')
    await app.close()
  })
})
