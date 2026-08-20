// End-to-end CSV export (#517), black-box HTTP against a real templated
// Postgres. The point of testing this against a real database rather than a
// mock is that the whole feature is SQL: the casts, the reserved-word column,
// the cursor, and the range semantics all live in the query.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let adminToken: string
let leadToken: string
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

async function exportCsv(table: string, token: string, query = '?from=2026-08-01&to=2026-08-20') {
  const res = await fetch(`${stack.baseUrl}/api/export/${table}/csv${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

/** Split a CSV body into its header, data rows, and trailing marker. */
function parseCsv(text: string) {
  const lines = text.split('\r\n').filter((l) => l !== '')
  const marker = lines.at(-1)?.startsWith('# complete:') ? lines.pop()! : null
  return { header: (lines.shift() ?? '').split(','), rows: lines, marker }
}

const epoch = (y: number, m: number, d: number, h = 0) => Math.floor(Date.UTC(y, m - 1, d, h) / 1000)

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(
    `INSERT INTO role_assignments (torn_user_id, role) VALUES (9100, 'admin'), (9200, 'leadership')`
  )
  adminToken = await loginAs('EXPADMIN9100XXXX', '9100')
  leadToken = await loginAs('EXPLEAD9200XXXXX', '9200')
  memberToken = await loginAs('EXPMEMBER9300XXX', '9300')

  // ⚠️ The name is the formula-injection case AND the join case in one row.
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ('9300', '=cmd()|calc', true)
     ON CONFLICT (member_id) DO UPDATE SET member_name = EXCLUDED.member_name`
  )

  // Attacks. `started` is inside the range; `created_at` (our insert time) is
  // NOW, far outside it — the export must still include the row.
  await stack.db.query(
    `INSERT INTO faction_attacks (attack_id, started, ended, attacker_id, attacker_name, defender_id, defender_name, result)
     VALUES (1, $1, $2, 9300, 'Us, Comma', 500, 'Them', 'Hospitalized'),
            (2, $3, 0,  9300, 'Us',        501, 'Other', 'Lost')`,
    [epoch(2026, 8, 5, 12), epoch(2026, 8, 5, 13), epoch(2026, 8, 6)]
  )
  // Outside the range on `started`, but inserted at the same moment as the others.
  await stack.db.query(
    `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_name)
     VALUES (3, $1, 9300, 'Old')`,
    [epoch(2026, 7, 1)]
  )

  await stack.db.query(
    `INSERT INTO faction_revives (revive_id, "timestamp", reviver_id, reviver_name, target_id, target_name)
     VALUES (10, $1, 9300, 'Reviver', 500, 'Target')`,
    [epoch(2026, 8, 7)]
  )

  await stack.db.query(
    `INSERT INTO member_daily_stats (member_id, snapshot_date, personalstats, last_action_timestamp)
     VALUES ('9300', '2026-08-20', '{"xantaken": 5}'::jsonb, $1),
            ('9300', '2026-07-01', '{"xantaken": 1}'::jsonb, $1)`,
    [epoch(2026, 8, 20)]
  )

  await stack.db.query(
    `INSERT INTO member_cpr_v2 (member_id, crime_name, position_label, cpr_value, last_seen_at)
     VALUES ('9300', 'Stacking the Deck', 'Muscle', 71.5, '2026-08-10T00:00:00Z')`
  )
}, 120_000)

afterAll(async () => { await stack?.close() })

describe('what a caller may export', () => {
  it('offers leadership the Torn returns but never the roster', async () => {
    const res = await fetch(`${stack.baseUrl}/api/export/tables`, {
      headers: { authorization: `Bearer ${leadToken}` },
    })
    const body = (await res.json()) as { tables: Array<{ table: string }> }
    const names = body.tables.map((t) => t.table)
    expect(names).toContain('faction_attacks')
    expect(names).not.toContain('members')
  })

  it('offers a plain member nothing at all', async () => {
    const res = await fetch(`${stack.baseUrl}/api/export/tables`, {
      headers: { authorization: `Bearer ${memberToken}` },
    })
    expect((await res.json()) as any).toEqual({ tables: [] })
  })

  it('requires a session', async () => {
    const res = await fetch(`${stack.baseUrl}/api/export/tables`)
    expect(res.status).toBe(401)
  })
})

describe('access control', () => {
  it('404s a table that is not in the registry', async () => {
    // Not 403 — a 403 would confirm the name exists.
    expect((await exportCsv('war_room_dibs_v2', adminToken)).status).toBe(404)
    expect((await exportCsv('member_secrets', adminToken)).status).toBe(404)
  })

  it('403s a caller below the table role floor', async () => {
    expect((await exportCsv('members', leadToken)).status).toBe(403)
    expect((await exportCsv('faction_attacks', memberToken)).status).toBe(403)
  })

  it('lets an admin take an admin-floor table', async () => {
    expect((await exportCsv('member_cpr_v2', adminToken)).status).toBe(200)
  })
})

describe('the range', () => {
  it('filters on the declared event column, not on our insert time', async () => {
    // ⚠️ The trap this whole feature is shaped around. All three rows were
    // INSERTED just now; only two STARTED inside the range.
    const { rows } = parseCsv((await exportCsv('faction_attacks', leadToken)).text)
    expect(rows).toHaveLength(2)
    expect(rows.join('\n')).not.toContain('Old')
  })

  it('takes the end day whole on a date column', async () => {
    // snapshot_date 2026-08-20 with to=2026-08-20 must be present, not dropped.
    const { rows } = parseCsv((await exportCsv('member_daily_stats', leadToken)).text)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('2026-08-20')
  })

  it('rejects an unparseable or backwards range', async () => {
    expect((await exportCsv('faction_attacks', leadToken, '?from=yesterday&to=2026-08-20')).status).toBe(400)
    expect((await exportCsv('faction_attacks', leadToken, '?from=2026-08-20&to=2026-08-01')).status).toBe(400)
    expect((await exportCsv('faction_attacks', leadToken, '')).status).toBe(400)
  })
})

describe('the CSV itself', () => {
  it('carries each epoch twice: the raw integer and a readable TCT column', async () => {
    const { header, rows } = parseCsv((await exportCsv('faction_attacks', leadToken)).text)
    expect(header).toContain('started')
    expect(header).toContain('started_tct')
    const first = rows[0].split(',')
    expect(first[header.indexOf('started')]).toBe(String(epoch(2026, 8, 5, 12)))
    expect(first[header.indexOf('started_tct')]).toBe('2026-08-05 12:00:00')
  })

  it('blanks a zero epoch rather than claiming 1970', async () => {
    const { header, rows } = parseCsv((await exportCsv('faction_attacks', leadToken)).text)
    const zeroEnded = rows.map((r) => r.split(',')).find((r) => r[header.indexOf('ended')] === '0')!
    expect(zeroEnded[header.indexOf('ended_tct')]).toBe('')
  })

  it('resolves a bare member id into a name column beside it', async () => {
    const { header } = parseCsv((await exportCsv('member_cpr_v2', adminToken)).text)
    expect(header.indexOf('member_id_name')).toBe(header.indexOf('member_id') + 1)
  })

  it('neutralises a Torn name that would execute as a formula', async () => {
    // The member is literally named `=cmd()|calc`.
    const { text } = await exportCsv('member_cpr_v2', adminToken)
    // The apostrophe is what stops Excel evaluating it. No quoting is added:
    // the value holds no comma, quote or newline, and quoting it anyway would
    // be noise in every other cell of the file.
    expect(text).toContain(`,'=cmd()|calc,`)
    expect(text).not.toMatch(/,=cmd\(\)/)
  })

  it('quotes a value containing a comma without splitting the row', async () => {
    const { header, rows } = parseCsv((await exportCsv('faction_attacks', leadToken)).text)
    expect(rows.join('\n')).toContain('"Us, Comma"')
    // Every row still has the same field count once quoting is respected.
    for (const row of rows) {
      const fields = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []
      expect(fields.length - 1).toBe(header.length)
    }
  })

  it('renders a reserved-word column without a syntax error', async () => {
    const { header } = parseCsv((await exportCsv('faction_revives', leadToken)).text)
    expect(header).toContain('timestamp')
    expect(header).toContain('timestamp_tct')
  })

  it('keeps a jsonb blob intact', async () => {
    const { text } = await exportCsv('member_daily_stats', leadToken)
    expect(text).toContain('xantaken')
  })

  it('offers itself as a download', async () => {
    const { headers } = await exportCsv('faction_attacks', leadToken)
    expect(headers.get('content-type')).toContain('text/csv')
    expect(headers.get('content-disposition')).toContain('attachment')
  })
})

describe('the completion marker', () => {
  it('closes a successful export with the row count', async () => {
    const { marker, rows } = parseCsv((await exportCsv('faction_attacks', leadToken)).text)
    expect(marker).toBe(`# complete: ${rows.length} rows`)
  })

  it('marks an empty range complete rather than looking truncated', async () => {
    const { rows, marker } = parseCsv(
      (await exportCsv('faction_attacks', leadToken, '?from=2020-01-01&to=2020-01-02')).text
    )
    expect(rows).toHaveLength(0)
    expect(marker).toBe('# complete: 0 rows')
  })
})

describe('streaming', () => {
  it('pages a result larger than one cursor batch', async () => {
    // The cursor fetches 500 at a time; anything that only ever tested a
    // single batch would never exercise the loop that makes a 444k-row export
    // possible without holding it in memory.
    const rows: string[] = []
    for (let i = 0; i < 1200; i++) {
      rows.push(`(${10_000 + i}, ${epoch(2026, 9, 1) + i}, 9300, 'Bulk')`)
    }
    await stack.db.query(
      `INSERT INTO faction_attacks (attack_id, started, attacker_id, attacker_name) VALUES ${rows.join(',')}`
    )
    const { rows: out, marker } = parseCsv(
      (await exportCsv('faction_attacks', leadToken, '?from=2026-09-01&to=2026-09-02')).text
    )
    expect(out).toHaveLength(1200)
    expect(marker).toBe('# complete: 1200 rows')
  })
})
