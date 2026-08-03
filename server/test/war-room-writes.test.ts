// War-room write path (slice #72): dibs, chain save, roll call, notes —
// black-box at the HTTP seam, with broadcasts asserted at connected WS
// clients. The session identifies the actor (closing the old
// unverified-dibs trade-off). Reference: war-room-fetch edge handlers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
const tokens: Record<string, string> = {}

async function loginAs(name: string, id: string, roles: string[]) {
  const key = `${name.toUpperCase().padEnd(13, 'K')}${id.slice(0, 3)}`
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  for (const role of roles) {
    await stack.db.query('INSERT INTO role_assignments (torn_user_id, role) VALUES ($1, $2)', [id, role])
  }
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  tokens[name] = ((await res.json()) as any).token
}

async function call(method: string, path: string, payload?: unknown, as = 'member') {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[as]}` }
  if (payload !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method, headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

function wsConnect(token: string) {
  const ws = new WebSocket(`${stack.baseUrl.replace('http', 'ws')}/api/war-room/ws?token=${token}`)
  const messages: any[] = []
  ws.on('message', (d) => messages.push(JSON.parse(String(d))))
  const next = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const check = () => {
        const found = messages.find(pred)
        if (found) return resolve(found)
        setTimeout(check, 20)
      }
      check()
      setTimeout(() => reject(new Error('ws message timeout')), 5000)
    })
  return new Promise<{ ws: WebSocket; messages: any[]; next: typeof next }>((resolve, reject) => {
    ws.on('open', () => resolve({ ws, messages, next }))
    ws.on('error', reject)
  })
}

beforeAll(async () => {
  stack = await startTestStack()
  // Roster before logins: a roster-missing member's login creates a stub
  // row (fresh-faction bootstrap), which would collide with this insert.
  await stack.db.query(`
    INSERT INTO members (member_id, member_name, tier, is_current) VALUES
      ('1400', 'Fighter', 3, true),
      ('1401', 'Rival', 3, true),
      ('1403', 'Lead', 2, true),
      ('1404', 'Boss', 1, true)
  `)
  await loginAs('member', '1400', [])
  await loginAs('rival', '1401', [])
  await loginAs('visitor', '1402', ['visitor'])
  await loginAs('warlead', '1403', ['warlead'])
  await loginAs('admin', '1404', ['admin'])
  await stack.db.query(`INSERT INTO war_room_chain_v2 (id) VALUES (1)`)
}, 30000)

afterAll(async () => {
  await stack?.close()
})

describe('dibs', () => {
  it('claims propagate to connected clients; double-claims 409 with the owner', async () => {
    const watcher = await wsConnect(tokens.rival)
    await watcher.next((m) => m.type === 'snapshot')

    const claim = await call('POST', '/api/war-room/dibs', { target_id: 90200, war_id: 700 })
    expect(claim.status).toBe(200)

    // The rival's socket sees the claim sub-second.
    const frame = await watcher.next((m) => m.type === 'delta' && m.channel === 'dibs')
    const live = frame.rows.find((r: any) => !r.deleted_at)
    expect(live).toMatchObject({ target_id: 90200, claimed_by: 1400, claimed_name: 'Fighter' })

    // Someone else claiming the same target hits the constraint-backed 409.
    const rivalClaim = await call('POST', '/api/war-room/dibs', { target_id: 90200 }, 'rival')
    expect(rivalClaim.status).toBe(409)
    expect(rivalClaim.body.owner).toMatchObject({ id: 1400, name: 'Fighter' })

    // Single-dibs rule: claiming a second target tombstones the first.
    const second = await call('POST', '/api/war-room/dibs', { target_id: 90201 })
    expect(second.status).toBe(200)
    const moveFrame = await watcher.next(
      (m) => m.type === 'delta' && m.channel === 'dibs' && m.rows.some((r: any) => r.target_id === 90201)
    )
    expect(moveFrame.rows.some((r: any) => r.target_id === 90200 && r.deleted_at)).toBe(true)

    watcher.ws.close()
  })

  it('release tombstones own claims only — except admins, who can release anyone', async () => {
    // Rival can't release Fighter's dib.
    const denied = await call('DELETE', '/api/war-room/dibs/90201', undefined, 'rival')
    expect(denied.status).toBe(200) // no-op (matches legacy: filtered update)
    const still = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_dibs_v2 WHERE target_id = 90201 AND deleted_at IS NULL`
    )
    expect(still.rows[0].n).toBe(1)

    const released = await call('DELETE', '/api/war-room/dibs/90201', undefined, 'admin')
    expect(released.status).toBe(200)
    const gone = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_dibs_v2 WHERE target_id = 90201 AND deleted_at IS NULL`
    )
    expect(gone.rows[0].n).toBe(0)
  })

  it('visitors CAN claim dibs (the one visitor-permitted mutation)', async () => {
    const claim = await call('POST', '/api/war-room/dibs', { target_id: 90202 }, 'visitor')
    expect(claim.status).toBe(200)
    const row = await stack.db.query(
      `SELECT claimed_by FROM war_room_dibs_v2 WHERE target_id = 90202 AND deleted_at IS NULL`
    )
    expect(row.rows[0].claimed_by).toBe(1402)
  })
})

describe('chain save', () => {
  it('one member holds the save at a time; visitors rejected; broadcasts ride the chain channel', async () => {
    const watcher = await wsConnect(tokens.member)
    await watcher.next((m) => m.type === 'snapshot')

    const claim = await call('POST', '/api/war-room/chain-save', {})
    expect(claim.status).toBe(200)
    const frame = await watcher.next((m) => m.type === 'delta' && m.channel === 'chain')
    expect(frame.rows[0]).toMatchObject({ save_claimed_by: 1400, save_claimed_name: 'Fighter' })

    const rival = await call('POST', '/api/war-room/chain-save', {}, 'rival')
    expect(rival.status).toBe(409)
    expect(rival.body.owner).toMatchObject({ id: 1400, name: 'Fighter' })

    // Rival can't release someone else's claim; the holder can.
    await call('DELETE', '/api/war-room/chain-save', undefined, 'rival')
    const held = await stack.db.query(`SELECT save_claimed_by FROM war_room_chain_v2 WHERE id = 1`)
    expect(held.rows[0].save_claimed_by).toBe(1400)
    const release = await call('DELETE', '/api/war-room/chain-save')
    expect(release.status).toBe(200)
    const free = await stack.db.query(`SELECT save_claimed_by FROM war_room_chain_v2 WHERE id = 1`)
    expect(free.rows[0].save_claimed_by).toBeNull()

    expect((await call('POST', '/api/war-room/chain-save', {}, 'visitor')).status).toBe(403)
    watcher.ws.close()
  })
})

describe('headline banner (#158)', () => {
  it('warleads/leads/admin set + clear a headline that rides the config channel; members cannot', async () => {
    const watcher = await wsConnect(tokens.member)
    await watcher.next((m) => m.type === 'snapshot')

    // A plain member cannot set the headline.
    expect((await call('POST', '/api/war-room/headline', { text: 'STOP ALL HITS', tone: 'danger' }, 'member')).status).toBe(403)

    // A warlead sets it — broadcast rides the 'config' channel to everyone.
    const set = await call('POST', '/api/war-room/headline', { text: 'STOP ALL HITS', tone: 'danger' }, 'warlead')
    expect(set.status).toBe(200)
    const frame = await watcher.next(
      (m) => m.type === 'delta' && m.channel === 'config' && m.rows?.some((r: any) => r.headline_text === 'STOP ALL HITS')
    )
    expect(frame.rows[0]).toMatchObject({ headline_text: 'STOP ALL HITS', headline_tone: 'danger', headline_set_by: 1403 })

    // Empty text is rejected; an unknown tone falls back to neutral.
    expect((await call('POST', '/api/war-room/headline', { text: '   ' }, 'warlead')).status).toBe(400)
    await call('POST', '/api/war-room/headline', { text: 'PUSH 2 20:30', tone: 'bogus' }, 'admin')
    const toned = await stack.db.query(`SELECT headline_text, headline_tone FROM war_room_config_v2 WHERE id = 1`)
    expect(toned.rows[0]).toMatchObject({ headline_text: 'PUSH 2 20:30', headline_tone: 'neutral' })

    // Admin clears it.
    expect((await call('DELETE', '/api/war-room/headline', undefined, 'admin')).status).toBe(200)
    const cleared = await stack.db.query(`SELECT headline_text FROM war_room_config_v2 WHERE id = 1`)
    expect(cleared.rows[0].headline_text).toBeNull()

    watcher.ws.close()
  })
})

describe('roll call', () => {
  it('members submit and revise; leads read results; visitors rejected', async () => {
    const submit = await call('POST', '/api/war-room/roll-call', { war_id: 700, on_at_start: true })
    expect(submit.status).toBe(200)
    expect(submit.body.created).toBe(true)

    // Re-submitting the same answers is not a revision…
    const same = await call('POST', '/api/war-room/roll-call', { war_id: 700, on_at_start: true })
    expect(same.body.changed).toBe(false)

    // …changing them is (and Q2/Q3 only apply when not on at start).
    const revised = await call('POST', '/api/war-room/roll-call', {
      war_id: 700, on_at_start: false, can_self_hospital: true, needs_merc: false, availability: 'late_1h',
    })
    expect(revised.body.changed).toBe(true)

    const results = await call('GET', '/api/war-room/roll-call?war_id=700', undefined, 'warlead')
    expect(results.status).toBe(200)
    expect(results.body.responses).toHaveLength(1)
    expect(results.body.responses[0]).toMatchObject({
      member_id: 1400, member_name: 'Fighter', on_at_start: false,
      can_self_hospital: true, needs_merc: false, availability: 'late_1h', revised: true,
    })

    // Rows are member-visible (matches legacy RLS: the banner needs "have I
    // answered?"); visitors read too.
    expect((await call('GET', '/api/war-room/roll-call?war_id=700', undefined, 'member')).status).toBe(200)
    expect((await call('GET', '/api/war-room/roll-call?war_id=700', undefined, 'visitor')).status).toBe(200)

    expect((await call('POST', '/api/war-room/roll-call', { war_id: 700, on_at_start: true }, 'visitor')).status).toBe(403)
    expect((await call('POST', '/api/war-room/roll-call', { war_id: 700 }, 'rival')).status).toBe(400)
  })
})

describe('war notes', () => {
  it('war leads save notes with optimistic locking; concurrent editors get a clear conflict', async () => {
    const first = await call('PUT', '/api/war-room/notes', {
      war_id: 700, war_type: 'termed', termed_score_us: 3000, notes_public: 'Focus their top 10',
      notes_private: 'Merc budget approved up to 500m',
    }, 'warlead')
    expect(first.status).toBe(200)
    const lockToken = first.body.updated_at
    expect(lockToken).toBeTruthy()

    // A save carrying the current token succeeds and rotates the token.
    const second = await call('PUT', '/api/war-room/notes', {
      war_id: 700, war_type: 'termed', notes_public: 'Focus their top 5',
      expected_updated_at: lockToken,
    }, 'warlead')
    expect(second.status).toBe(200)
    expect(second.body.updated_at).not.toBe(lockToken)

    // A save carrying the STALE token conflicts.
    const stale = await call('PUT', '/api/war-room/notes', {
      war_id: 700, notes_public: 'clobber attempt', expected_updated_at: lockToken,
    }, 'warlead')
    expect(stale.status).toBe(409)
    expect(stale.body.conflict).toBe(true)

    // Members can't write notes; visitors can't either.
    expect((await call('PUT', '/api/war-room/notes', { war_id: 700 }, 'member')).status).toBe(403)
    expect((await call('PUT', '/api/war-room/notes', { war_id: 700 }, 'visitor')).status).toBe(403)
  })

  it('public notes readable by any member; the private note only by leads and visitors', async () => {
    const pub = await call('GET', '/api/war-room/notes/700')
    expect(pub.status).toBe(200)
    expect(pub.body.notes.notes_public).toBe('Focus their top 5')
    expect(JSON.stringify(pub.body)).not.toContain('Merc budget')

    const priv = await call('GET', '/api/war-room/notes/700/private', undefined, 'warlead')
    expect(priv.status).toBe(200)
    expect(priv.body.notes).toBe('Merc budget approved up to 500m')

    expect((await call('GET', '/api/war-room/notes/700/private', undefined, 'visitor')).status).toBe(200)
    expect((await call('GET', '/api/war-room/notes/700/private', undefined, 'member')).status).toBe(403)
  })

  it('leads browse the past-wars archive (labelled by opponent + start); members/visitors cannot', async () => {
    // A ranked_wars row lets the archive label the war by opponent + start.
    await stack.db.query(
      `INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name)
       VALUES (700, 1750000000, 1750600000, 55501, 'Old Rivals')
       ON CONFLICT (id) DO NOTHING`
    )

    const arch = await call('GET', '/api/war-room/notes/archive', undefined, 'warlead')
    expect(arch.status).toBe(200)
    const war700 = arch.body.wars.find((w: { war_id: number }) => Number(w.war_id) === 700)
    expect(war700).toMatchObject({ opponent_name: 'Old Rivals', notes_public: 'Focus their top 5' })
    expect(Number(war700.start_at)).toBe(1750000000)
    // The archive list never carries the private note.
    expect(JSON.stringify(arch.body)).not.toContain('Merc budget')

    // Leads only — the browse entry point is closed to members and visitors.
    expect((await call('GET', '/api/war-room/notes/archive', undefined, 'member')).status).toBe(403)
    expect((await call('GET', '/api/war-room/notes/archive', undefined, 'visitor')).status).toBe(403)
  })
})
