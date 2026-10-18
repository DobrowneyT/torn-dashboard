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

  /**
   * ⚠️ This said `visitors CAN claim dibs (the one visitor-permitted mutation)`.
   * #922 removed that role; the route stays on `requireAuth()`, so any
   * authenticated member may claim — which is what dibs is for. Re-pointed at an
   * ordinary member so the open-to-all-members contract is still asserted rather
   * than merely assumed.
   */
  it('any authenticated member can claim dibs', async () => {
    const claim = await call('POST', '/api/war-room/dibs', { target_id: 90202 }, 'rival')
    expect(claim.status).toBe(200)
    const row = await stack.db.query(
      `SELECT claimed_by FROM war_room_dibs_v2 WHERE target_id = 90202 AND deleted_at IS NULL`
    )
    expect(row.rows[0].claimed_by).toBe(1401)
  })

  /**
   * #530 — why a claim ended, recorded at the moment it ends.
   *
   * ⚠️ These are the cases that CANNOT be reconstructed later. Everything about
   * whether a claim converted lives in `faction_attacks` and can be joined
   * retroactively; the holder's intent — gave it back, hopped to another
   * target, was overridden by a lead — exists only here, at release time. A war
   * that runs without this is a war whose intent data is gone.
   */
  describe('release reasons', () => {
    const reasonFor = async (targetId: number) => {
      const r = await stack.db.query(
        `SELECT release_reason FROM war_room_dibs_v2
         WHERE target_id = $1 ORDER BY id DESC LIMIT 1`,
        [targetId]
      )
      return r.rows[0]?.release_reason ?? null
    }

    it('a live claim carries no reason until it ends', async () => {
      await call('POST', '/api/war-room/dibs', { target_id: 90210 })
      // ⚠️ NULL, not a placeholder: "still held" and "released for an unknown
      // reason" must stay distinguishable, because pre-0072 rows are the latter.
      expect(await reasonFor(90210)).toBeNull()
    })

    it('hopping to another target is superseded, not manual', async () => {
      // The holder did not give 90210 back — the single-dibs rule took it when
      // they claimed 90211. Counting that as a deliberate release would read
      // target-hopping as conscientiousness.
      await call('POST', '/api/war-room/dibs', { target_id: 90211 })
      expect(await reasonFor(90210)).toBe('superseded')
    })

    it('a holder releasing their own claim is manual', async () => {
      await call('DELETE', '/api/war-room/dibs/90211')
      expect(await reasonFor(90211)).toBe('manual')
    })

    it('a lead releasing someone ELSE\'s claim is admin', async () => {
      await call('POST', '/api/war-room/dibs', { target_id: 90212 }, 'rival')
      await call('DELETE', '/api/war-room/dibs/90212', undefined, 'admin')
      expect(await reasonFor(90212)).toBe('admin')
    })

    /**
     * ⚠️ The case that is easy to get backwards. The admin branch is the only
     * one that can touch another member's row, so the reason has to be decided
     * per row by WHO HELD IT — not by which branch ran. Deciding it by branch
     * files every lead's own release under moderation, and a lead who uses the
     * board normally then looks like they are overriding people all day.
     */
    it('a lead releasing their OWN claim is manual, not admin', async () => {
      await call('POST', '/api/war-room/dibs', { target_id: 90213 }, 'admin')
      await call('DELETE', '/api/war-room/dibs/90213', undefined, 'admin')
      expect(await reasonFor(90213)).toBe('manual')
    })

    it('clearing the board is reset — blameless, and must not read as a failure', async () => {
      await call('POST', '/api/war-room/dibs', { target_id: 90214 })
      const { clearWarRoomState } = await import('../src/warRoomSetup.js')
      await clearWarRoomState(stack.db)
      expect(await reasonFor(90214)).toBe('reset')
    })
  })
})

// MonChoon's spec, verbatim in effect: "I press the help button once and it
// shows x1. If I press the button again before someone joins it now shows x2.
// If its showing x2 and one of our members joins then it decrements itself to
// x1, another player joins and the request disappears entirely."
//
// The decrement is driven by OBSERVATION, not acknowledgement — a button press
// means "I intend to", which is not the same as going. Torn's attack-page fight
// log shows other players' actions, so the honest signal is available.
describe('assist counters (#591)', () => {
  const T = 90400

  /**
   * #617: counts live on the TARGET, per kind. The old helper took a requester
   * because a request was owned by one; there is no owner any more.
   */
  async function counts(targetId: number): Promise<any> {
    const r = await stack.db.query(
      `SELECT help_wanted, smoke_wanted, tear_wanted, help_raised_by
         FROM war_room_assist_counts_v2 WHERE target_id = $1`,
      [targetId]
    )
    return r.rows[0] ?? null
  }
  const wanted = async (targetId: number, kind: 'help' | 'smoke' | 'tear') =>
    Number((await counts(targetId))?.[`${kind}_wanted`] ?? 0)

  /**
   * Total still wanted on a target, across kinds, or null when nothing is.
   *
   * Shaped to read like the pre-#617 helper it replaces so the observation
   * tests below — which each raise exactly ONE kind per target, making the
   * total and that kind's count the same number — keep asserting precisely
   * what they asserted before the model changed. Their subject is the
   * observation pipeline, not the counter's shape.
   */
  async function liveAssist(targetId: number): Promise<any> {
    const row = await counts(targetId)
    if (!row) return null
    const total = Number(row.help_wanted) + Number(row.smoke_wanted) + Number(row.tear_wanted)
    return total > 0 ? { wanted: total } : null
  }

  /** Put a member on the war roster so the server can resolve their name. */
  async function seedRosterMember(id: number, name: string, factionId: string) {
    await stack.db.query(
      `INSERT INTO war_room_state_v2 (member_id, faction_id, member_name, level, state)
       VALUES ($1, $2, $3, 50, '{}'::jsonb)
       ON CONFLICT (member_id) DO UPDATE
         SET member_name = EXCLUDED.member_name, faction_id = EXCLUDED.faction_id,
             deleted_at = NULL, updated_at = now()`,
      [id, factionId, name]
    )
  }

  it('a fresh request starts at one', async () => {
    const res = await call('POST', '/api/war-room/assist', { target_id: T, kind: 'smoke' })
    expect(res.status).toBe(200)
    expect(await wanted(T, 'smoke')).toBe(1)
  })

  it('pressing the SAME kind on the SAME target again raises the count', async () => {
    for (let i = 0; i < 3; i++) {
      await call('POST', '/api/war-room/assist', { target_id: T + 1, kind: 'smoke' })
    }
    expect(await wanted(T + 1, 'smoke')).toBe(3)
  })

  it('⚠️ #617: kinds COEXIST — a tear does not erase a smoke', async () => {
    // This inverts the #523 rule. A target can need a smoke AND a tear AND a
    // body, and asking for one must not cancel another. The previous version
    // of this test asserted the opposite and was named for it.
    await call('POST', '/api/war-room/assist', { target_id: T + 2, kind: 'smoke' })
    await call('POST', '/api/war-room/assist', { target_id: T + 2, kind: 'smoke' })
    await call('POST', '/api/war-room/assist', { target_id: T + 2, kind: 'tear' })
    expect(await counts(T + 2)).toMatchObject({
      smoke_wanted: 2, tear_wanted: 1, help_wanted: 0,
    })
  })

  it('⚠️ #617: a request on another target leaves the first one standing', async () => {
    // Under #523 one live request per requester meant a second target wiped
    // the first — you were "one person in one fight". A request is a property
    // of the FIGHT, and two fights can both need help.
    await call('POST', '/api/war-room/assist', { target_id: T + 3, kind: 'help' })
    await call('POST', '/api/war-room/assist', { target_id: T + 3, kind: 'help' })
    await call('POST', '/api/war-room/assist', { target_id: T + 4, kind: 'help' })
    expect(await wanted(T + 3, 'help')).toBe(2)
    expect(await wanted(T + 4, 'help')).toBe(1)
  })

  it('⚠️ #617: a SECOND person reinforces rather than replacing', async () => {
    // The case the issue is built on. Whoever joined a fight is now IN it and
    // is best placed to say more help is needed — and under the old rule their
    // request cancelled the one that brought them.
    await call('POST', '/api/war-room/assist', { target_id: T + 40, kind: 'help' })
    await call('POST', '/api/war-room/assist', { target_id: T + 40, kind: 'help' }, 'rival')
    expect(await wanted(T + 40, 'help')).toBe(2)
  })

  describe('an observed event has to be about THIS target (#618)', () => {
    const OURS2 = 60011
    const OTHER = 60012

    it('\u26A0\uFE0F ignores an event whose subject is somebody else', async () => {
      // Fights chain: one log carries grenades and joins aimed at several
      // people at once, including at us. Deciding this on the client meant
      // scraping the defender's name off a page that does not reliably render
      // it — and when it was missing, nothing was reported at all.
      await seedRosterMember(OURS2, 'Helper2', TEST_FACTION.tornFactionId)
      await seedRosterMember(T + 30, 'RealTarget', 99999)
      await seedRosterMember(OTHER, 'SomeoneElse', 99999)
      await call('POST', '/api/war-room/assist', { target_id: T + 30, kind: 'smoke' })

      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 30,
        events: [{ kind: 'smoke', actor_name: 'Helper2', subject_name: 'SomeoneElse', at_ms: 1_700_000_100_000 }],
      })
      expect(res.body.counted).toBe(0)
      expect((await liveAssist(T + 30)).wanted).toBe(1)
    })

    it('counts it when the subject IS the target', async () => {
      await seedRosterMember(OURS2, 'Helper2', TEST_FACTION.tornFactionId)
      await seedRosterMember(T + 31, 'RealTarget31', 99999)
      await call('POST', '/api/war-room/assist', { target_id: T + 31, kind: 'smoke' })

      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 31,
        events: [{ kind: 'smoke', actor_name: 'Helper2', subject_name: 'RealTarget31', at_ms: 1_700_000_200_000 }],
      })
      expect(res.body.counted).toBe(1)
      expect(await liveAssist(T + 31)).toBeNull()   // decremented to zero
    })

    it('still accepts a report with no subject, from a script that filters its own', async () => {
      // An older userscript in the wild must not be silently switched off by
      // an upgrade it never took.
      await seedRosterMember(OURS2, 'Helper2', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 32, kind: 'smoke' })
      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 32,
        events: [{ kind: 'smoke', actor_name: 'Helper2', at_ms: 1_700_000_300_000 }],
      })
      expect(res.body.counted).toBe(1)
    })
  })

  describe('holding the button takes one back (#600)', () => {
    it('drops the count by one and reports the new value', async () => {
      for (let i = 0; i < 3; i++) {
        await call('POST', '/api/war-room/assist', { target_id: T + 20, kind: 'smoke' })
      }
      const res = await call('POST', '/api/war-room/assist/decrement', { target_id: T + 20, kind: 'smoke' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ wanted: 2, cleared: false })
      expect(await wanted(T + 20, 'smoke')).toBe(2)
    })

    it('at one, taking the last one back clears the request', async () => {
      // "Decrement to zero" and "cancel" are the same act, so there is no
      // separate rule for cancelling.
      await call('POST', '/api/war-room/assist', { target_id: T + 21, kind: 'tear' })
      const res = await call('POST', '/api/war-room/assist/decrement', { target_id: T + 21, kind: 'tear' })
      expect(res.body).toMatchObject({ wanted: 0, cleared: true })
      expect(await wanted(T + 21, 'tear')).toBe(0)
    })

    it('does nothing at all when nothing is live on that target', async () => {
      // A hold is fat-fingerable; the honest answer is silence, not an error
      // the overlay would have to render mid-fight.
      const res = await call('POST', '/api/war-room/assist/decrement', { target_id: T + 22, kind: 'help' })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ wanted: 0, cleared: false })
    })

    it('takes one off only the kind named, leaving the others standing', async () => {
      // Replaces #600's "never shaves someone ELSE's count". Under #617 there
      // is no else — the count is the target's, and MonChoon's call was that
      // anyone may take one back, because a dib expires while a fight runs
      // long and the person best placed to say "we're fine now" is whoever is
      // in it. What must still not happen is a smoke hold eating a tear.
      await call('POST', '/api/war-room/assist', { target_id: T + 23, kind: 'smoke' })
      await call('POST', '/api/war-room/assist', { target_id: T + 23, kind: 'smoke' })
      await call('POST', '/api/war-room/assist', { target_id: T + 23, kind: 'tear' })
      await call('POST', '/api/war-room/assist/decrement', { target_id: T + 23, kind: 'smoke' })
      expect(await counts(T + 23)).toMatchObject({ smoke_wanted: 1, tear_wanted: 1 })
    })

    it('⚠️ #617: anyone may take one back, not just whoever raised it', async () => {
      await call('POST', '/api/war-room/assist', { target_id: T + 24, kind: 'help' })
      const res = await call('POST', '/api/war-room/assist/decrement', { target_id: T + 24, kind: 'help' }, 'rival')
      expect(res.body).toMatchObject({ wanted: 0, cleared: true })
    })

    it('rejects a missing target, and a missing kind, rather than guessing one', async () => {
      // #617 made kind REQUIRED here: with counts per kind there is no longer
      // a single "your live request" for the server to infer.
      expect((await call('POST', '/api/war-room/assist/decrement', {})).status).toBe(400)
      expect((await call('POST', '/api/war-room/assist/decrement', { target_id: T + 25 })).status).toBe(400)
    })
  })

  describe('clearing a target outright is leads-only (#617)', () => {
    it('⚠️ a plain member cannot wipe a target’s counts', async () => {
      // Taking ONE back is everyone's (above); wiping the board is not. A
      // stray clear during a chain silently drops every outstanding call on
      // that target, and nobody watching a badge can tell it was cleared
      // rather than answered.
      await call('POST', '/api/war-room/assist', { target_id: T + 26, kind: 'help' })
      expect((await call('DELETE', `/api/war-room/assist/${T + 26}`)).status).toBe(403)
      expect(await wanted(T + 26, 'help')).toBe(1)
    })

    it('a war lead can', async () => {
      const res = await call('DELETE', `/api/war-room/assist/${T + 26}`, undefined, 'warlead')
      expect(res.status).toBe(200)
      expect(await counts(T + 26)).toMatchObject({ help_wanted: 0, smoke_wanted: 0, tear_wanted: 0 })
    })
  })

  describe('observed actions decrement it', () => {
    const OURS = 60001
    const THEIRS = 60002

    it('counts down and disappears at zero — the whole spec, end to end', async () => {
      await seedRosterMember(OURS, 'Ally', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 5, kind: 'help' })
      await call('POST', '/api/war-room/assist', { target_id: T + 5, kind: 'help' })
      expect((await liveAssist(T + 5)).wanted).toBe(2)

      const first = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 5,
        events: [{ kind: 'join', actor_name: 'Ally', at_ms: 1_700_000_000_000 }],
      })
      expect(first.status).toBe(200)
      expect((await liveAssist(T + 5)).wanted).toBe(1)

      // A SECOND, distinct event (different second) takes it to zero.
      await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 5,
        events: [{ kind: 'join', actor_name: 'Ally', at_ms: 1_700_000_050_000 }],
      })
      expect(await liveAssist(T + 5)).toBeNull()
    })

    it('⚠️ ignores an actor who is not in OUR faction — anyone can join a Torn fight, and an enemy join has the identical event class to a member helping', async () => {
      await seedRosterMember(THEIRS, 'Foe', '99999')
      await call('POST', '/api/war-room/assist', { target_id: T + 6, kind: 'help' })
      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 6,
        events: [{ kind: 'join', actor_name: 'Foe', at_ms: 1_700_000_000_000 }],
      })
      expect(res.status).toBe(200)
      expect(res.body.counted).toBe(0)
      expect((await liveAssist(T + 6)).wanted).toBe(1)
    })

    it('ignores a name it cannot resolve at all', async () => {
      await call('POST', '/api/war-room/assist', { target_id: T + 7, kind: 'smoke' })
      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 7,
        events: [{ kind: 'smoke', actor_name: 'NobodyWeKnow', at_ms: 1_700_000_000_000 }],
      })
      expect(res.body.counted).toBe(0)
      expect((await liveAssist(T + 7)).wanted).toBe(1)
    })

    it('⚠️ counts one event ONCE however many observers report it — every member with the script open sees the same log, so without this the counter drains as fast as people are watching', async () => {
      await seedRosterMember(OURS, 'Ally', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 8, kind: 'smoke' })
      await call('POST', '/api/war-room/assist', { target_id: T + 8, kind: 'smoke' })
      await call('POST', '/api/war-room/assist', { target_id: T + 8, kind: 'smoke' })

      const event = { kind: 'smoke', actor_name: 'Ally', at_ms: 1_700_000_123_000 }
      const a = await call('POST', '/api/war-room/assist/observed', { target_id: T + 8, events: [event] })
      const b = await call('POST', '/api/war-room/assist/observed', { target_id: T + 8, events: [event] }, 'rival')
      expect(a.body.counted).toBe(1)
      expect(b.body.counted).toBe(0)
      expect((await liveAssist(T + 8)).wanted).toBe(2)
    })

    it('⚠️ rounds to the second, so two observers whose clocks differ by milliseconds still collide rather than both counting', async () => {
      await seedRosterMember(OURS, 'Ally', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 9, kind: 'tear' })
      await call('POST', '/api/war-room/assist', { target_id: T + 9, kind: 'tear' })
      await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 9, events: [{ kind: 'tear', actor_name: 'Ally', at_ms: 1_700_000_200_120 }],
      })
      const second = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 9, events: [{ kind: 'tear', actor_name: 'Ally', at_ms: 1_700_000_200_880 }],
      })
      expect(second.body.counted).toBe(0)
      expect((await liveAssist(T + 9)).wanted).toBe(1)
    })

    it('only decrements requests of the MATCHING kind', async () => {
      await seedRosterMember(OURS, 'Ally', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 10, kind: 'smoke' })
      await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 10, events: [{ kind: 'tear', actor_name: 'Ally', at_ms: 1_700_000_300_000 }],
      })
      expect((await liveAssist(T + 10)).wanted).toBe(1)
    })

    it('⚠️ a join answers a `help` request — the log says "joined the fight", the request says "help", and they are the same thing under different names', async () => {
      await seedRosterMember(OURS, 'Ally', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 11, kind: 'help' })
      await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 11, events: [{ kind: 'join', actor_name: 'Ally', at_ms: 1_700_000_400_000 }],
      })
      expect(await liveAssist(T + 11)).toBeNull()
    })

    it('⚠️ a requester cannot answer their OWN call for help — they are already in the fight, and their own join would cancel the request the moment they made it', async () => {
      // The harness user 1400 is the requester; put them on the roster so the
      // observation resolves to a real in-faction member.
      await seedRosterMember(1400, 'Fighter', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 12, kind: 'help' })
      const res = await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 12,
        events: [{ kind: 'join', actor_name: 'Fighter', at_ms: 1_700_000_500_000 }],
      })
      expect(res.body.counted).toBe(0)
      expect((await liveAssist(T + 12)).wanted).toBe(1)
    })

    it('but a GRENADE the requester throws themselves does count — asking for three smokes and throwing one is one of the three', async () => {
      await seedRosterMember(1400, 'Fighter', TEST_FACTION.tornFactionId)
      await call('POST', '/api/war-room/assist', { target_id: T + 13, kind: 'smoke' })
      await call('POST', '/api/war-room/assist', { target_id: T + 13, kind: 'smoke' })
      await call('POST', '/api/war-room/assist/observed', {
        target_id: T + 13,
        events: [{ kind: 'smoke', actor_name: 'Fighter', at_ms: 1_700_000_600_000 }],
      })
      expect((await liveAssist(T + 13)).wanted).toBe(1)
    })

    it('rejects a malformed body rather than guessing', async () => {
      expect((await call('POST', '/api/war-room/assist/observed', { events: [] })).status).toBe(400)
      expect((await call('POST', '/api/war-room/assist/observed', { target_id: T })).status).toBe(400)
    })
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
    const live = frame.rows.find((r: any) => r.target_id === 90300)
    // #617: no requester_id/requester_name on the wire any more — MonChoon's
    // call was "drop the name, show the count only".
    expect(live).toMatchObject({ target_id: 90300, smoke_wanted: 1, help_wanted: 0 })
    // Armed at raise, always — unlike dibs there is no "still in hospital, no
    // deadline yet" state. Per-kind since #617.
    expect(live.smoke_raised_at).toBeTruthy()

    watcher.ws.close()
  })

  // ⚠️ #523's "one live assist per requester: a second request (any target,
  // any kind) tombstones the first" test USED to live here. That rule is what
  // #617 removes, so the test is not repaired but inverted, and it now sits
  // with its siblings in the #591 block above as "a request on another target
  // leaves the first one standing".

  it('two different requesters raising the SAME kind on the SAME target stack up', async () => {
    // Was "…can raise a hand at once", asserting two rows. Since #617 there is
    // one row per target, so the observable is the count rather than the
    // cardinality — the point of the test is unchanged.
    await call('POST', '/api/war-room/assist', { target_id: 90303, kind: 'tear' })
    const rival = await call('POST', '/api/war-room/assist', { target_id: 90303, kind: 'tear' }, 'rival')
    expect(rival.status).toBe(200)

    const live = await stack.db.query(
      `SELECT tear_wanted FROM war_room_assist_counts_v2 WHERE target_id = 90303`
    )
    expect(Number(live.rows[0].tear_wanted)).toBe(2)
  })

  it('an admin can clear a target outright', async () => {
    // The member-denied half of this moved to the #617 leads-only block above;
    // what remains here is that leadership retains the override it always had.
    await call('POST', '/api/war-room/assist', { target_id: 90305, kind: 'smoke' })
    const adminCleared = await call('DELETE', '/api/war-room/assist/90305', undefined, 'admin')
    expect(adminCleared.status).toBe(200)
    const gone = await stack.db.query(
      `SELECT smoke_wanted FROM war_room_assist_counts_v2 WHERE target_id = 90305`
    )
    expect(Number(gone.rows[0].smoke_wanted)).toBe(0)
  })

  // ⚠️ Was `visitors CAN raise their hand` (#922 removed the role). Same point as
  // dibs: open to any authenticated member, and still worth asserting.
  it('any authenticated member can raise their hand', async () => {
    const req = await call('POST', '/api/war-room/assist', { target_id: 90306, kind: 'smoke' }, 'rival')
    expect(req.status).toBe(200)
    const row = await stack.db.query(
      `SELECT smoke_wanted FROM war_room_assist_counts_v2 WHERE target_id = 90306`
    )
    expect(Number(row.rows[0].smoke_wanted)).toBe(1)
  })

  it('the delta/snapshot endpoint carries an assist channel', async () => {
    await call('POST', '/api/war-room/assist', { target_id: 90307, kind: 'help' })
    const delta = await call('GET', '/api/war-room/delta')
    expect(delta.body.assist.rows.some((r: any) => r.target_id === 90307 && !r.deleted_at)).toBe(true)
  })
})

describe('loadout capture (#528 Part 2)', () => {
  const validLoadout = {
    weapons: { primary: { name: 'AK-47', item_id: 1 }, melee: { name: 'Bat' } },
    armor: { chest: { name: 'Combat Vest' } },
  }

  it('a valid capture propagates to connected clients on the loadout channel', async () => {
    const watcher = await wsConnect(tokens.rival)
    await watcher.next((m) => m.type === 'snapshot')

    const res = await call('POST', '/api/war-room/loadout', { target_id: 90500, war_id: 700, loadout: validLoadout })
    expect(res.status).toBe(200)

    const frame = await watcher.next((m) => m.type === 'delta' && m.channel === 'loadout')
    const row = frame.rows.find((r: any) => r.target_id === 90500)
    expect(row).toBeTruthy()
    expect(row.observed_by).toBe(1400)
    expect(row.observed_by_name).toBe('Fighter')
    expect(row.loadout).toMatchObject(validLoadout)
    expect(row.updated_at).toBeTruthy() // observed_at aliased for the generic merge

    watcher.ws.close()
  })

  it('rejects a missing target_id', async () => {
    const res = await call('POST', '/api/war-room/loadout', { loadout: validLoadout })
    expect(res.status).toBe(400)
  })

  it('rejects a loadout with no captured slots', async () => {
    const res = await call('POST', '/api/war-room/loadout', { target_id: 90501, loadout: { weapons: {}, armor: {} } })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown slot name', async () => {
    const res = await call('POST', '/api/war-room/loadout', {
      target_id: 90502,
      loadout: { weapons: { bazooka: { name: 'RPG' } } },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a malformed slot entry (missing name)', async () => {
    const res = await call('POST', '/api/war-room/loadout', {
      target_id: 90503,
      loadout: { weapons: { primary: { item_id: 1 } } },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an oversized payload', async () => {
    const res = await call('POST', '/api/war-room/loadout', {
      target_id: 90504,
      loadout: { weapons: { primary: { name: 'A'.repeat(5000) } } },
    })
    expect(res.status).toBe(400)
  })

  it('rejects a bogus item_id (non-integer / out of range)', async () => {
    const res = await call('POST', '/api/war-room/loadout', {
      target_id: 90505,
      loadout: { weapons: { primary: { name: 'AK-47', item_id: -3 } } },
    })
    expect(res.status).toBe(400)
  })

  it('rate-limits per member — the Nth+1 valid capture in the window is refused', async () => {
    let last: { status: number; body: any } | null = null
    for (let i = 0; i < 31; i++) {
      last = await call('POST', '/api/war-room/loadout', {
        target_id: 90600 + i,
        loadout: { weapons: { primary: { name: 'AK-47' } } },
      }, 'warlead')
    }
    expect(last?.status).toBe(429)
  })

  it('every observation is kept — a second capture against the same target does not replace the first', async () => {
    await call('POST', '/api/war-room/loadout', { target_id: 90506, loadout: { weapons: { primary: { name: 'AK-47' } } } }, 'admin')
    await call('POST', '/api/war-room/loadout', { target_id: 90506, loadout: { weapons: { primary: { name: 'Glock' } } } }, 'admin')
    const rows = await stack.db.query(
      `SELECT loadout FROM war_room_loadout_observations_v2 WHERE target_id = 90506 ORDER BY observed_at ASC`
    )
    expect(rows.rows).toHaveLength(2)
  })

  it('the delta/snapshot endpoint carries a loadout channel, collapsed to latest per target', async () => {
    await call('POST', '/api/war-room/loadout', { target_id: 90507, loadout: { weapons: { primary: { name: 'AK-47' } } } }, 'admin')
    await call('POST', '/api/war-room/loadout', { target_id: 90507, loadout: { weapons: { primary: { name: 'Glock' } } } }, 'admin')
    const delta = await call('GET', '/api/war-room/delta')
    const rows = delta.body.loadout.rows.filter((r: any) => r.target_id === 90507)
    expect(rows).toHaveLength(1)
    expect(rows[0].loadout.weapons.primary.name).toBe('Glock')
  })
})

describe('chain save', () => {
  it('one member holds the save at a time; broadcasts ride the chain channel', async () => {
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

    // ⚠️ A visitor-refusal assertion sat here. The route's only guard WAS the
    // visitor check, so #922 converted it to `requireAuth()`: any authenticated
    // member may take the save, which the holder-swap above already exercises.
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
  it('members submit and revise; leads read results', async () => {
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
    // answered?").
    expect((await call('GET', '/api/war-room/roll-call?war_id=700', undefined, 'member')).status).toBe(200)

    // ⚠️ A visitor write-refusal sat here; the route's only guard WAS that check,
    // so #922 left it on `requireAuth()`. The 400 below still proves the handler
    // is reached and validates.
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

    // Members can't write notes.
    expect((await call('PUT', '/api/war-room/notes', { war_id: 700 }, 'member')).status).toBe(403)
  })

  it('changing the war type after the reports posted re-opens them for an edit', async () => {
    await stack.db.query(
      `INSERT INTO member_thread_outbox (member_id, kind, subject, payload, posted_at, message_id)
       VALUES ('9101', 'war_report', 'war:701', '{"war_id":701}', now(), '555'),
              ('9102', 'war_report', 'war:701', '{"war_id":701}', NULL, NULL),
              ('9103', 'war_report', 'war:702', '{"war_id":702}', now(), '556')`)
    const first = await call('PUT', '/api/war-room/notes', { war_id: 701, notes_public: 'x' }, 'warlead')
    expect(first.body.reports_requeued).toBe(0)

    const typed = await call('PUT', '/api/war-room/notes', {
      war_id: 701, war_type: 'termed', notes_public: 'x', expected_updated_at: first.body.updated_at,
    }, 'warlead')
    expect(typed.status).toBe(200)
    expect(typed.body.reports_requeued).toBe(1)
    const rows = await stack.db.query(
      `SELECT member_id, posted_at, message_id FROM member_thread_outbox
        WHERE member_id IN ('9101','9103') ORDER BY member_id`)
    // Re-opened, message id kept so the bot edits; another war untouched.
    expect(rows.rows[0]).toMatchObject({ member_id: '9101', posted_at: null, message_id: '555' })
    expect(rows.rows[1].posted_at).not.toBeNull()

    // Saving again with the same type re-opens nothing.
    const same = await call('PUT', '/api/war-room/notes', {
      war_id: 701, war_type: 'termed', notes_public: 'y', expected_updated_at: typed.body.updated_at,
    }, 'warlead')
    expect(same.body.reports_requeued).toBe(0)
  })

  it('public notes readable by any member; the private note only by leads', async () => {
    const pub = await call('GET', '/api/war-room/notes/700')
    expect(pub.status).toBe(200)
    expect(pub.body.notes.notes_public).toBe('Focus their top 5')
    expect(JSON.stringify(pub.body)).not.toContain('Merc budget')

    const priv = await call('GET', '/api/war-room/notes/700/private', undefined, 'warlead')
    expect(priv.status).toBe(200)
    expect(priv.body.notes).toBe('Merc budget approved up to 500m')

    // ⚠️ The read used to admit the `visitor` role too, so an outsider could
    // demo the full leads view (#922 removed it). Leads only now; a plain
    // member is still refused, which is the half that matters.
    expect((await call('GET', '/api/war-room/notes/700/private', undefined, 'member')).status).toBe(403)
  })

  it('leads browse the past-wars archive (labelled by opponent + start); members cannot', async () => {
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

    // Leads only — the browse entry point is closed to ordinary members.
    expect((await call('GET', '/api/war-room/notes/archive', undefined, 'member')).status).toBe(403)
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

  it('is leads-only', async () => {
    // Same gate as the notes archive. ⚠️ It admitted the `visitor` role until
    // #922 so an outsider could demo the leads view; leads only now.
    expect((await call('GET', `/api/war-room/history/${OPP}`, undefined, 'admin')).status).toBe(200)
    expect((await call('GET', `/api/war-room/history/${OPP}`, undefined, 'member')).status).toBe(403)
  })
})
