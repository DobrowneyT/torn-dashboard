// The Book of Grudges (#889) slice 1: black-box HTTP against the templated Postgres.
//
// The theme of these tests is the three ways this feature can quietly betray
// its own premise: a grudge with no stated reason, an own-faction target
// reaching the public list before leadership has seen it, and a change that
// leaves no trace of who made it.
//
// ⚠️ No Torn call is exercised anywhere here, because slice 1 makes none —
// every Torn call in this epic waits on the API Key Usage disclosure update
// and the forced re-accept.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'

let stack: TestStack
let member: string      // plain member
let member2: string     // a second plain member
let leader: string      // leadership

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

const call = async (method: string, path: string, tok: string, body?: unknown) => {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
const get = (p: string, t: string) => call('GET', p, t)

/**
 * Make the Torn fixture answer `/user/{id}/profile` for a target.
 *
 * ⚠️ The add route resolves the faction ITSELF now rather than trusting a
 * `faction_id` in the request body. It has to: the browser cannot know a
 * target's faction, and a client-supplied one would let anybody bypass the
 * watched-faction gate by simply not sending it.
 */
const givenTarget = (id: string, factionId: number | null, name = `Target${id}`) => {
  stack.torn.setHandler(`/v2/user/${id}/profile`, () => ({
    profile: {
      id: Number(id), name, level: 50, faction_id: factionId ?? 0,
      status: { state: 'Okay', until: 0, description: 'Okay' },
    },
  }))
}

/** No handler at all — the lookup fails and the add must fail CLOSED. */
const givenUnresolvable = (id: string) => {
  stack.torn.setHandler(`/v2/user/${id}/profile`, () => ({ error: { code: 6, error: 'Incorrect ID' } }))
}

beforeAll(async () => {
  stack = await startTestStack()
  await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (9001, 'leadership')`)
  member = await loginAs('GRUDGEMEMBER1XXX', '9010')
  member2 = await loginAs('GRUDGEMEMBER2XXX', '9020')
  leader = await loginAs('GRUDGELEADER1XXX', '9001')
})
afterAll(async () => { await stack?.close() })

const reset = async () => {
  await stack.db.query('DELETE FROM grudge_audit')
  await stack.db.query('DELETE FROM grudge_entries')
  await stack.db.query('DELETE FROM grudge_targets')
  await stack.db.query(`DELETE FROM faction_settings WHERE key = 'grudge_watched_factions'`)
}

describe('adding a grudge', () => {
  beforeAll(async () => {
    await reset()
    // ⚠️ The add path now LOOKS THE TARGET UP, and fails closed when it
    // cannot. Without a fixture profile every add here would land
    // `pending_approval` — correct behaviour, but not what this block is
    // about.
    givenTarget('5001', 99999, 'Likor')
  })

  it('⚠️ refuses a grudge with no reason — that is the whole premise', async () => {
    const r = await call('POST', '/api/grudges', member, {
      target: 'https://www.torn.com/profiles.php?XID=5001',
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/reason/i)
  })

  it('⚠️ refuses a reason that is only whitespace', async () => {
    // Otherwise a required field is bypassed by pressing space.
    const r = await call('POST', '/api/grudges', member, {
      target: '5001', reason: '    ',
    })
    expect(r.status).toBe(400)
  })

  it('refuses something that is not a profile link or an id', async () => {
    const r = await call('POST', '/api/grudges', member, {
      target: 'that one guy', reason: 'mugged me',
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/profile link or user id/i)
  })

  it('takes a pasted profile link and lands the target active', async () => {
    const r = await call('POST', '/api/grudges', member, {
      target: 'https://www.torn.com/profiles.php?XID=5001',
      reason: 'mugged me during a chain',
    })
    expect(r.status).toBe(201)
    expect(r.body.state).toBe('active')
    const list = await get('/api/grudges', member2)
    expect(list.body.targets).toHaveLength(1)
    expect(list.body.targets[0].target_id).toBe('5001')
    expect(list.body.targets[0].grudges[0].reason).toBe('mugged me during a chain')
  })

  it('⚠️ shows one target with BOTH reasons when two members add it', async () => {
    // One target, many grudges — the list must not show the same person twice.
    const r = await call('POST', '/api/grudges', member2, {
      target: '5001', reason: 'and he taunted me afterwards',
    })
    expect(r.status).toBe(201)
    const list = await get('/api/grudges', member)
    expect(list.body.targets).toHaveLength(1)
    expect(list.body.targets[0].grudges).toHaveLength(2)
  })
})

describe('⚠️ the approval gate for watched factions', () => {
  beforeAll(async () => {
    await reset()
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('grudge_watched_factions', $1)`,
      [JSON.stringify(['10739', '8103'])]
    )
  })

  it('holds a target in a watched faction off the public list', async () => {
    givenTarget('6001', 10739)
    const r = await call('POST', '/api/grudges', member, {
      target: '6001', reason: 'he knows what he did',
    })
    expect(r.status).toBe(201)
    expect(r.body.state).toBe('pending_approval')

    // Not visible to another member...
    expect((await get('/api/grudges', member2)).body.targets).toHaveLength(0)
    // ...but visible to its author, so it does not look like it vanished...
    expect((await get('/api/grudges', member)).body.targets).toHaveLength(1)
    // ...and to leadership, who have to rule on it.
    expect((await get('/api/grudges', leader)).body.targets).toHaveLength(1)
  })

  it('raises it in the leadership queue', async () => {
    const r = await get('/api/grudges/pending', leader)
    expect(r.status).toBe(200)
    expect(r.body.count).toBe(1)
    expect(r.body.pending[0].target_id).toBe('6001')
  })

  it('⚠️ does not leak the pending queue to a plain member', async () => {
    expect((await get('/api/grudges/pending', member)).status).toBe(403)
  })

  it('⚠️ compares faction ids as strings, so a numeric id still trips the gate', async () => {
    // Torn sends numbers; we store text. A mixed-type compare matches nothing,
    // which would put an own-faction target straight on the public list.
    givenTarget('6002', 10739)
    const r = await call('POST', '/api/grudges', member, {
      target: '6002', reason: 'numeric id',
    })
    expect(r.body.state).toBe('pending_approval')
    expect(r.body.pending_reason).toBe('watched_faction')
  })

  it('lets an unwatched faction straight through', async () => {
    givenTarget('6003', 99999)
    const r = await call('POST', '/api/grudges', member, {
      target: '6003', reason: 'a stranger',
    })
    expect(r.body.state).toBe('active')
    expect(r.body.pending_reason).toBeNull()
  })

  it('publishes it once leadership approves', async () => {
    const id = (await get('/api/grudges/pending', leader)).body.pending[0].id
    const r = await call('POST', `/api/grudges/targets/${id}/approve`, leader)
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('active')
    const seen = (await get('/api/grudges', member2)).body.targets.map((t: any) => t.target_id)
    expect(seen).toContain('6001')
  })

  it('⚠️ keeps a rejected target off the list for everyone but leadership', async () => {
    const pending = (await get('/api/grudges/pending', leader)).body.pending
    const id = pending[0].id
    const targetId = pending[0].target_id
    expect((await call('POST', `/api/grudges/targets/${id}/reject`, leader)).body.state).toBe('rejected')
    const memberSees = (await get('/api/grudges', member)).body.targets.map((t: any) => t.target_id)
    expect(memberSees).not.toContain(targetId)
    const leaderSees = (await get('/api/grudges', leader)).body.targets.map((t: any) => t.target_id)
    expect(leaderSees).toContain(targetId)
  })

  it('⚠️ resolves the name inline, so the list is readable immediately', async () => {
    givenTarget('6010', 99999, 'Likor')
    const r = await call('POST', '/api/grudges', member, { target: '6010', reason: 'resolved' })
    expect(r.body.target_name).toBe('Likor')
    const list = await get('/api/grudges', member)
    expect(list.body.targets.find((t: any) => t.target_id === '6010').target_name).toBe('Likor')
  })

  it('⚠️ FAILS CLOSED when the target cannot be looked up', async () => {
    // We cannot rule out that they are in a watched faction, so leadership
    // rules on it. Publishing on an unverified assumption is the one outcome
    // worth avoiding; a queue entry is merely annoying.
    givenUnresolvable('6011')
    const r = await call('POST', '/api/grudges', member, { target: '6011', reason: 'mystery' })
    expect(r.body.state).toBe('pending_approval')
    // ⚠️ And says WHY, so the UI does not claim they are in a watched faction
    // when the truth is we could not look them up at all.
    expect(r.body.pending_reason).toBe('unverified')
  })

  it('⚠️ still records the grudge when the lookup fails', async () => {
    // The grudge is the member's contribution and is worth keeping; the
    // lookup is enrichment, and the sweep will retry it.
    givenUnresolvable('6012')
    const r = await call('POST', '/api/grudges', member, { target: '6012', reason: 'kept anyway' })
    expect(r.status).toBe(201)
    const list = await get('/api/grudges', leader)
    const t = list.body.targets.find((x: any) => x.target_id === '6012')
    expect(t.grudges[0].reason).toBe('kept anyway')
  })

  it('⚠️ ignores a faction_id sent by the client', async () => {
    // Trusting it would let anybody bypass the watched-faction gate by simply
    // not sending one, or by sending a harmless-looking faction.
    givenTarget('6013', 10739)
    const r = await call('POST', '/api/grudges', member, {
      target: '6013', faction_id: '99999', reason: 'nice try',
    })
    expect(r.body.state).toBe('pending_approval')
  })

  it('⚠️ refuses a plain member trying to approve their own submission', async () => {
    const r = await call('POST', '/api/grudges/targets/1/approve', member)
    expect(r.status).toBe(403)
  })
})

describe('editing and removing', () => {
  let entryId: number
  let targetRowId: number

  beforeAll(async () => {
    await reset()
    const r = await call('POST', '/api/grudges', member, {
      target: '7001', reason: 'original reason',
    })
    entryId = r.body.entry_id
    targetRowId = r.body.target_row_id
  })

  it('lets the author edit their own grudge', async () => {
    const r = await call('PATCH', `/api/grudges/entries/${entryId}`, member, {
      reason: 'a more considered reason',
    })
    expect(r.status).toBe(200)
    expect(r.body.reason).toBe('a more considered reason')
  })

  it('⚠️ refuses an unrelated member editing somebody else’s grudge', async () => {
    const r = await call('PATCH', `/api/grudges/entries/${entryId}`, member2, {
      reason: 'not my grudge to change',
    })
    expect(r.status).toBe(403)
  })

  it('lets leadership edit anyone’s', async () => {
    const r = await call('PATCH', `/api/grudges/entries/${entryId}`, leader, {
      reason: 'tidied by leadership',
    })
    expect(r.status).toBe(200)
  })

  it('⚠️ refuses an edit that blanks the reason', async () => {
    const r = await call('PATCH', `/api/grudges/entries/${entryId}`, member, { reason: '  ' })
    expect(r.status).toBe(400)
  })

  it('⚠️ drops the target from the list when its last grudge goes', async () => {
    // A target with no grudges is on the list for no stated reason, which is
    // exactly what this feature refuses to allow.
    expect((await call('DELETE', `/api/grudges/entries/${entryId}`, member)).status).toBe(200)
    expect((await get('/api/grudges', member)).body.targets).toHaveLength(0)
  })

  it('⚠️ revives the SAME row when a removed target is re-added', async () => {
    // So its history stays attached to it rather than being orphaned.
    const r = await call('POST', '/api/grudges', member2, {
      target: '7001', reason: 'he is back at it',
    })
    expect(r.status).toBe(201)
    expect(r.body.target_row_id).toBe(targetRowId)
  })

  it('⚠️ refuses leadership-only target removal to a plain member', async () => {
    expect((await call('DELETE', `/api/grudges/targets/${targetRowId}`, member)).status).toBe(403)
  })

  it('lets leadership remove a whole target and every grudge on it', async () => {
    expect((await call('DELETE', `/api/grudges/targets/${targetRowId}`, leader)).status).toBe(200)
    expect((await get('/api/grudges', leader)).body.targets).toHaveLength(0)
  })
})

describe('⚠️ the audit trail', () => {
  beforeAll(async () => {
    await reset()
    const r = await call('POST', '/api/grudges', member, { target: '8001', reason: 'first' })
    await call('PATCH', `/api/grudges/entries/${r.body.entry_id}`, member, { reason: 'second' })
    await call('DELETE', `/api/grudges/entries/${r.body.entry_id}`, leader)
  })

  it('records who added, who changed it, and what it changed from', async () => {
    const r = await get('/api/grudges/audit?target_id=8001', member)
    expect(r.status).toBe(200)
    const actions = r.body.history.map((h: any) => h.action)
    expect(actions).toContain('added')
    expect(actions).toContain('edited')
    expect(actions).toContain('removed')

    const edit = r.body.history.find((h: any) => h.action === 'edited')
    expect(edit.old_value).toBe('first')
    expect(edit.new_value).toBe('second')
    expect(edit.actor_member_id).toBe('9010')
  })

  it('⚠️ keeps the removed reason readable — a soft delete is the point', async () => {
    const r = await get('/api/grudges/audit?target_id=8001', member)
    const removal = r.body.history.find((h: any) => h.action === 'removed' && h.field === 'reason')
    expect(removal.old_value).toBe('second')
    expect(removal.actor_member_id).toBe('9001')
  })
})

describe('settings', () => {
  beforeAll(async () => {
    await reset()
    await stack.db.query(`DELETE FROM faction_settings WHERE key = 'grudge_severities'`)
  })

  it('⚠️ returns NO severities when the faction has configured none', async () => {
    // The control then does not render. No hardcoded Low/Medium/High — an
    // absent list is honest, three invented tiers are not.
    const r = await get('/api/grudges/settings', member)
    expect(r.status).toBe(200)
    expect(r.body.severities).toEqual([])
  })

  it('returns whatever vocabulary the faction did configure', async () => {
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('grudge_severities', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify([{ id: 'petty', label: 'Petty' }, { id: 'blood', label: 'Blood feud' }])]
    )
    const r = await get('/api/grudges/settings', member)
    expect(r.body.severities.map((s: any) => s.label)).toEqual(['Petty', 'Blood feud'])
  })

  it('⚠️ does not tell a plain member which factions trip the gate', async () => {
    // It is leadership policy, and a member learns nothing useful from it.
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('grudge_watched_factions', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(['10739'])]
    )
    expect((await get('/api/grudges/settings', member)).body.watched_factions).toBeUndefined()
    expect((await get('/api/grudges/settings', leader)).body.watched_factions).toEqual(['10739'])
  })
})

describe('the target name', () => {
  beforeAll(reset)

  it('⚠️ is NOT accepted from the client, even when one is sent', async () => {
    // One source for the name — the enrichment lookup — so a rename is
    // something we observe rather than a guess somebody typed once. Trusting
    // the client here would also let anyone label a target whatever they liked.
    await call('POST', '/api/grudges', member, {
      target: '4242', target_name: 'Definitely Not Me', reason: 'he knows',
    })
    const list = await get('/api/grudges', member)
    expect(list.body.targets[0].target_name).toBeNull()
  })

  it('⚠️ leaves the name NULL rather than faking one from the id', async () => {
    // Storing the id as a stand-in would make "not looked up yet"
    // indistinguishable from somebody actually called 4243.
    await call('POST', '/api/grudges', member, { target: '4243', reason: 'anonymous grudge' })
    const list = await get('/api/grudges', member)
    const t = list.body.targets.find((x: any) => x.target_id === '4243')
    expect(t.target_name).toBeNull()
  })
})

describe('visitors', () => {
  it('⚠️ may read the list but may not add to it', async () => {
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (9030, 'visitor')`)
    const visitor = await loginAs('GRUDGEVISITOR1XX', '9030')
    expect((await get('/api/grudges', visitor)).status).toBe(200)
    const r = await call('POST', '/api/grudges', visitor, { target: '9999', reason: 'nope' })
    expect(r.status).toBe(403)
  })
})
