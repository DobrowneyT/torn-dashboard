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

/** Name a faction, so the add path can resolve it inline. */
const givenFactionName = (id: number, name: string) => {
  stack.torn.setHandler(`/v2/faction/${id}/basic`, () => ({ basic: { id, name } }))
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

describe('PUT /api/grudges/settings', () => {
  beforeAll(reset)

  it('⚠️ refuses a plain member — the watched list is the approval gate', async () => {
    // A member who could edit it could let their own faction straight onto
    // the public list.
    const r = await call('PUT', '/api/grudges/settings', member, { severities: [], watched_factions: [] })
    expect(r.status).toBe(403)
  })

  it('saves severities and watched factions for leadership', async () => {
    const r = await call('PUT', '/api/grudges/settings', leader, {
      severities: [{ label: 'Petty' }, { label: 'Blood feud' }],
      watched_factions: ['10739', 8103],
    })
    expect(r.status).toBe(200)
    expect(r.body.severities).toEqual([
      { id: 'petty', label: 'Petty' }, { id: 'blood-feud', label: 'Blood feud' },
    ])
    expect(r.body.watched_factions).toEqual(['10739', '8103'])
  })

  it('round-trips through the read the members use', async () => {
    const r = await get('/api/grudges/settings', member)
    expect(r.body.severities.map((s: any) => s.label)).toEqual(['Petty', 'Blood feud'])
    // ⚠️ Still withheld from a plain member — leadership policy, not public.
    expect(r.body.watched_factions).toBeUndefined()
  })

  it('rejects a malformed faction id rather than storing it', async () => {
    const r = await call('PUT', '/api/grudges/settings', leader, {
      severities: [], watched_factions: ['TNL'],
    })
    expect(r.status).toBe(400)
  })

  it('⚠️ a RENAME keeps every grudge’s severity', async () => {
    // The id is preserved, so nothing is orphaned and the column keeps
    // rendering a label rather than a raw slug.
    await call('PUT', '/api/grudges/settings', leader, {
      severities: [{ id: 'petty', label: 'Petty' }], watched_factions: [],
    })
    await call('POST', '/api/grudges', member, {
      target: '8801', reason: 'petty grievance', severity_id: 'petty',
    })
    const r = await call('PUT', '/api/grudges/settings', leader, {
      severities: [{ id: 'petty', label: 'Mildly annoying' }], watched_factions: [],
    })
    expect(r.body.grudges_cleared).toBe(0)
    const list = await get('/api/grudges', leader)
    const t = list.body.targets.find((x: any) => x.target_id === '8801')
    expect(t.grudges[0].severity_id).toBe('petty')
  })

  it('⚠️ a REMOVAL clears the reference and says how many', async () => {
    // Left alone, the column would render a raw slug for a severity that no
    // longer exists.
    const r = await call('PUT', '/api/grudges/settings', leader, {
      severities: [], watched_factions: [],
    })
    expect(r.body.removed_severities).toEqual(['petty'])
    expect(r.body.grudges_cleared).toBe(1)
    const list = await get('/api/grudges', leader)
    const t = list.body.targets.find((x: any) => x.target_id === '8801')
    expect(t.grudges[0].severity_id).toBeNull()
  })

  it('⚠️ and the cleared value stays readable in the history', async () => {
    // A soft record of what it was is the difference between a removal and a
    // quiet data loss.
    const r = await get('/api/grudges/audit?target_id=8801', leader)
    const cleared = r.body.history.find((h: any) => h.field === 'severity_id')
    expect(cleared.old_value).toBe('petty')
    expect(cleared.new_value).toBeNull()
  })

  it('reports usage so the editor can warn before a removal', async () => {
    await call('PUT', '/api/grudges/settings', leader, {
      severities: [{ id: 'petty', label: 'Petty' }], watched_factions: [],
    })
    await call('PATCH', `/api/grudges/entries/1`, leader, { severity_id: 'petty' })
    const r = await get('/api/grudges/settings/usage', leader)
    expect(r.status).toBe(200)
    expect(typeof r.body.usage).toBe('object')
  })

  it('⚠️ does not leak usage to a plain member', async () => {
    expect((await get('/api/grudges/settings/usage', member)).status).toBe(403)
  })
})

describe('watch mode', () => {
  beforeAll(reset)

  it('⚠️ refuses a plain member', async () => {
    expect((await call('PUT', '/api/grudges/watch', member, { enabled: true })).status).toBe(403)
  })

  it('is off until leadership turns it on', async () => {
    const r = await get('/api/grudges/settings', leader)
    expect(r.body.watch.enabled).toBe(false)
  })

  it('turns on and reports the cadence it will actually achieve', async () => {
    const r = await call('PUT', '/api/grudges/watch', leader, { enabled: true })
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
    // ⚠️ The cadence is COMPUTED, never configured — a configured rate is a
    // promise the key budget may not keep.
    expect(typeof r.body.description).toBe('string')
    expect(r.body).toHaveProperty('calls_per_sweep')
    expect(r.body).toHaveProperty('seconds_per_sweep')
  })

  it('turns back off', async () => {
    expect((await call('PUT', '/api/grudges/watch', leader, { enabled: false })).body.enabled).toBe(false)
  })
})

describe('⚠️ our own faction is always watched', () => {
  beforeAll(async () => {
    await reset()
    // Deliberately store a list that does NOT contain our own faction.
    await stack.db.query(
      `INSERT INTO faction_settings (key, value) VALUES ('grudge_watched_factions', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(['999999'])]
    )
  })

  it('holds a target from our own faction even when it is not in the list', async () => {
    // ⚠️ Read from faction_config, never written down: this stack serves five
    // factions, and a literal id would watch the wrong roster on four of them.
    const ours = await stack.db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    const ourId = Number(ours.rows[0].torn_faction_id)
    givenTarget('7777', ourId)
    const r = await call('POST', '/api/grudges', member, { target: '7777', reason: 'friendly fire' })
    expect(r.body.state).toBe('pending_approval')
    expect(r.body.pending_reason).toBe('watched_faction')
  })

  it('tells leadership which id is the automatic one', async () => {
    const r = await get('/api/grudges/settings', leader)
    expect(String(r.body.own_faction_id)).toBe(String(TEST_FACTION.tornFactionId))
    // ⚠️ NOT folded into the editable list, so nobody can delete it and
    // wonder why it comes back.
    expect(r.body.watched_factions).toEqual(['999999'])
  })

  it('still lets an unrelated faction through', async () => {
    givenTarget('7778', 12345)
    expect((await call('POST', '/api/grudges', member, { target: '7778', reason: 'stranger' })).body.state)
      .toBe('active')
  })
})

describe('⚠️ enrichment on the very first insert', () => {
  beforeAll(reset)

  it('resolves name, level, faction id AND faction name in one go', async () => {
    // The point of doing it inline: the row is useful the moment it exists,
    // rather than showing a bare id until the next sweep.
    givenTarget('9601', 4321, 'Likor')
    givenFactionName(4321, 'Some Other Faction')
    const r = await call('POST', '/api/grudges', member, { target: '9601', reason: 'enriched' })
    expect(r.body.target_name).toBe('Likor')
    expect(r.body.faction_name).toBe('Some Other Faction')

    const list = await get('/api/grudges', member)
    const t = list.body.targets.find((x: any) => x.target_id === '9601')
    expect(t.faction_id).toBe('4321')
    expect(t.faction_name).toBe('Some Other Faction')
    expect(t.level).toBe(50)
    expect(t.status_state).toBe('Okay')
  })

  it('⚠️ a missing faction NAME does not cost us the faction id', async () => {
    // The two come from different calls, and one failing must not take the
    // other with it.
    givenTarget('9602', 5555)
    const r = await call('POST', '/api/grudges', member, { target: '9602', reason: 'no name' })
    expect(r.status).toBe(201)
    const list = await get('/api/grudges', member)
    const t = list.body.targets.find((x: any) => x.target_id === '9602')
    expect(t.faction_id).toBe('5555')
    expect(t.faction_name).toBeNull()
  })

  it('⚠️ makes no faction call at all for an unfactioned target', async () => {
    // There is no faction to name, and asking for faction 0 is a wasted call
    // that would 404.
    givenTarget('9603', null)
    const r = await call('POST', '/api/grudges', member, { target: '9603', reason: 'loner' })
    expect(r.status).toBe(201)
    const list = await get('/api/grudges', member)
    const t = list.body.targets.find((x: any) => x.target_id === '9603')
    expect(t.faction_id).toBeNull()
    expect(t.faction_name).toBeNull()
  })

  it('⚠️ records no spy source when no provider is configured', async () => {
    // Not an error: a faction with neither TornStats nor BSP key simply has no
    // battle stats, and the column says so rather than showing a zero.
    const list = await get('/api/grudges', member)
    const t = list.body.targets.find((x: any) => x.target_id === '9601')
    expect(t.bsp_total).toBeNull()
    expect(t.spy_source).toBeNull()
  })

  it('⚠️ re-enriches a target that is re-added after removal', async () => {
    // A target off the list for a month may have changed faction or name
    // entirely; reviving the old row would present stale facts as current.
    const list = await get('/api/grudges', member)
    const row = list.body.targets.find((x: any) => x.target_id === '9601')
    await call('DELETE', `/api/grudges/targets/${row.id}`, leader)

    givenTarget('9601', 7777, 'LikorRenamed')
    givenFactionName(7777, 'A Different Faction')
    const again = await call('POST', '/api/grudges', member2, { target: '9601', reason: 'back again' })
    expect(again.body.target_row_id).toBe(row.id)   // same row, history intact

    const after = await get('/api/grudges', member)
    const t = after.body.targets.find((x: any) => x.target_id === '9601')
    expect(t.target_name).toBe('LikorRenamed')
    expect(t.faction_id).toBe('7777')
    expect(t.faction_name).toBe('A Different Faction')
  })

  it('⚠️ still records the grudge when every lookup fails', async () => {
    // The grudge is the member's contribution; enrichment is not.
    givenUnresolvable('9604')
    const r = await call('POST', '/api/grudges', member, { target: '9604', reason: 'kept regardless' })
    expect(r.status).toBe(201)
    expect(r.body.state).toBe('pending_approval')
    expect(r.body.pending_reason).toBe('unverified')
  })
})

describe('claiming a target (#892)', () => {
  let rowId: number

  beforeAll(async () => {
    await reset()
    givenTarget('9501', 99999, 'Quarry')
    const r = await call('POST', '/api/grudges', member, { target: '9501', reason: 'mine' })
    rowId = r.body.target_row_id
  })

  it('claims an unheld target', async () => {
    const r = await call('POST', `/api/grudges/targets/${rowId}/claim`, member)
    expect(r.status).toBe(201)
  })

  it('shows the holder on the list', async () => {
    const list = await get('/api/grudges', member2)
    const t = list.body.targets.find((x: any) => x.target_id === '9501')
    expect(t.claim_member_id).toBe('9010')
  })

  it('⚠️ refuses a second claim and says WHO has it', async () => {
    // Two people pressing Claim in the same second is the exact case this
    // feature exists for. The unique index arbitrates, not a read-then-write,
    // which would let both through.
    const r = await call('POST', `/api/grudges/targets/${rowId}/claim`, member2)
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/already has this target/)
  })

  it('⚠️ refuses an unrelated member releasing it', async () => {
    expect((await call('DELETE', `/api/grudges/targets/${rowId}/claim`, member2)).status).toBe(403)
  })

  it('lets the holder release it, and then it can be taken', async () => {
    expect((await call('DELETE', `/api/grudges/targets/${rowId}/claim`, member)).status).toBe(200)
    expect((await call('POST', `/api/grudges/targets/${rowId}/claim`, member2)).status).toBe(201)
  })

  it('⚠️ lets leadership free a claim somebody forgot about', async () => {
    expect((await call('DELETE', `/api/grudges/targets/${rowId}/claim`, leader)).status).toBe(200)
  })

  it('⚠️ a released claim is kept, not deleted', async () => {
    // "Who had this and when did they let it go" is a question people ask
    // mid-chain, and a DELETE cannot answer it.
    const rows = await stack.db.query(
      `SELECT release_reason FROM grudge_claims WHERE target_row_id = $1 AND released_at IS NOT NULL`,
      [rowId]
    )
    expect(rows.rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.rows.every((r: any) => r.release_reason === 'manual')).toBe(true)
  })

  it('records claims and releases in the history', async () => {
    const r = await get('/api/grudges/audit?target_id=9501', member)
    const claimRows = r.body.history.filter((h: any) => h.field === 'claim')
    expect(claimRows.length).toBeGreaterThan(0)
  })

  it('⚠️ refuses to claim a target that is not on the public list', async () => {
    // Otherwise claiming would leak the existence of a pending own-faction
    // target to anybody who guessed its row id.
    const ours = await stack.db.query('SELECT torn_faction_id FROM faction_config LIMIT 1')
    givenTarget('9502', Number(ours.rows[0].torn_faction_id))
    const added = await call('POST', '/api/grudges', member, { target: '9502', reason: 'pending' })
    expect(added.body.state).toBe('pending_approval')
    const r = await call('POST', `/api/grudges/targets/${added.body.target_row_id}/claim`, member2)
    expect(r.status).toBe(409)
  })

  it('404s on a target that does not exist', async () => {
    expect((await call('POST', '/api/grudges/targets/999999/claim', member)).status).toBe(404)
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
