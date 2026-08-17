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
      const { status = 200, body } = routes[key]
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

  it('backs right off when the tab is hidden', () => {
    // A hidden tab is a tab nobody is claiming in, and every member of the
    // faction is polling the same API during a war.
    expect(S.pollDelay(true)).toBe(30000)
    expect(S.pollDelay(true)).toBeGreaterThan(S.pollDelay(false))
  })
})

describe('buttonState', () => {
  it('offers a claim on an unclaimed target', () => {
    expect(S.buttonState(undefined, '111')).toMatchObject({ action: 'claim', mine: false })
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
