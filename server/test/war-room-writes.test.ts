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

describe('assist requests (#523)', () => {
  it('rejects an unknown kind and a missing target', async () => {
    const badKind = await call('POST', '/api/war-room/assist', { target_id: 90300, kind: 'nuke' })
    expect(badKind.status).toBe(400)
    const badTarget = await call('POST', '/api/war-room/assist', { kind: 'smoke' })
    expect(badTarget.status).toBe(400)
  })

  it('a request propagates to connected clients on the assist channel', async () => {
    const watcher = await wsConnect(tokens.rival)
    await watcher.next((m) => m.type === 'snapshot')

    const req = await call('POST', '/api/war-room/assist', { target_id: 90300, kind: 'smoke', war_id: 700 })
    expect(req.status).toBe(200)

    const frame = await watcher.next((m) => m.type === 'delta' && m.channel === 'assist')
    const live = frame.rows.find((r: any) => !r.deleted_at)
    expect(live).toMatchObject({ target_id: 90300, requester_id: 1400, requester_name: 'Fighter', kind: 'smoke' })
    // Armed at creation, always — unlike dibs there is no "still in hospital,
    // no deadline yet" state.
    expect(live.auto_expire_at).toBeTruthy()

    watcher.ws.close()
  })

  it('one live assist per requester: a second request (any target, any kind) tombstones the first', async () => {
    await call('POST', '/api/war-room/assist', { target_id: 90301, kind: 'smoke' })
    const second = await call('POST', '/api/war-room/assist', { target_id: 90302, kind: 'help' })
    expect(second.status).toBe(200)

    const first = await stack.db.query(
      `SELECT deleted_at FROM war_room_assists_v2 WHERE target_id = 90301 AND requester_id = 1400`
    )
    expect(first.rows[0].deleted_at).toBeTruthy()
    const live = await stack.db.query(
      `SELECT kind FROM war_room_assists_v2 WHERE target_id = 90302 AND requester_id = 1400 AND deleted_at IS NULL`
    )
    expect(live.rows[0].kind).toBe('help')
  })

  it('two different requesters can raise a hand on the SAME target at once', async () => {
    await call('POST', '/api/war-room/assist', { target_id: 90303, kind: 'tear' })
    const rival = await call('POST', '/api/war-room/assist', { target_id: 90303, kind: 'help' }, 'rival')
    expect(rival.status).toBe(200)

    const live = await stack.db.query(
      `SELECT requester_id, kind FROM war_room_assists_v2 WHERE target_id = 90303 AND deleted_at IS NULL ORDER BY requester_id`
    )
    expect(live.rows).toHaveLength(2)
  })

  it('the requester can clear their own request; a non-requester cannot; an admin can', async () => {
    await call('POST', '/api/war-room/assist', { target_id: 90304, kind: 'help' })

    const denied = await call('DELETE', '/api/war-room/assist/90304', undefined, 'rival')
    expect(denied.status).toBe(200) // filtered no-op, matches the dibs release shape
    const stillLive = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_assists_v2 WHERE target_id = 90304 AND deleted_at IS NULL`
    )
    expect(stillLive.rows[0].n).toBe(1)

    const cleared = await call('DELETE', '/api/war-room/assist/90304')
    expect(cleared.status).toBe(200)
    const gone = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_assists_v2 WHERE target_id = 90304 AND deleted_at IS NULL`
    )
    expect(gone.rows[0].n).toBe(0)

    await call('POST', '/api/war-room/assist', { target_id: 90305, kind: 'smoke' })
    const adminCleared = await call('DELETE', '/api/war-room/assist/90305', undefined, 'admin')
    expect(adminCleared.status).toBe(200)
    const goneToo = await stack.db.query(
      `SELECT count(*)::int AS n FROM war_room_assists_v2 WHERE target_id = 90305 AND deleted_at IS NULL`
    )
    expect(goneToo.rows[0].n).toBe(0)
  })

  it('visitors CAN raise their hand (the one visitor-permitted mutation, same as dibs)', async () => {
    const req = await call('POST', '/api/war-room/assist', { target_id: 90306, kind: 'smoke' }, 'visitor')
    expect(req.status).toBe(200)
    const row = await stack.db.query(
      `SELECT requester_id FROM war_room_assists_v2 WHERE target_id = 90306 AND deleted_at IS NULL`
    )
    expect(row.rows[0].requester_id).toBe(1402)
  })

  it('the delta/snapshot endpoint carries an assist channel', async () => {
    await call('POST', '/api/war-room/assist', { target_id: 90307, kind: 'help' })
    const delta = await call('GET', '/api/war-room/delta')
    expect(delta.body.assist.rows.some((r: any) => r.target_id === 90307 && !r.deleted_at)).toBe(true)
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

// #398 — history against ONE faction, not the whole archive.
//
// MonChoon: "what I was really after was specifically the history with this
// week's opponent... all of the past wars we had with that faction, namely the
// war contribution, and then if we have any notes based on our own input on
// the roll call."
describe('GET /api/war-room/history/:factionId', () => {
  const OPP = 77001
  const OTHER = 77002

  beforeAll(async () => {
    await stack.db.query(`
      INSERT INTO ranked_wars (id, start_at, end_at, opponent_id, opponent_name,
                               our_score, opponent_score, winner_faction_id) VALUES
        (8001, 1700000000, 1700200000, ${OPP},   'Old Foes', 2500, 1200, ${TEST_FACTION.tornFactionId}),
        (8002, 1600000000, 1600200000, ${OPP},   'Old Foes', 900,  1800, ${OPP}),
        (8003, 1650000000, 1650200000, ${OTHER}, 'Someone Else', 100, 50, ${TEST_FACTION.tornFactionId}),
        (8004, 1750000000, NULL,       ${OPP},   'Old Foes', 40,   30, NULL)
    `)
    await stack.db.query(`
      INSERT INTO war_member_contributions (war_id, member_id, member_name, level, attacks, score, faction_id) VALUES
        (8001, 1400, 'Ours',   40, 30, 410.25, ${TEST_FACTION.tornFactionId}),
        (8001, 1405, 'AlsoUs', 22, 12, 120.00, ${TEST_FACTION.tornFactionId}),
        (8001, 9900, 'Theirs', 60, 44, 380.00, ${OPP})
    `)
    await stack.db.query(
      `INSERT INTO war_room_notes_v2 (war_id, opponent_faction_id, notes_public, war_type)
       VALUES (8001, ${OPP}, 'They stacked at 03:00 TCT and we got caught short.', 'real')`
    )
    await stack.db.query(
      `INSERT INTO war_room_roll_call_v2 (war_id, member_id, member_name, on_at_start)
       VALUES (8001, 1400, 'Ours', true), (8001, 1405, 'AlsoUs', false)`
    )
  })

  it('returns only wars against that faction, newest first', async () => {
    const { status, body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    expect(status).toBe(200)
    expect(body.wars.map((w: any) => w.war_id)).toEqual([8001, 8002])
  })

  it('excludes the war currently in progress', async () => {
    // 8004 has no end_at — it is the matchup being fought. "Previous matchups"
    // that includes the current one reads as history the lead has not lived yet.
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    expect(body.wars.map((w: any) => w.war_id)).not.toContain(8004)
  })

  it('carries OUR contributions, not the opponent\'s', async () => {
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    const war = body.wars.find((w: any) => w.war_id === 8001)
    expect(war.our_contributions.map((c: any) => c.member_name)).toEqual(['Ours', 'AlsoUs'])
    expect(war.our_contributions.map((c: any) => c.member_name)).not.toContain('Theirs')
  })

  it('carries the roll call and the note we wrote about them', async () => {
    // The part with no other home: scores are public and contributions are
    // Torn's, but what we said about them last time exists only here.
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    const war = body.wars.find((w: any) => w.war_id === 8001)
    expect(war.notes_public).toMatch(/stacked at 03:00/)
    expect(war.roll_call).toHaveLength(2)
    expect(war.roll_call.find((r: any) => r.member_name === 'Ours').on_at_start).toBe(true)
  })

  it('returns empty arrays, not null, for a war with no notes or roll call', async () => {
    // The panel maps over these. A null would throw on a first-time-noted
    // opponent, which is the common case.
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    const war = body.wars.find((w: any) => w.war_id === 8002)
    expect(war.our_contributions).toEqual([])
    expect(war.roll_call).toEqual([])
    expect(war.notes_public).toBeNull()
  })

  it('returns nothing for a faction we have never fought', async () => {
    const { body } = await call('GET', '/api/war-room/history/999999', undefined, 'warlead')
    expect(body.wars).toEqual([])
    // And no roster to diff against — an empty array rather than a missing key,
    // so the panel's "nobody new" and "no previous war" stay distinguishable.
    expect(body.their_last_roster).toEqual([])
    expect(body.last_war_id).toBeNull()
  })

  it('carries THEIR roster from the most recent previous war, for the diff', async () => {
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    expect(body.last_war_id).toBe(8001)
    expect(body.their_last_roster.map((r: any) => r.member_name)).toEqual(['Theirs'])
    // Level travels with the row: it is already stored and level movement since
    // the last war is genuinely useful pre-war reading.
    expect(body.their_last_roster[0].level).toBe(60)
  })

  it('does not mix our roster into theirs', async () => {
    // Both sides live in war_member_contributions keyed by faction_id. Getting
    // this filter wrong would show our own members as "their roster last time",
    // which reads as plausible right up until a lead acts on it.
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    const names = body.their_last_roster.map((r: any) => r.member_name)
    expect(names).not.toContain('Ours')
    expect(names).not.toContain('AlsoUs')
  })

  it('takes the roster from the most recent war only, not every war', async () => {
    // War 8002 is older and has no stored contributions. If the roster were
    // pooled across matchups, a member who left after 8002 would resurface as
    // "still here" forever.
    await stack.db.query(
      `INSERT INTO war_member_contributions (war_id, member_id, member_name, level, attacks, score, faction_id)
       VALUES (8002, 9911, 'LongGone', 30, 5, 20.00, ${OPP})`
    )
    const { body } = await call('GET', `/api/war-room/history/${OPP}`, undefined, 'warlead')
    expect(body.their_last_roster.map((r: any) => r.member_name)).not.toContain('LongGone')
  })

  it('rejects a non-numeric faction id', async () => {
    const { status } = await call('GET', '/api/war-room/history/abc', undefined, 'warlead')
    expect(status).toBe(400)
  })

  it('is leads-only, with visitors allowed to read', async () => {
    // Same gate as the notes archive: visitors demo the full leads view and
    // this only ever reads. Plain members do not get war notes.
    expect((await call('GET', `/api/war-room/history/${OPP}`, undefined, 'visitor')).status).toBe(200)
    expect((await call('GET', `/api/war-room/history/${OPP}`, undefined, 'admin')).status).toBe(200)
    expect((await call('GET', `/api/war-room/history/${OPP}`, undefined, 'member')).status).toBe(403)
  })
})
