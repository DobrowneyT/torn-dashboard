// Pure logic of the War Room dibs userscript (#487).
//
// The script is a single .user.js because Tampermonkey needs it to be — no
// build step, no imports. So rather than duplicating the logic into a testable
// module, the file is EVALUATED here with no `window`/`document` in scope. Its
// bootstrap is guarded on both, so nothing DOM-related runs and the helpers
// come back through the CommonJS seam at the bottom of the file.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'tnl-war-room-dibs.user.js'), 'utf8')

const SESSION_KEY = 'tnl-dibs-session'

/**
 * `stored` is the session slot specifically; `values` is every other GM key.
 *
 * ⚠️ Keyed, not one shared slot. The first version returned `stored.value` for
 * ANY key, so a test that set the debug flag was really setting the session too
 * — and passing for a reason that had nothing to do with what it claimed.
 */
function loadScript({ routes = {}, stored = {}, values = {} } = {}) {
  const mod = { exports: {} }
  const calls = []
  // Route a request by URL substring. Anything unrouted is an explicit failure
  // rather than a silent undefined — a test that passes because a call was
  // never made is worse than one that fails.
  const GM = {
    xmlHttpRequest(opts) {
      calls.push(opts)
      const key = Object.keys(routes).find((k) => opts.url.includes(k))
      if (!key) return opts.onerror?.(new Error(`unrouted: ${opts.url}`))
      // A route may be a function of the call so far, so a test can express
      // "401 the first time, 200 after the refresh" — which is the whole shape
      // of the session-renewal bug and cannot be written with a fixed reply.
      const route = typeof routes[key] === 'function'
        ? routes[key](calls.filter((c) => c.url.includes(key)).length - 1, opts)
        : routes[key]
      const { status = 200, body } = route
      opts.onload({ status, responseText: JSON.stringify(body) })
    },
  }
  // `window`/`document` deliberately undefined: proves the guard holds, and
  // means a future edit that runs DOM work at load time fails here rather than
  // in someone's browser.
  new Function('module', 'window', 'document', 'GM', 'GM_getValue', 'GM_setValue', source)(
    mod, undefined, undefined, GM,
    (k, dflt) => {
      if (k === SESSION_KEY) return stored.value ?? dflt
      return k in values ? values[k] : dflt
    },
    (k, v) => {
      if (k === SESSION_KEY) stored.value = v
      else values[k] = v
    },
  )
  return { S: mod.exports, calls, stored, values }
}

const { S } = loadScript()

describe('the script loads without a DOM', () => {
  it('exports its helpers and runs no bootstrap', () => {
    expect(typeof S.parseXid).toBe('function')
    expect(typeof S.main).toBe('function')
  })
})

describe('parseXid', () => {
  it('reads the id out of a Torn profile link', () => {
    expect(S.parseXid('https://www.torn.com/profiles.php?XID=2139172')).toBe(2139172)
    expect(S.parseXid('/profiles.php?XID=1')).toBe(1)
  })

  it('⚠️ is href-based, so it survives Torn changing its markup', () => {
    // Class selectors on Torn break constantly; the profile link has been
    // stable for years. Anything without ?XID= is simply not a player link.
    expect(S.parseXid('https://www.torn.com/factions.php?step=profile&ID=10739')).toBeNull()
    expect(S.parseXid('')).toBeNull()
    expect(S.parseXid(null)).toBeNull()
    expect(S.parseXid(undefined)).toBeNull()
  })

  it('rejects a malformed or non-positive id rather than returning NaN', () => {
    expect(S.parseXid('/profiles.php?XID=abc')).toBeNull()
    expect(S.parseXid('/profiles.php?XID=0')).toBeNull()
    expect(S.parseXid('/profiles.php?XID=-5')).toBeNull()
  })

  it('handles trailing query parameters', () => {
    expect(S.parseXid('/profiles.php?XID=12345&nav=people')).toBe(12345)
  })
})

describe('resolveTenant', () => {
  const map = { '10739': 'forge.monchoon.me', '53100': 'tnl.monchoon.me' }

  it('maps a faction id to its dashboard host', () => {
    expect(S.resolveTenant(map, 10739)).toBe('forge.monchoon.me')
    expect(S.resolveTenant(map, '10739')).toBe('forge.monchoon.me')
  })

  it('returns null for a faction with no dashboard', () => {
    // Most Torn factions are not tenants; that is not an error state.
    expect(S.resolveTenant(map, 99999)).toBeNull()
  })

  it('survives a missing or malformed map rather than throwing', () => {
    // files.monchoon.me could be briefly unreachable mid-deploy.
    expect(S.resolveTenant(null, 10739)).toBeNull()
    expect(S.resolveTenant(map, null)).toBeNull()
    expect(S.resolveTenant(map, undefined)).toBeNull()
    expect(S.resolveTenant({ '10739': '' }, 10739)).toBeNull()
  })
})

describe('indexDibs', () => {
  const claim = (target, by, name) => ({ target_id: target, claimed_by: by, claimed_name: name, deleted_at: null })

  it('indexes live claims by target', () => {
    const m = S.indexDibs([claim(1, 111, 'Alice'), claim(2, 222, 'Bob')])
    expect(m.get(1)).toEqual({ by: 111, name: 'Alice' })
    expect(m.get(2)).toEqual({ by: 222, name: 'Bob' })
  })

  it('⚠️ treats deleted_at as a TOMBSTONE, not as an absent row', () => {
    // Releases, auto-expiry (#159) and the single-dibs rule all arrive as rows
    // WITH deleted_at set. Reading them as live claims would leave badges on
    // targets nobody holds — the most visible way this script could lie.
    const m = S.indexDibs([claim(1, 111, 'Alice')])
    S.indexDibs([{ ...claim(1, 111, 'Alice'), deleted_at: '2026-08-16T00:00:00Z' }], m)
    expect(m.has(1)).toBe(false)
  })

  it('applies a delta on top of an existing index', () => {
    const m = S.indexDibs([claim(1, 111, 'Alice')])
    S.indexDibs([claim(2, 222, 'Bob')], m)
    expect([...m.keys()].sort()).toEqual([1, 2])
  })

  it('⚠️ reflects the single-dibs rule when both rows arrive together', () => {
    // Claiming B tombstones the claimer's dib on A, and the server broadcasts
    // both rows in one frame. Order within the frame must not matter to the
    // outcome for the two different targets.
    const m = S.indexDibs([claim(1, 111, 'Alice')])
    S.indexDibs([
      { ...claim(1, 111, 'Alice'), deleted_at: '2026-08-16T00:00:00Z' },
      claim(2, 111, 'Alice'),
    ], m)
    expect(m.has(1)).toBe(false)
    expect(m.get(2)).toEqual({ by: 111, name: 'Alice' })
  })

  it('ignores rows with no usable target id', () => {
    expect(S.indexDibs([{ target_id: null }, { target_id: 'x' }]).size).toBe(0)
    expect(S.indexDibs(null).size).toBe(0)
  })
})

describe('enemyIds', () => {
  const rows = [
    { member_id: 1, faction_id: 10739 },   // ours
    { member_id: 2, faction_id: 53100 },   // theirs
    { member_id: 3, faction_id: 53100 },   // theirs
  ]

  it('⚠️ excludes our own faction — dibs are enemy-only', () => {
    // The war page lists BOTH factions. A claim button beside a teammate is
    // nonsense, and putting one there is the most likely visible bug.
    const enemies = S.enemyIds(rows, 10739)
    expect(enemies.has(1)).toBe(false)
    expect([...enemies].sort()).toEqual([2, 3])
  })

  it('compares as strings, since the two sources disagree about type', () => {
    // torn_faction_id comes off /api/bootstrap as a string; faction_id comes
    // out of Postgres as a number. A === would put our whole faction on the
    // enemy list.
    expect(S.enemyIds(rows, '10739').has(1)).toBe(false)
    expect(S.enemyIds([{ member_id: 1, faction_id: '10739' }], 10739).has(1)).toBe(false)
  })

  it('is empty rather than throwing when there is no roster yet', () => {
    expect(S.enemyIds(null, 10739).size).toBe(0)
    expect(S.enemyIds([], 10739).size).toBe(0)
  })
})

describe('enemyIds is scoped to the faction we are actually fighting', () => {
  // ⚠️ war_room_state_v2 is not pruned when a war ends. On 2026-08-17 forge was
  // holding rosters for SIX factions, four of them months old. "Not ours" would
  // therefore offer dibs on people nobody is fighting — and the claim would
  // succeed, because the server has no opinion about who is worth attacking.
  const roster = [
    { member_id: 1, faction_id: 9533 },     // current opponent
    { member_id: 2, faction_id: 9533 },
    { member_id: 3, faction_id: 33783 },    // a war that ended in July
    { member_id: 4, faction_id: 10739 },    // us
  ]

  it('badges only the current opponent', () => {
    expect([...S.enemyIds(roster, 10739, '9533')]).toEqual([1, 2])
  })

  it('⚠️ excludes a stale roster from a finished war', () => {
    expect([...S.enemyIds(roster, 10739, '9533')]).not.toContain(3)
  })

  it('never badges our own members, whoever the opponent is', () => {
    expect([...S.enemyIds(roster, 10739, '9533')]).not.toContain(4)
    expect([...S.enemyIds(roster, 10739, null)]).not.toContain(4)
  })

  it('falls back to "everyone not ours" when the opponent is unknown', () => {
    // Better to over-offer than to show nothing at all before the config
    // channel has arrived.
    expect([...S.enemyIds(roster, 10739, null)]).toEqual([1, 2, 3])
    expect([...S.enemyIds(roster, 10739, undefined)]).toEqual([1, 2, 3])
  })

  it('compares across the string/number boundary', () => {
    expect([...S.enemyIds(roster, '10739', 9533)]).toEqual([1, 2])
  })

  it('⚠️ skips tombstoned roster rows — those members have left', () => {
    // Roster rows are soft-deleted, never removed: 478 of forge's 672 were
    // tombstones on 2026-08-19. Offering a dib on one offers a target who is
    // not in the war, and the claim would succeed.
    const withDeparture = [
      { member_id: 1, faction_id: 9533 },
      { member_id: 2, faction_id: 9533, deleted_at: '2026-08-18T00:00:00Z' },
    ]
    expect([...S.enemyIds(withDeparture, 10739, '9533')]).toEqual([1])
  })

  it('treats a tombstone as gone even when the opponent is unknown', () => {
    const withDeparture = [{ member_id: 9, faction_id: 8500, deleted_at: '2026-08-18T00:00:00Z' }]
    expect([...S.enemyIds(withDeparture, 10739, null)]).toEqual([])
  })
})

describe('opponentFrom', () => {
  it('reads the opponent out of the config channel', () => {
    expect(S.opponentFrom([{ enabled: true, faction_id: 9533, faction_name: 'Natural Selection' }]))
      .toBe('9533')
  })

  it('reports the opponent even while the war room is switched off', () => {
    // `enabled` gates the ticker, not who we are pointed at. Ignoring a
    // disabled config would drop us back to badging every stale roster.
    expect(S.opponentFrom([{ enabled: false, faction_id: 7282 }])).toBe('7282')
  })

  it('is null when there is no config yet, rather than undefined', () => {
    expect(S.opponentFrom([])).toBeNull()
    expect(S.opponentFrom(undefined)).toBeNull()
    expect(S.opponentFrom([{ enabled: true }])).toBeNull()
  })
})

describe('pollDelay', () => {
  it('polls briskly while the tab is being looked at', () => {
    expect(S.pollDelay(false)).toBe(3000)
  })

  it('eases off when the tab is hidden, without going to sleep', () => {
    // A hidden tab should cost the API less — every member of the faction is
    // polling it during a war. But the gap is paid on the way BACK, as stale
    // badges at the moment someone alt-tabs in to claim, so this stays in
    // seconds rather than half a minute. The visibilitychange listener makes
    // the return itself instant.
    expect(S.pollDelay(true)).toBe(10000)
    expect(S.pollDelay(true)).toBeGreaterThan(S.pollDelay(false))
    expect(S.pollDelay(true)).toBeLessThanOrEqual(15000)
  })
})

describe('buttonState', () => {
  it('offers a claim on an unclaimed target', () => {
    expect(S.buttonState(undefined, '111')).toMatchObject({ action: 'claim', mine: false })
  })

  it('⚠️ NAMES whoever holds a claim, rather than just saying "taken"', () => {
    // The name is what lets two people sort out a collision in one message in
    // faction chat instead of three, and it makes a stale claim visible — you
    // can see it belongs to someone who logged off an hour ago.
    const other = S.buttonState({ by: 4242, name: 'Thug' }, '2250591')
    expect(other.label).toContain('Thug')
    expect(other.action).toBe('none')
    expect(other.taken).toBe(true)
    expect(other.mine).toBe(false)
  })

  it('falls back to "Claimed" when the holder has no name on the row', () => {
    expect(S.buttonState({ by: 4242 }, '2250591').label).toContain('Claimed')
  })

  it('marks a free target as not taken, so the colour can differ', () => {
    expect(S.buttonState(null, '2250591')).toMatchObject({ taken: false, action: 'claim' })
  })

  it('offers a release on your own claim', () => {
    expect(S.buttonState({ by: 111, name: 'Alice' }, '111'))
      .toMatchObject({ action: 'release', mine: true })
  })

  it('⚠️ offers NOTHING on someone else\'s claim, and names them', () => {
    // Not a disabled claim button: the useful information is who has it, so a
    // second person knows who to talk to rather than what they cannot do.
    const state = S.buttonState({ by: 222, name: 'Bob' }, '111')
    expect(state.action).toBe('none')
    expect(state.label).toContain('Bob')
  })

  it('compares ids as strings', () => {
    // The session carries a string; the DB row a number. A === here would show
    // every member their own dib as if it belonged to a stranger.
    expect(S.buttonState({ by: 111, name: 'Alice' }, 111).mine).toBe(true)
    expect(S.buttonState({ by: '111', name: 'Alice' }, '111').mine).toBe(true)
  })
})

describe('backoffFor', () => {
  it('grows, then caps', () => {
    // A war page sits open for hours; unbounded growth would mean a member who
    // blipped early never reconnects, and a fixed 1s would hammer a server
    // that is already struggling.
    expect(S.backoffFor(0)).toBe(1000)
    expect(S.backoffFor(1)).toBeGreaterThan(S.backoffFor(0))
    expect(S.backoffFor(99)).toBe(S.backoffFor(4))
    expect(S.backoffFor(99)).toBeLessThanOrEqual(30000)
  })

  it('tolerates a negative attempt count', () => {
    expect(S.backoffFor(-1)).toBe(1000)
  })
})

describe('identityMatches', () => {
  it('⚠️ catches a token belonging to a different account', () => {
    // Dibs are attributed from the session, not the page. A stale token files
    // claims under the wrong person and the claim SUCCEEDS — it is just
    // credited to someone else, which nobody notices until a payout dispute.
    expect(S.identityMatches('111', 222)).toBe(false)
  })

  it('accepts a match across the string/number boundary', () => {
    expect(S.identityMatches('111', 111)).toBe(true)
  })

  it('⚠️ does NOT block when the page identity cannot be read', () => {
    // Torn's sidebar markup is not guaranteed. Refusing to work because a
    // selector missed would be worse than the risk it guards against.
    expect(S.identityMatches('111', null)).toBe(true)
    expect(S.identityMatches(null, 222)).toBe(true)
  })
})

describe('establishSession — key → faction → tenant → token', () => {
  const API_KEY = 'LIMITEDKEY123456'
  const keyInfo = (over = {}) => ({
    info: { user: { id: 9001, faction_id: 10739 }, access: { level: 3, faction: true }, ...over },
  })
  const routes = (over = {}) => ({
    '/v2/key/info': { body: keyInfo() },
    'tenants.json': { body: { '10739': 'forge.monchoon.me' } },
    '/api/auth/login': { body: { token: 'jwt-abc', expires_at: '2026-09-15T00:00:00Z' } },
    ...over,
  })

  it('⚠️ asks /v2/key/info, NOT the v1 basic selection', async () => {
    // The bug this test exists for. v1 `user/?selections=basic` returns
    // player_id, name, level, gender and status — and NO FACTION. The first
    // release used it, so every single login failed with "Torn reports no
    // faction for that key", which blames the key rather than the request.
    // key/info is also what the server's verifyTornKey calls, so the script and
    // the dashboard agree about a key by construction.
    const { S, calls } = loadScript({ routes: routes() })
    await S.establishSession(API_KEY)
    const tornCall = calls.find((c) => c.url.includes('api.torn.com'))
    expect(tornCall.url).toContain('/v2/key/info')
    expect(tornCall.url).not.toContain('selections=basic')
  })

  it('⚠️ reads faction_id as a FLAT property on info.user', async () => {
    // Not nested under a `faction` object, which is where the v1 profile
    // selection puts it. Getting this wrong is invisible until a real key.
    const { S, stored } = loadScript({ routes: routes() })
    const session = await S.establishSession(API_KEY)
    expect(session.factionId).toBe('10739')
    expect(session.host).toBe('forge.monchoon.me')
    expect(JSON.parse(stored.value).factionId).toBe('10739')
  })

  it('⚠️ stores the token and NEVER the API key', async () => {
    // The whole security argument for pasting a key into a userscript.
    const { S, stored } = loadScript({ routes: routes() })
    await S.establishSession(API_KEY)
    expect(stored.value).toContain('jwt-abc')
    expect(stored.value).not.toContain(API_KEY)
  })

  it('⚠️ sends require_enrolled so it cannot be a first enrolment', async () => {
    // Enrolment adds the key to the faction's shared rotating pool, and the
    // disclosure explaining that lives on the dashboard. This script has no
    // such screen, so it must refuse to be anyone's first.
    const { S, calls } = loadScript({ routes: routes() })
    await S.establishSession(API_KEY)
    // `data`, not `body` — that is the field name GM.xmlHttpRequest takes, and
    // gmRequest maps onto it.
    const login = calls.find((c) => c.url.includes('/api/auth/login'))
    expect(JSON.parse(login.data).require_enrolled).toBe(true)
  })

  it('names a Public key as the problem instead of failing vaguely later', async () => {
    // REQUIRED_KEY_LEVEL is 3. Without this check the login just returns 403
    // and the member is told something unhelpful about the dashboard.
    const { S } = loadScript({
      routes: routes({ '/v2/key/info': { body: keyInfo({ access: { level: 1 } }) } }),
    })
    await expect(S.establishSession(API_KEY)).rejects.toThrow(/Limited Access/i)
  })

  it('surfaces a Torn error verbatim rather than as a generic failure', async () => {
    const { S } = loadScript({
      routes: routes({ '/v2/key/info': { body: { error: { code: 2, error: 'Incorrect key' } } } }),
    })
    await expect(S.establishSession(API_KEY)).rejects.toThrow(/Incorrect key/)
  })

  it('says so plainly when the faction has no dashboard', async () => {
    const { S } = loadScript({ routes: routes({ 'tenants.json': { body: {} } }) })
    await expect(S.establishSession(API_KEY)).rejects.toThrow(/no TNL dashboard/i)
  })

  it('passes the dashboard\'s own refusal through to the member', async () => {
    // e.g. the require_enrolled rejection, which tells them to log into the
    // dashboard first. Replacing it with "HTTP 403" would lose the instruction.
    const { S } = loadScript({
      routes: routes({
        '/api/auth/login': { status: 403, body: { error: 'Log in to the dashboard once to enrol your API key, then this will work.' } },
      }),
    })
    await expect(S.establishSession(API_KEY)).rejects.toThrow(/enrol your API key/)
  })
})

describe('the session survives a reload', () => {
  // ⚠️ The bug this covers: the panel asked for a key on EVERY page load, even
  // with a good session stored, because it was built before anything had read
  // the store. To the member it looked like the key had simply not saved.

  it('round-trips a session through GM storage', () => {
    const { S, stored } = loadScript()
    S.store.write({ host: 'forge.monchoon.me', token: 'jwt-abc', userId: '9001' })
    expect(S.store.read()).toEqual({ host: 'forge.monchoon.me', token: 'jwt-abc', userId: '9001' })
    expect(stored.value).toContain('jwt-abc')
  })

  it('⚠️ finds an existing session on a FRESH load', () => {
    // A second loadScript() with the same backing store is the reload.
    const stored = {}
    const a = loadScript({ stored })
    a.S.store.write({ host: 'forge.monchoon.me', token: 'jwt-abc', userId: '9001' })

    const b = loadScript({ stored })
    expect(b.S.store.read()).toMatchObject({ token: 'jwt-abc' })
    expect(b.S.panelNeedsKey(b.S.store.read())).toBe(false)
  })

  it('asks for a key only when there is no usable session', () => {
    const { S } = loadScript()
    expect(S.panelNeedsKey(null)).toBe(true)
    expect(S.panelNeedsKey(undefined)).toBe(true)
    expect(S.panelNeedsKey({ host: 'forge.monchoon.me' })).toBe(true)   // no token
    expect(S.panelNeedsKey({ host: 'forge.monchoon.me', token: 'jwt' })).toBe(false)
  })

  it('forgets the session on sign out', () => {
    const { S } = loadScript()
    S.store.write({ host: 'x', token: 'jwt' })
    S.store.clear()
    expect(S.store.read()).toBeNull()
    expect(S.panelNeedsKey(S.store.read())).toBe(true)
  })

  it('treats corrupt storage as no session rather than throwing', () => {
    // A half-written value must show the key prompt, not break the page.
    const { S } = loadScript({ stored: { value: '{not json' } })
    expect(S.store.read()).toBeNull()
  })
})

describe('frameRows — the two socket frames disagree about shape', () => {
  // ⚠️ The bug this covers: a `snapshot` nests each channel as { rows: [...] }
  // while a `delta` puts the array at the top level. Passing the snapshot's
  // wrapper object into indexDibs threw "rows is not iterable" INSIDE the
  // message listener, where nothing surfaces it — socket open, panel live, and
  // not a single badge on the page.

  it('unwraps the snapshot shape', () => {
    expect(S.frameRows({ rows: [{ target_id: 5 }] })).toEqual([{ target_id: 5 }])
  })

  it('passes the delta shape through untouched', () => {
    expect(S.frameRows([{ target_id: 5 }])).toEqual([{ target_id: 5 }])
  })

  it('is empty — never undefined — for a missing or malformed channel', () => {
    expect(S.frameRows(undefined)).toEqual([])
    expect(S.frameRows(null)).toEqual([])
    expect(S.frameRows({})).toEqual([])
    expect(S.frameRows({ rows: 'nope' })).toEqual([])
  })

  it('⚠️ feeds a real snapshot frame through to a dib index', () => {
    // The exact shape fullDelta() sends: { type, state: {rows}, dibs: {rows} }.
    const frame = {
      type: 'snapshot',
      dibs: { rows: [{ target_id: 77, claimed_by: 42, claimed_name: 'Alice' }] },
      state: { rows: [{ member_id: 77, faction_id: 999 }, { member_id: 1, faction_id: 10739 }] },
    }
    expect(S.indexDibs(S.frameRows(frame.dibs)).get(77)).toEqual({ by: 42, name: 'Alice' })
    expect([...S.enemyIds(S.frameRows(frame.state), 10739)]).toEqual([77])
  })
})

describe('the panel keeps out of the way', () => {
  const signedIn = { host: 'forge.monchoon.me', token: 'jwt', userId: '9001' }

  it('collapses to a dot once there is a session', () => {
    expect(S.panelExpanded(signedIn, false)).toBe(false)
  })

  it('opens again when the user asks for it', () => {
    expect(S.panelExpanded(signedIn, true)).toBe(true)
  })

  it('⚠️ never collapses while a key is still needed', () => {
    // A collapsed dot with no session is a script that does nothing and offers
    // no way to fix it — `expanded: false` must not be able to cause that.
    expect(S.panelExpanded(null, false)).toBe(true)
    expect(S.panelExpanded({ host: 'forge.monchoon.me' }, false)).toBe(true)
  })

  it('⚠️ distinguishes "connecting" from "not connected"', () => {
    // These read the same to a user in a hurry, but only one of them means
    // something is wrong — and the old vocabulary had no word for the handshake
    // at all, so a live connection showed "not connected" until it opened.
    expect(S.statusText('connecting')).toBe('○ connecting…')
    expect(S.statusText('idle')).toBe('○ not connected')
    expect(S.statusText('live')).toBe('● live')
  })

  it('colours the collapsed dot by severity', () => {
    expect(S.statusColor('live')).toBe('#22c55e')
    expect(S.statusColor('connecting')).toBe(S.statusColor('reconnecting'))
    expect(S.statusColor('auth')).toBe(S.statusColor('error'))
    expect(S.statusColor('idle')).toBe('#6b7280')
  })

  it('falls back to the raw state rather than blanking out', () => {
    expect(S.statusText('something-new')).toBe('something-new')
    expect(S.statusColor('something-new')).toBe('#6b7280')
  })
})

describe('debug logging', () => {
  it('is off unless it has been switched on', () => {
    expect(loadScript().S.debugOn()).toBe(false)
    expect(loadScript({ values: { 'tnl-dibs-debug': 'false' } }).S.debugOn()).toBe(false)
    expect(loadScript({ values: { 'tnl-dibs-debug': 'true' } }).S.debugOn()).toBe(true)
  })

  it('⚠️ does not read the debug flag out of the session slot', () => {
    // Both live in GM storage. Keying them together once made a test pass for
    // the wrong reason; keying them together in the SCRIPT would turn a stored
    // session into permanently-on logging on a member's machine.
    const { S } = loadScript({ stored: { value: 'true' } })
    expect(S.debugOn()).toBe(false)
  })

  it('⚠️ never prints a session token', () => {
    // The trace runs on torn.com, and pasting a console screenshot into a chat
    // is a normal thing for a member to do. A leaked token IS the account, for
    // as long as it lives.
    const url = 'wss://forge.monchoon.me/api/war-room/ws?token=eyJhbGciOiJIUzI1NiJ9.abc.def'
    expect(S.redactUrl(url)).toBe('wss://forge.monchoon.me/api/war-room/ws?token=REDACTED')
    expect(S.redactUrl(url)).not.toContain('eyJ')
  })

  it('⚠️ never prints an API key', () => {
    expect(S.redactUrl('https://api.torn.com/v2/key/info?key=abc123&comment=TNLDibs'))
      .toBe('https://api.torn.com/v2/key/info?key=REDACTED&comment=TNLDibs')
  })

  it('redacts a parameter wherever it sits in the query', () => {
    expect(S.redactUrl('https://h/x?a=1&token=secret'))
      .toBe('https://h/x?a=1&token=REDACTED')
    expect(S.redactUrl('https://h/x?apiKey=secret&b=2'))
      .toBe('https://h/x?apiKey=REDACTED&b=2')
  })

  it('leaves a URL with nothing to hide alone', () => {
    expect(S.redactUrl('https://files.monchoon.me/scripts/tenants.json'))
      .toBe('https://files.monchoon.me/scripts/tenants.json')
  })

  it('survives a non-string rather than throwing inside a log call', () => {
    expect(S.redactUrl(undefined)).toBe('undefined')
    expect(S.redactUrl(null)).toBe('null')
  })
})

describe('the session refreshes itself when it goes stale', () => {
  // ⚠️ The bug this covers. A token LIVES 30 days but only ACTS for 24 hours:
  // verifySessionToken rejects anything whose `iat` is older than
  // SESSION_FRESH_SECONDS, so a member removed from the faction loses access
  // within a day (#119). The SPA has always exchanged stale tokens silently.
  // This script did not — so it worked perfectly for one day and then answered
  // 401 to everything, while its stored `expires_at` insisted, a month into the
  // future, that the session was fine. Nothing about that says "log in again".

  const session = { host: 'forge.monchoon.me', token: 'stale-jwt', userId: '2250591', factionId: '10739' }

  /** 401 until the token changes, 200 afterwards — the server's actual rule. */
  function freshnessRoutes({ refresh = { status: 200, body: { token: 'fresh-jwt', expires_at: 999 } } } = {}) {
    return {
      '/api/auth/refresh': refresh,
      '/api/war-room/delta': (_n, opts) => (
        opts.headers.authorization === 'Bearer fresh-jwt'
          ? { status: 200, body: { state: { rows: [] }, dibs: { rows: [] }, server_now: 'T1' } }
          : { status: 401, body: { error: 'Authentication required' } }
      ),
    }
  }

  it('⚠️ refreshes on a 401 and retries the original call', async () => {
    const { S, calls } = loadScript({ routes: freshnessRoutes() })
    S.setSession({ ...session })

    const res = await S.api('/api/war-room/delta', 'GET')

    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url.replace('https://forge.monchoon.me', ''))).toEqual([
      '/api/war-room/delta',      // 401, token is stale
      '/api/auth/refresh',        // exchange it
      '/api/war-room/delta',      // retry, now fresh
    ])
  })

  it('sends the refreshed token on the retry, not the stale one', async () => {
    const { S, calls } = loadScript({ routes: freshnessRoutes() })
    S.setSession({ ...session })
    await S.api('/api/war-room/delta', 'GET')
    expect(calls.at(-1).headers.authorization).toBe('Bearer fresh-jwt')
  })

  it('persists the new token, so the next page load starts fresh', async () => {
    const { S, stored } = loadScript({ routes: freshnessRoutes() })
    S.setSession({ ...session })
    await S.api('/api/war-room/delta', 'GET')
    expect(S.currentSession().token).toBe('fresh-jwt')
    expect(stored.value).toContain('fresh-jwt')
  })

  it('keeps the rest of the session intact across a refresh', async () => {
    const { S } = loadScript({ routes: freshnessRoutes() })
    S.setSession({ ...session })
    await S.api('/api/war-room/delta', 'GET')
    expect(S.currentSession()).toMatchObject({ host: 'forge.monchoon.me', userId: '2250591', factionId: '10739' })
  })

  it('⚠️ refreshes ONCE per call, never in a loop', async () => {
    // /api/auth/refresh is rate limited to 10/min and the read loop runs every
    // three seconds. A refresh that "succeeds" into a token the server still
    // rejects must surface the 401, not ask again.
    const { S, calls } = loadScript({
      routes: {
        '/api/auth/refresh': { status: 200, body: { token: 'also-stale', expires_at: 999 } },
        '/api/war-room/delta': { status: 401, body: { error: 'Authentication required' } },
      },
    })
    S.setSession({ ...session })

    const res = await S.api('/api/war-room/delta', 'GET')

    expect(res.status).toBe(401)
    expect(calls.filter((c) => c.url.includes('/api/auth/refresh'))).toHaveLength(1)
  })

  it('⚠️ signs out when the token is past refreshing', async () => {
    // 401 from refresh: even the signature is dead. Holding the token would
    // 401 forever behind a panel still claiming to be signed in.
    const { S, stored } = loadScript({
      routes: freshnessRoutes({ refresh: { status: 401, body: { error: 'Session expired — please log in again' } } }),
    })
    S.setSession({ ...session })
    stored.value = JSON.stringify(session)

    const res = await S.api('/api/war-room/delta', 'GET')

    expect(res.status).toBe(401)
    expect(S.currentSession()).toBeNull()
    expect(S.store.read()).toBeNull()
  })

  it('signs out when the member lost faction access (403 from refresh)', async () => {
    const { S } = loadScript({
      routes: freshnessRoutes({ refresh: { status: 403, body: { error: 'Your faction access was removed.' } } }),
    })
    S.setSession({ ...session })
    await S.api('/api/war-room/delta', 'GET')
    expect(S.currentSession()).toBeNull()
  })

  it('does not refresh on failures that have nothing to do with the session', async () => {
    // A 500, a 409 from a lost dibs race, a 429 — refreshing would waste the
    // auth rate limit and hide the real error.
    for (const status of [500, 409, 429]) {
      const { S, calls } = loadScript({
        routes: { '/api/war-room/dibs': { status, body: { error: 'nope' } } },
      })
      S.setSession({ ...session })
      const res = await S.api('/api/war-room/dibs', 'POST', { target_id: 1 })
      expect(res.status).toBe(status)
      expect(calls.filter((c) => c.url.includes('refresh'))).toHaveLength(0)
    }
  })

  it('leaves a successful call completely alone', async () => {
    const { S, calls } = loadScript({
      routes: { '/api/war-room/delta': { status: 200, body: { server_now: 'T1' } } },
    })
    S.setSession({ ...session })
    const res = await S.api('/api/war-room/delta', 'GET')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
  })
})

describe('a claim paints before the server confirms it', () => {
  // ⚠️ The bug this covers is pure latency, and it looked like a network
  // problem. The POST reached the server in under 300ms and the dashboard
  // showed the claim instantly — but the button on Torn stayed on "+ Dibs"
  // for seconds. Neither claim() nor release() wrote to rt.dibs, so the
  // render() straight after a click repainted from unchanged state and the
  // badge reverted until a poll happened to carry the row back.
  //
  // The file header has said "paint optimistically, let the server's answer
  // always overwrite" since the first commit. Only half of that was true.

  const session = { host: 'forge.monchoon.me', token: 'jwt', userId: '2250591', factionId: '10739' }

  it('⚠️ shows the claim as yours the moment the POST succeeds', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/dibs': { status: 200, body: {} } } })
    S.setSession({ ...session })

    const res = await S.claim(90100)

    expect(res.ok).toBe(true)
    expect(S.buttonState(S.dibsIndex().get(90100), session.userId)).toMatchObject({
      label: '✓ Yours', action: 'release', mine: true,
    })
  })

  it('⚠️ mirrors the single-dibs rule, so you never hold two', async () => {
    // Claiming B releases your claim on A server-side. Painting B without
    // dropping A would show two of your own dibs until the next poll.
    const { S } = loadScript({ routes: { '/api/war-room/dibs': { status: 200, body: {} } } })
    S.setSession({ ...session })

    await S.claim(111)
    await S.claim(222)

    expect(S.dibsIndex().has(111)).toBe(false)
    expect(S.dibsIndex().has(222)).toBe(true)
  })

  it('does not disturb a claim held by someone else', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/dibs': { status: 200, body: {} } } })
    S.setSession({ ...session })
    S.indexDibs([{ target_id: 555, claimed_by: 999, claimed_name: 'Someone' }], S.dibsIndex())

    await S.claim(111)

    expect(S.dibsIndex().get(555)).toEqual({ by: 999, name: 'Someone' })
  })

  it('clears the badge the moment a release succeeds', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/dibs/': { status: 200, body: {} } } })
    S.setSession({ ...session })
    S.indexDibs([{ target_id: 90100, claimed_by: 2250591, claimed_name: 'You' }], S.dibsIndex())

    const res = await S.release(90100)

    expect(res.ok).toBe(true)
    expect(S.dibsIndex().has(90100)).toBe(false)
  })

  it('⚠️ paints nothing when the server refuses the claim', async () => {
    // The optimistic paint must be strictly a bet on a 200. Painting a failed
    // claim tells you a target is yours when it is not — the exact lie the
    // header forbids.
    const { S } = loadScript({
      routes: { '/api/war-room/dibs': { status: 500, body: { error: 'boom' } } },
    })
    S.setSession({ ...session })

    const res = await S.claim(90100)

    expect(res.ok).toBe(false)
    expect(S.dibsIndex().has(90100)).toBe(false)
  })

  it('⚠️ shows the real owner when it loses a race (409)', async () => {
    const { S } = loadScript({
      routes: {
        '/api/war-room/dibs': {
          status: 409,
          body: { error: 'Already claimed', owner: { id: 4242, name: 'Rival' } },
        },
      },
    })
    S.setSession({ ...session })

    const res = await S.claim(90100)

    expect(res.ok).toBe(false)
    expect(S.dibsIndex().get(90100)).toEqual({ by: 4242, name: 'Rival' })
    expect(S.buttonState(S.dibsIndex().get(90100), session.userId).action).toBe('none')
  })

  it('leaves a failed release alone rather than clearing the badge', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/dibs/': { status: 500, body: {} } } })
    S.setSession({ ...session })
    S.indexDibs([{ target_id: 90100, claimed_by: 2250591, claimed_name: 'You' }], S.dibsIndex())

    const res = await S.release(90100)

    expect(res.ok).toBe(false)
    expect(S.dibsIndex().has(90100)).toBe(true)
  })
})

describe('battle stats come off the roster we already poll', () => {
  // No TornStats key, no second request: war_room_state_v2 carries bsp_total
  // and the four components, and the script is already receiving those rows.
  // Our OWN row is in there too, which is what makes FF computable locally.

  it('reads the stats off a roster row', () => {
    expect(S.rowStats({
      member_id: 1, bsp_total: 9_700_000_000,
      bsp_str: 3e9, bsp_spd: 2e9, bsp_def: 3.7e9, bsp_dex: 1e9,
      ts_spy_at: '2026-08-01T00:00:00Z',
    })).toMatchObject({ total: 9_700_000_000, str: 3e9, spiedAt: '2026-08-01T00:00:00Z' })
  })

  it('⚠️ keeps an unspied member, with a null total', () => {
    // Returning null for the whole row made the cell vanish, which reads as a
    // broken script. A row with total: null lets the cell say `???` — the
    // dashboard's word for "nobody has spied them".
    expect(S.rowStats({ member_id: 1, bsp_total: null })).toMatchObject({ total: null })
    expect(S.rowStats(null)).toBeNull()
  })

  it('⚠️ prefers the SPY time over the fetch time, but only for TornStats', () => {
    // ts_spy_at is when the spy happened; bsp_fetched_at is when we polled.
    // Only a TornStats row has a real spy time — dating a BSP estimate by
    // someone else's spy would overstate how fresh it is.
    expect(S.rowStats({
      bsp_total: 1e9, spy_source: 'tornstats',
      ts_spy_at: '2026-08-01T00:00:00+00', bsp_fetched_at: '2026-08-19T00:00:00+00',
    }).spiedAt).toBe('2026-08-01T00:00:00+00')

    expect(S.rowStats({
      bsp_total: 1e9, spy_source: 'bsp',
      ts_spy_at: '2026-08-01T00:00:00+00', bsp_fetched_at: '2026-08-19T00:00:00+00',
    }).spiedAt).toBe('2026-08-19T00:00:00+00')
  })

  it('carries the source through so the tooltip can name it', () => {
    expect(S.rowStats({ bsp_total: 1e9, spy_source: 'torn' }).source).toBe('torn')
    expect(S.rowStats({ bsp_total: 1e9 }).source).toBeNull()
  })
})

describe('formatStat matches the War Room exactly', () => {
  // ⚠️ A member reading 3.99B on the dashboard and 4.0B on Torn has to wonder
  // which screen is lying. These pin the copy to formatStats() in
  // frontend/src/utils/statInput.js — two decimals, and `???` for absent.

  it('uses two decimals, as the dashboard does', () => {
    expect(S.formatStat(3_990_000_000)).toBe('3.99B')
    expect(S.formatStat(9_700_000_000)).toBe('9.70B')
    expect(S.formatStat(1_060_000_000)).toBe('1.06B')
    expect(S.formatStat(812_000_000)).toBe('812.00M')
  })

  it('⚠️ says ??? for an absent reading, not N/A and not 0', () => {
    // `???` is the dashboard's word for "nobody has spied them". An empty cell
    // or a 0 reads as a broken script instead.
    expect(S.formatStat(null)).toBe('???')
    expect(S.formatStat(undefined)).toBe('???')
    expect(S.formatStat('nonsense')).toBe('???')
  })

  it('renders a genuine zero as zero', () => {
    expect(S.formatStat(0)).toBe('0')
  })
})

describe('parseDbTime — the #140 trap', () => {
  // ⚠️ Postgres serialises timestamptz with a BARE "+00" offset, which
  // `new Date()` rejects outright. The first tooltip said "spied Invalid Date"
  // for every member because of exactly this. The dashboard hit it once before
  // and fixed it in utils/time.js; this is the same fix.

  it('parses the bare +00 offset Postgres emits', () => {
    expect(S.fmtAgo('2026-08-19T09:00:00+00', Date.parse('2026-08-19T10:00:00Z')))
      .toBe('1h ago')
  })

  it('parses a fractional-second bare offset', () => {
    // Deliberately not sitting on a minute boundary: the microseconds push
    // this to 59m59s, and asserting "1h ago" would be testing the rounding
    // rather than the parse.
    const parsed = S.parseDbTime('2026-08-19T09:00:00.123456+00')
    expect(parsed).toBeInstanceOf(Date)
    expect(parsed.toISOString()).toBe('2026-08-19T09:00:00.123Z')
    expect(S.fmtAgo('2026-08-19T09:00:00.123456+00', Date.parse('2026-08-19T11:00:00Z')))
      .toBe('1h ago')
  })

  it('treats an offsetless timestamp as UTC', () => {
    expect(S.fmtAgo('2026-08-19T09:00:00', Date.parse('2026-08-19T10:00:00Z')))
      .toBe('1h ago')
  })

  it('⚠️ gives a dash, never "Invalid Date", for junk or absence', () => {
    expect(S.fmtAgo(null)).toBe('—')
    expect(S.fmtAgo('not a date')).toBe('—')
    expect(S.fmtAgo(undefined)).toBe('—')
  })

  it('reads the same scale as the dashboard', () => {
    const now = Date.parse('2026-08-19T10:00:00Z')
    expect(S.fmtAgo('2026-08-19T09:59:30+00', now)).toBe('just now')
    expect(S.fmtAgo('2026-08-19T09:30:00+00', now)).toBe('30m ago')
    expect(S.fmtAgo('2026-08-16T10:00:00+00', now)).toBe('3d ago')
  })
})

describe('statsSourceLabel', () => {
  it('names the three sources as the dashboard does', () => {
    expect(S.statsSourceLabel('torn')).toBe('OWN')
    expect(S.statsSourceLabel('tornstats')).toBe('TS')
    expect(S.statsSourceLabel('bsp')).toBe('BSP')
  })

  it('⚠️ falls back to the WEAKEST claim for an unknown source', () => {
    // Enemy rows carry no source. Calling an estimate "OWN" would have a lead
    // size up a target against a number nobody ever measured; under-claiming
    // is the safe error.
    expect(S.statsSourceLabel(null)).toBe('BSP')
    expect(S.statsSourceLabel(undefined)).toBe('BSP')
    expect(S.statsSourceLabel('something-new')).toBe('BSP')
  })
})

describe('dominantStat', () => {
  it('⚠️ names a stat only when it carries a THIRD of the build', () => {
    // Everyone's largest stat is largest. Colouring that would fire on every
    // row and say nothing; a third of the total means genuinely lopsided.
    const wall = { total: 100, str: 10, spd: 10, def: 70, dex: 10 }
    expect(S.dominantStat(wall)).toBe('def')
  })

  it('stays quiet on a balanced build', () => {
    expect(S.dominantStat({ total: 100, str: 25, spd: 25, def: 25, dex: 25 })).toBeNull()
  })

  it('is null when there is nothing to judge', () => {
    expect(S.dominantStat({ total: 100 })).toBeNull()
    expect(S.dominantStat({ total: 0, str: 1 })).toBeNull()
    expect(S.dominantStat(null)).toBeNull()
  })
})

describe('fairFight matches the dashboard', () => {
  // ⚠️ The script cannot import fairFight.js — one file, no build step — so
  // the maths is duplicated. These pin the duplicate to the original: if they
  // drift, a member with both screens open sees two different FF for one
  // target and has no way to know which is right.

  const even = { total: 4e9, str: 1e9, spd: 1e9, def: 1e9, dex: 1e9 }

  it('is 1 + 8/3 × (defender score / attacker score)', () => {
    // Below the cap, so the formula is actually observable. An even split
    // makes score ∝ √total, so a defender at 0.140625× the total scores
    // 0.375× — giving 1 + 8/3 × 0.375 = exactly 2.
    const weaker = { total: 4e9 * 0.140625 }
    expect(S.fairFight({ total: 4e9 }, weaker)).toBeCloseTo(2, 5)
  })

  it('⚠️ reads a flat 3.00 for anyone at or above your own stats', () => {
    // FF saturates at a defender/attacker ratio of 0.75, so an even matchup
    // is already capped. Worth knowing before designing any colour scale: the
    // entire useful gradient sits BELOW an even fight.
    expect(S.fairFight(even, even)).toBe(3)
  })

  it('caps at 3, as Torn does', () => {
    const giant = { total: 4e12, str: 1e12, spd: 1e12, def: 1e12, dex: 1e12 }
    expect(S.fairFight(even, giant)).toBe(3)
  })

  it('scores the sum of square ROOTS, so splits matter at equal totals', () => {
    const lopsided = { total: 4e9, str: 4e9, spd: 0, def: 0, dex: 0 }
    expect(S.statScore(lopsided)).toBeLessThan(S.statScore(even))
  })

  it('assumes an even split when only a total is known', () => {
    expect(S.statScore({ total: 4e9 })).toBeCloseTo(2 * Math.sqrt(4e9), 5)
  })

  it('⚠️ is null — never a number — when either side is unknown', () => {
    // FF drives target selection. Inventing one sends someone at a target
    // that pays nothing.
    expect(S.fairFight(null, even)).toBeNull()
    expect(S.fairFight(even, null)).toBeNull()
    expect(S.fairFight({ total: 0 }, even)).toBeNull()
  })
})

// ⚠️ NOT UNIT-TESTED, deliberately: rowOf() and headerFor() traverse a real
// DOM, and this repo has no DOM test environment — all 63 frontend suites are
// pure logic under `environment: 'node'`. Hand-rolling a fake `closest()` would
// test the fake, not the selectors.
//
// Both have already been wrong once, and neither failed loudly:
//   - rowOf used `[class*="row"]`, which matches Torn's `rowSection___wdqaD`
//     INSIDE the name cell, so every column rendered on top of the player name.
//   - headerFor looked for `.table-header`; Torn's war header is
//     `<div class="white-grad c-pointer">` and carries no such class, so the
//     columns went unheaded.
// Both are now pinned to the markup captured on 2026-08-19 and verified in the
// browser. Changing either means checking a live war page again.
