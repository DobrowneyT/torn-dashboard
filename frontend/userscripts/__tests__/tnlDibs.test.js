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

  it('⚠️ lets an ADMIN release someone else\'s claim from the same control', () => {
    // This already worked in the War Room as a separate "Release" link, and is
    // enforced server-side (the DELETE handler filters to claimed_by = you for
    // anyone it does not consider an admin). It has to survive the move to a
    // toggle, and has to exist on Torn too.
    const s = S.buttonState({ by: 4242, name: 'Thug' }, '2250591', true)
    expect(s.action).toBe('release')
    expect(s.label).toBe('Thug')
  })

  it('⚠️ stays inert on someone else\'s claim for a NON-admin', () => {
    expect(S.buttonState({ by: 4242, name: 'Thug' }, '2250591', false).action).toBe('none')
  })

  it('⚠️ NAMES whoever holds a claim, rather than just saying "taken"', () => {
    // The name is what lets two people sort out a collision in one message in
    // faction chat instead of three, and it makes a stale claim visible — you
    // can see it belongs to someone who logged off an hour ago.
    const other = S.buttonState({ by: 4242, name: 'Thug' }, '2250591')
    expect(other.label).toBe('Thug')
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
      label: 'Yours', action: 'release', mine: true,
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

describe('admin rights come from the session token', () => {
  // ⚠️ UI affordance only. The token is signed and the script cannot verify it
  // — the secret is server-side — so a member could hand themselves is_admin by
  // editing their stored session. That buys nothing: the DELETE handler filters
  // to `claimed_by = you` for anyone it does not consider an admin, so the
  // forged click releases nothing. These tests pin the READ, not a guard.

  function tokenFor(claims) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${b64({ alg: 'HS256' })}.${b64(claims)}.signature`
  }

  it('reads is_admin out of the JWT payload', () => {
    expect(S.sessionIsAdmin({ token: tokenFor({ is_admin: true }) })).toBe(true)
    expect(S.sessionIsAdmin({ token: tokenFor({ is_admin: false }) })).toBe(false)
  })

  it('⚠️ decodes base64url, not plain base64', () => {
    // JWT payloads use the URL alphabet (- and _), which atob rejects. A claim
    // set containing either character would otherwise throw and silently
    // demote a real admin.
    const claims = { torn_user_id: '2250591', is_admin: true, sub: 'torn-2250591?>' }
    expect(S.tokenClaims(tokenFor(claims))).toMatchObject({ is_admin: true })
  })

  it('is false — never a crash — for a malformed or absent token', () => {
    expect(S.sessionIsAdmin(null)).toBe(false)
    expect(S.sessionIsAdmin({})).toBe(false)
    expect(S.sessionIsAdmin({ token: 'not-a-jwt' })).toBe(false)
    expect(S.sessionIsAdmin({ token: 'a.!!!!.c' })).toBe(false)
    expect(S.tokenClaims(undefined)).toEqual({})
  })

  it('⚠️ requires exactly true, not merely truthy', () => {
    // A claim of "false" or 1 must not read as admin — the server checks a
    // boolean, and the two surfaces disagreeing is the bug this avoids.
    expect(S.sessionIsAdmin({ token: tokenFor({ is_admin: 'false' }) })).toBe(false)
    expect(S.sessionIsAdmin({ token: tokenFor({ is_admin: 1 }) })).toBe(false)
  })
})

// ── Settings (#514) ────────────────────────────────────────────────────────

describe('settingOn', () => {
  it('reads the stored strings', () => {
    expect(S.settingOn('true', S.SETTING_STATS)).toBe(true)
    expect(S.settingOn('false', S.SETTING_STATS)).toBe(false)
  })

  it('falls back to the DEFAULT when nothing is stored, not to off', () => {
    // Someone who installs this and never opens settings must still get the
    // useful configuration — that is the point of the defaults.
    expect(S.settingOn(null, S.SETTING_STATS)).toBe(true)
    expect(S.settingOn(undefined, S.SETTING_FF_BOX)).toBe(true)
  })

  it('leaves the developer switch off by default', () => {
    expect(S.settingOn(null, S.DEBUG_KEY)).toBe(false)
  })

  it('treats an unknown key as off, so a typo enables nothing', () => {
    expect(S.settingOn(null, 'tnl-dibs-not-a-setting')).toBe(false)
  })

  it('ignores a corrupt value rather than reading it as truthy', () => {
    // A half-written GM value must not turn a setting on by accident.
    expect(S.settingOn('yes', S.DEBUG_KEY)).toBe(false)
    expect(S.settingOn('1', S.DEBUG_KEY)).toBe(false)
  })
})

describe('settings storage', () => {
  it('keeps each setting in its own GM key, never in the session slot', () => {
    // ⚠️ The collision this guards against has already happened once: a shared
    // slot made a debug-flag test pass by writing the session.
    const { S: s, values, stored } = loadScript({ stored: { value: JSON.stringify({ token: 'keep-me' }) } })
    s.settings.set(s.SETTING_STATS, false)
    s.settings.set(s.DEBUG_KEY, true)
    expect(values[s.SETTING_STATS]).toBe('false')
    expect(values[s.DEBUG_KEY]).toBe('true')
    expect(JSON.parse(stored.value).token).toBe('keep-me')
  })

  it('round-trips a setting through the store', () => {
    const { S: s } = loadScript({ values: { 'tnl-dibs-show-stats': 'false' } })
    expect(s.settings.on(s.SETTING_STATS)).toBe(false)
    expect(s.settings.on(s.SETTING_FF_BOX)).toBe(true)
  })

  it('turns the debug log on through the same store as the other settings', () => {
    expect(loadScript({ values: { 'tnl-dibs-debug': 'true' } }).S.debugOn()).toBe(true)
    expect(loadScript().S.debugOn()).toBe(false)
  })
})

// ── Repaint signature (#516) ───────────────────────────────────────────────

describe('paintSignature', () => {
  const state = { label: 'Dibs', action: 'claim', mine: false, taken: false }
  const stats = { total: 5e6, str: 1e6, def: 1e6, spd: 1e6, dex: 2e6, source: 'torn', spiedAt: '2026-08-19' }
  const sig = (st = state, sx = stats, set = '11', mine = 4e6) => S.paintSignature(st, sx, set, mine)

  it('is stable when nothing visible has changed', () => {
    // The whole basis of the dirty check: an unchanged row must produce an
    // identical string, or we are back to repainting 200 rows every 3 seconds.
    expect(sig()).toBe(sig())
  })

  it('changes when the dibs state changes', () => {
    expect(sig({ label: 'Yours', action: 'release', mine: true, taken: true })).not.toBe(sig())
  })

  it('changes when the holder changes, even between two taken states', () => {
    const a = { label: 'Alice', action: 'none', mine: false, taken: true }
    const b = { label: 'Bob', action: 'none', mine: false, taken: true }
    expect(sig(a)).not.toBe(sig(b))
  })

  it('changes when the target stats change', () => {
    expect(sig(state, { ...stats, total: 6e6 })).not.toBe(sig())
  })

  it('changes when a spy is refreshed at the same total', () => {
    // Same numbers, newer reading — the tooltip's age line has to update.
    expect(sig(state, { ...stats, spiedAt: '2026-08-20' })).not.toBe(sig())
  })

  it('changes when OUR OWN stats change', () => {
    // ⚠️ FF is a comparison. Leaving our total out would freeze the green
    // highlight on every row the moment our own stats refreshed.
    expect(sig(state, stats, '11', 9e6)).not.toBe(sig())
  })

  it('changes when a display setting is toggled', () => {
    expect(sig(state, stats, '00')).not.toBe(sig())
    expect(sig(state, stats, '10')).not.toBe(sig(state, stats, '11'))
  })

  it('survives a row with no stats on record', () => {
    // `undefined` would pick up the helper's default, so this must be explicit.
    expect(() => sig(state, null)).not.toThrow()
    expect(sig(state, null)).not.toBe(sig())
  })

  it('does not fold in a clock, which would defeat the check entirely', () => {
    const before = sig()
    const after = sig()
    expect(before).toBe(after)
    expect(before).not.toMatch(/\d{13}/)   // no Date.now() smuggled in
  })
})

describe('settingsSignature', () => {
  it('differs between every combination of the display settings', () => {
    const seen = new Set()
    for (const stats of ['true', 'false']) {
      for (const ff of ['true', 'false']) {
        const { S: s } = loadScript({
          values: { 'tnl-dibs-show-stats': stats, 'tnl-dibs-ff-box': ff },
        })
        seen.add(s.settingsSignature())
      }
    }
    expect(seen.size).toBe(4)
  })

  it('ignores the debug flag, which changes nothing on screen', () => {
    const plain = loadScript().S.settingsSignature()
    const debug = loadScript({ values: { 'tnl-dibs-debug': 'true' } }).S.settingsSignature()
    expect(debug).toBe(plain)
  })
})

// ── Request shape ──────────────────────────────────────────────────────────

describe('bodyless requests carry no content-type', () => {
  // ⚠️ The regression this exists for. Every request used to send
  // `content-type: application/json`, so a bodyless DELETE made Fastify try to
  // parse a zero-length body and answer 400 FST_ERR_CTP_EMPTY_JSON_BODY before
  // the route was reached. Releasing a dib from Torn failed while the same
  // action from the War Room worked, which read as a permissions bug — the SPA
  // sends no content-type on a DELETE.
  const session = { token: 't', host: 'forge.example', userId: '1', factionId: '9' }

  function callFor(method, path, calls) {
    return calls.find((c) => c.method === method && c.url.includes(path))
  }

  it('omits it on DELETE, which has no body', async () => {
    const { S: s, calls } = loadScript({ routes: { '/api/war-room/dibs/': { status: 200, body: { ok: true } } } })
    s.setSession(session)
    await s.release(77)
    const call = callFor('DELETE', '/api/war-room/dibs/77', calls)
    expect(call).toBeDefined()
    expect(call.data).toBeUndefined()
    expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain('content-type')
  })

  it('still sends it on POST, which does have one', async () => {
    const { S: s, calls } = loadScript({ routes: { '/api/war-room/dibs': { status: 200, body: { ok: true } } } })
    s.setSession(session)
    await s.claim(77)
    const call = callFor('POST', '/api/war-room/dibs', calls)
    expect(call.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call.data)).toMatchObject({ target_id: 77 })
  })

  it('always sends the bearer token, body or not', async () => {
    const { S: s, calls } = loadScript({ routes: { '/api/war-room/dibs/': { status: 200, body: { ok: true } } } })
    s.setSession(session)
    await s.release(77)
    expect(callFor('DELETE', '/api/war-room/dibs/77', calls).headers.authorization).toBe('Bearer t')
  })

  it('reports the server wording on a failed release, not a bare status', async () => {
    const { S: s } = loadScript({
      routes: { '/api/war-room/dibs/': { status: 400, body: { error: 'Body cannot be empty' } } },
    })
    s.setSession(session)
    expect(await s.release(77)).toEqual({ ok: false, message: 'Body cannot be empty' })
  })

  it('falls back to the status when the server sent no message', async () => {
    const { S: s } = loadScript({ routes: { '/api/war-room/dibs/': { status: 502, body: {} } } })
    s.setSession(session)
    expect(await s.release(77)).toEqual({ ok: false, message: 'HTTP 502' })
  })
})

// ── Roster intelligence (#525, #515) ───────────────────────────────────────

describe('countryCode', () => {
  it('reads the country out of whatever wording Torn used', () => {
    expect(S.countryCode('Traveling to South Africa')).toBe('SA')
    expect(S.countryCode('In hospital in Switzerland')).toBe('SWI')
    expect(S.countryCode('Returning to Torn from the United Kingdom')).toBe('UK')
    expect(S.countryCode('In Mexico')).toBe('MX')
  })

  it('matches on stems, so the demonym works as well as the country', () => {
    // Torn writes "In a Mexican hospital" in some places and "In Mexico" in
    // others; a whole-word match would only ever catch one of them.
    expect(S.countryCode('In a Mexican hospital')).toBe('MX')
    expect(S.countryCode('In a Canadian hospital')).toBe('CAN')
    expect(S.countryCode('In a Chinese hospital')).toBe('CN')
  })

  it('⚠️ prefers Cayman over Canada — the stems overlap', () => {
    // 'canad' cannot be shortened to 'can' precisely because "Cayman" would
    // then match it, sending a lead to the wrong flight time entirely.
    expect(S.countryCode('Traveling to Cayman Islands')).toBe('CAY')
  })

  it('returns null rather than guessing at home or at an unknown place', () => {
    expect(S.countryCode('Okay')).toBeNull()
    expect(S.countryCode('')).toBeNull()
    expect(S.countryCode(null)).toBeNull()
  })
})

describe('travelDestination', () => {
  it('takes whichever end of the route is not Torn', () => {
    expect(S.travelDestination('Traveling to China')).toBe('china')
    expect(S.travelDestination('Returning to Torn from China')).toBe('china')
    expect(S.travelDestination('Traveling from Torn to Japan')).toBe('japan')
    expect(S.travelDestination('Traveling from Japan to Torn')).toBe('japan')
  })

  it('resolves the aliases Torn uses for the same place', () => {
    expect(S.travelDestination('Traveling to United Arab Emirates')).toBe('uae')
    expect(S.travelDestination('Traveling to UK')).toBe('united kingdom')
  })

  it('⚠️ returns null for a destination we have no flight time for', () => {
    // Null means the caller shows nothing. An estimate built on a duration we
    // invented is worse than no estimate — a lead queues a hit on it.
    expect(S.travelDestination('Traveling to Atlantis')).toBeNull()
    expect(S.travelDestination('Okay')).toBeNull()
    expect(S.travelDestination(null)).toBeNull()
  })
})

describe('travelPhase', () => {
  it('tells outbound from inbound from already-there', () => {
    expect(S.travelPhase('Traveling to China')).toBe('out')
    expect(S.travelPhase('Returning to Torn from China')).toBe('back')
    expect(S.travelPhase('Traveling from China to Torn')).toBe('back')
    expect(S.travelPhase('In China')).toBe('in')
    expect(S.travelPhase('Okay')).toBeNull()
  })
})

describe('methodsForPlaneType', () => {
  it('narrows to the one method Torn told us about', () => {
    expect(S.methodsForPlaneType('private_jet')).toEqual(['wlt'])
    expect(S.methodsForPlaneType('light_aircraft')).toEqual(['airstrip'])
    expect(S.methodsForPlaneType('airliner')).toEqual(['business'])
  })

  it('⚠️ falls through to every method when the aircraft is unknown', () => {
    // A wrong method gives a confidently wrong landing time, which is the
    // failure the whole estimate exists to avoid. Four candidates give a wide
    // band, and a wide band is honest.
    expect(S.methodsForPlaneType('zeppelin')).toHaveLength(4)
    expect(S.methodsForPlaneType(undefined)).toHaveLength(4)
  })
})

describe('travelEta', () => {
  const departedAt = '2026-08-20T12:00:00+00'
  const at = (mins) => Date.parse('2026-08-20T12:00:00Z') + mins * 60_000

  it('estimates a landing from the departure we witnessed', () => {
    // Mexico by private jet (wlt) is 720s = 12 minutes.
    const eta = S.travelEta({
      description: 'Traveling to Mexico', planeType: 'private_jet',
      departedAt, nowMs: at(6),
    })
    expect(eta.state).toBe('estimate')
    expect(eta.methods).toEqual(['wlt'])
    // Six minutes in, six left, ±3%.
    expect(eta.earliestSec).toBeGreaterThan(300)
    expect(eta.latestSec).toBeLessThan(400)
  })

  it('⚠️ parses the bare Postgres offset — the #140 trap', () => {
    // "+00" is not valid ISO 8601, so Date.parse returns NaN. This shipped in
    // the dashboard's own copy and meant the feature never rendered a single
    // estimate in production.
    expect(S.travelEta({
      description: 'Traveling to Mexico', planeType: 'private_jet',
      departedAt: '2026-08-20T12:00:00+00', nowMs: at(6),
    }).state).toBe('estimate')
  })

  it('is unknown without a witnessed departure, rather than guessing', () => {
    expect(S.travelEta({ description: 'Traveling to Mexico', departedAt: null }).state).toBe('unknown')
    expect(S.travelEta({ description: 'Traveling to Atlantis', departedAt }).state).toBe('unknown')
  })

  it('reports overdue once every candidate has expired', () => {
    // Reachable in ordinary play — a Detective Agency can extend a flight.
    // Refusing to show a landing time in the past beats inventing one.
    expect(S.travelEta({
      description: 'Traveling to Mexico', planeType: 'private_jet',
      departedAt, nowMs: at(60),
    }).state).toBe('overdue')
  })

  it('⚠️ eliminates a method only once its UPPER bound has passed', () => {
    // Mexico business is 420s; at 425s in, a business flight is still legally
    // in the air on the slow side of the ±3% variance and must not be cut.
    const eta = S.travelEta({
      description: 'Traveling to Mexico', departedAt, nowMs: at(0) + 425_000,
    })
    expect(eta.methods).toContain('business')
  })
})

describe('fmtCountdown', () => {
  it('⚠️ drops seconds above an hour and keeps them below a minute', () => {
    // The cell is a handful of pixels wide. Nobody planning around an 83-minute
    // hospital stay needs the seconds; everybody watching the last minute does.
    expect(S.fmtCountdown(5025)).toBe('1h23m')
    expect(S.fmtCountdown(2712)).toBe('45m12s')
    expect(S.fmtCountdown(9)).toBe('9s')
  })

  it('zero-pads so the countdown does not jitter in width', () => {
    expect(S.fmtCountdown(3605)).toBe('1h00m')
    expect(S.fmtCountdown(65)).toBe('1m05s')
  })

  it('clamps a negative or unusable duration to zero', () => {
    expect(S.fmtCountdown(-40)).toBe('0s')
    expect(S.fmtCountdown(null)).toBe('0s')
  })
})

describe('fmtEtaShort', () => {
  it('⚠️ always prefixes ~, because the number is inferred', () => {
    // It sits in the same column as the exact hospital countdown and must not
    // read like one.
    expect(S.fmtEtaShort({ state: 'estimate', earliestSec: 300, latestSec: 360 })).toMatch(/^~/)
  })

  it('says land when every candidate has expired, and nothing when unknown', () => {
    expect(S.fmtEtaShort({ state: 'overdue' })).toBe('land')
    expect(S.fmtEtaShort({ state: 'unknown' })).toBeNull()
    expect(S.fmtEtaShort(null)).toBeNull()
  })
})

describe('fmtLastActionShort', () => {
  const now = Date.parse('2026-08-20T12:00:00Z')
  const ago = (s) => ({ timestamp: Math.floor(now / 1000) - s })

  it('compacts to one unit, because the cell has no room for two', () => {
    expect(S.fmtLastActionShort(ago(30), now)).toBe('30s')
    expect(S.fmtLastActionShort(ago(300), now)).toBe('5m')
    expect(S.fmtLastActionShort(ago(7200), now)).toBe('2h')
    expect(S.fmtLastActionShort(ago(345_600), now)).toBe('4d')
  })

  it('returns null for a missing timestamp rather than 1970', () => {
    expect(S.fmtLastActionShort(null, now)).toBeNull()
    expect(S.fmtLastActionShort({ timestamp: 0 }, now)).toBeNull()
  })

  it('never reads negative when their clock is ahead of ours', () => {
    expect(S.fmtLastActionShort({ timestamp: Math.floor(now / 1000) + 60 }, now)).toBe('0s')
  })
})

describe('activityTone', () => {
  it('maps Torn’s three activity states', () => {
    expect(S.activityTone({ last_action: { status: 'Online' } })).toBe('online')
    expect(S.activityTone({ last_action: { status: 'Idle' } })).toBe('idle')
    expect(S.activityTone({ last_action: { status: 'Offline' } })).toBe('offline')
  })

  it('is null when Torn told us nothing, so the name keeps its own colour', () => {
    expect(S.activityTone({ last_action: {} })).toBeNull()
    expect(S.activityTone(null)).toBeNull()
  })
})

// ── The online/idle counter (#531) ─────────────────────────────────────────
//
// ⚠️ Counted from the ROSTER, never from the rendered rows. A DOM scrape only
// ever sees what Torn has painted, so it silently undercounts anything
// paginated, virtualised or collapsed — which is the whole reason #531 says to
// take Warline's interface but not its implementation. The first cut of this
// walked `list.children` and had exactly that bug.
describe('tallyActivity', () => {
  const on = { last_action: { status: 'Online' } }
  const idle = { last_action: { status: 'Idle' } }
  const off = { last_action: { status: 'Offline' } }

  it('counts all three states across the roster', () => {
    expect(S.tallyActivity([on, on, idle, off, off, off]))
      .toEqual({ online: 2, idle: 1, offline: 3 })
  })

  it('keeps the offline count the badge itself does not show', () => {
    // The label is "N online / M idle", but the tooltip gives the full
    // breakdown — so offline has to be tallied even though it is never
    // the headline.
    expect(S.tallyActivity([off, off]).offline).toBe(2)
  })

  it('ignores members Torn told us nothing about', () => {
    expect(S.tallyActivity([on, { last_action: {} }, null, undefined]))
      .toEqual({ online: 1, idle: 0, offline: 0 })
  })

  it('is all zeroes for an empty roster', () => {
    expect(S.tallyActivity([])).toEqual({ online: 0, idle: 0, offline: 0 })
  })
})

describe('countLabel / countTooltip', () => {
  it('leads with online and mentions idle only when there is some', () => {
    expect(S.countLabel({ online: 12, idle: 3, offline: 47 })).toBe('12 online / 3 idle')
    expect(S.countLabel({ online: 12, idle: 0, offline: 47 })).toBe('12 online')
  })

  it('gives the full breakdown, offline included, in the tooltip', () => {
    expect(S.countTooltip({ online: 12, idle: 3, offline: 47 }))
      .toBe('12 online, 3 idle, 47 offline')
  })
})

describe('reviveAudience', () => {
  it('separates a revive we can buy from one only their faction can do', () => {
    expect(S.reviveAudience({ is_revivable: true, revive_setting: 'Everyone' })).toBe('anyone')
    expect(S.reviveAudience({ is_revivable: true, revive_setting: 'Friends & faction' })).toBe('friends')
  })

  it('is null when a revive is impossible at all', () => {
    expect(S.reviveAudience({ is_revivable: false, revive_setting: 'Everyone' })).toBeNull()
    expect(S.reviveAudience({ is_revivable: true, revive_setting: 'No one' })).toBeNull()
  })

  it('⚠️ treats Unknown as anyone — the #342 decision', () => {
    // Torn reports Unknown when it will not disclose the preference, which is
    // the normal case for an ENEMY, i.e. most of the roster. Degrading to
    // friends painted the whole enemy side muted and buried the distinction.
    expect(S.reviveAudience({ is_revivable: true, revive_setting: 'Unknown' })).toBe('anyone')
    expect(S.reviveAudience({ is_revivable: true, revive_setting: null })).toBe('anyone')
  })

  it('stays identical to reviveAudience() in warRoomFlags.js', () => {
    // Duplicated for the same reason statScore() is — one file, no build step.
    // If these drift the script and the board disagree about the same target.
    expect(S.reviveAudience({ is_revivable: true })).toBe('anyone')
  })
})

describe('statusView', () => {
  const now = Date.parse('2026-08-20T12:00:00Z')
  const inSec = (s) => Math.floor(now / 1000) + s

  it('renders a hospital stay as a live countdown', () => {
    const v = S.statusView({ status: { state: 'Hospital', until: inSec(5025) } }, now)
    expect(v).toMatchObject({ kind: 'hospital', text: '1h23m' })
  })

  it('⚠️ marks an abroad hospital stay with the country', () => {
    // Out of reach of anyone at home until they fly back — a different
    // proposition from a local stay, and the same countdown would hide it.
    const v = S.statusView({
      status: { state: 'Hospital', until: inSec(720), description: 'In a Swiss hospital' },
    }, now)
    expect(v.text).toBe('SWI:12m00s')
  })

  it('⚠️ says Okay rather than 0s once our copy has expired', () => {
    // The next poll agrees within three seconds. A stuck 0s reads as a frozen
    // script, which is the complaint this whole feature is meant to remove.
    const v = S.statusView({ status: { state: 'Hospital', until: inSec(-10) } }, now)
    expect(v.kind).toBe('okay')
  })

  it('abbreviates travel with the direction and an inferred ETA', () => {
    const out = S.statusView({
      status: { state: 'Traveling', description: 'Traveling to China', plane_image_type: 'private_jet' },
      travel_departed_at: '2026-08-20T11:00:00+00',
    }, now)
    expect(out.kind).toBe('traveling')
    expect(out.text).toMatch(/^>CN ~/)

    const back = S.statusView({
      status: { state: 'Traveling', description: 'Returning to Torn from China' },
    }, now)
    expect(back.text).toBe('CN>')
  })

  it('shows the direction even when the ETA is unknowable', () => {
    // travel_departed_at is null whenever we did not witness the departure,
    // which is normal — not missing data. Direction still helps.
    const v = S.statusView({ status: { state: 'Traveling', description: 'Traveling to Japan' } }, now)
    expect(v.text).toBe('>JP')
  })

  it('puts last action in the Status cell of an Okay member', () => {
    // ⚠️ The cell Torn leaves nearly empty is exactly the cell where last
    // action matters, which is what makes this cost no width (#511).
    const v = S.statusView({
      status: { state: 'Okay' },
      last_action: { status: 'Idle', timestamp: Math.floor(now / 1000) - 300 },
    }, now)
    expect(v).toMatchObject({ kind: 'okay', text: '5m' })
  })

  it('adds the revive glyph to an Okay member who can be revived', () => {
    const v = S.statusView({
      status: { state: 'Okay' }, is_revivable: true, revive_setting: 'Everyone',
      last_action: { timestamp: Math.floor(now / 1000) - 60 },
    }, now)
    expect(v.text).toBe('1m 💉')
  })

  it('is null when we know nothing, so Torn’s own text stands', () => {
    expect(S.statusView({ status: null }, now)).toBeNull()
    expect(S.statusView(null, now)).toBeNull()
    // A hospital row with no release time is not a countdown we can render.
    expect(S.statusView({ status: { state: 'Hospital', until: null } }, now)).toBeNull()
  })
})

describe('statusSortValue', () => {
  const now = Date.parse('2026-08-20T12:00:00Z')
  const inSec = (s) => Math.floor(now / 1000) + s
  const v = (entry) => S.statusSortValue(entry, now)

  it('ranks by how attackable they are, soonest first', () => {
    const okay = v({ status: { state: 'Okay' } })
    const hosp = v({ status: { state: 'Hospital', until: inSec(600) } })
    const abroad = v({ status: { state: 'Abroad', description: 'In China' } })
    expect(okay).toBeLessThan(hosp)
    expect(hosp).toBeLessThan(abroad)
  })

  it('orders members in the same state by who is out first', () => {
    const soon = v({ status: { state: 'Hospital', until: inSec(60) } })
    const later = v({ status: { state: 'Hospital', until: inSec(6000) } })
    expect(soon).toBeLessThan(later)
  })

  it('is null when we cannot rank them, so they sort last', () => {
    expect(v({ status: null })).toBeNull()
  })
})

describe('sortEntries', () => {
  const rows = [
    { id: 1, pos: 0, value: 300 },
    { id: 2, pos: 1, value: null },
    { id: 3, pos: 2, value: 100 },
    { id: 4, pos: 3, value: 200 },
  ]
  const ids = (out) => out.map((r) => r.id)

  it('orders ascending and descending', () => {
    expect(ids(S.sortEntries(rows, 1))).toEqual([3, 4, 1, 2])
    expect(ids(S.sortEntries(rows, -1))).toEqual([1, 4, 3, 2])
  })

  it('⚠️ sorts unknown values LAST in both directions', () => {
    // Half a war roster has no battle stats on record. An ascending sort that
    // opens with two hundred ??? rows has buried the answer, not found it.
    expect(ids(S.sortEntries(rows, 1)).at(-1)).toBe(2)
    expect(ids(S.sortEntries(rows, -1)).at(-1)).toBe(2)
  })

  it('⚠️ breaks ties on original position, so repeated sorts do not churn', () => {
    // Without the tiebreak two members on the same value swap places on every
    // repaint and the list visibly shuffles under the cursor.
    const tied = [
      { id: 1, pos: 0, value: 5 }, { id: 2, pos: 1, value: 5 }, { id: 3, pos: 2, value: 5 },
    ]
    expect(ids(S.sortEntries(tied, -1))).toEqual([1, 2, 3])
    expect(ids(S.sortEntries(tied, 1))).toEqual([1, 2, 3])
  })

  it('does not mutate the array it was given', () => {
    const before = rows.map((r) => r.id)
    S.sortEntries(rows, -1)
    expect(rows.map((r) => r.id)).toEqual(before)
  })

  it('survives an empty or missing list', () => {
    expect(S.sortEntries([], 1)).toEqual([])
    expect(S.sortEntries(undefined, 1)).toEqual([])
  })
})

describe('nextSort', () => {
  it('opens descending — the question is almost always "who is biggest"', () => {
    expect(S.nextSort({ key: null, dir: 0 }, 'bs')).toEqual({ key: 'bs', dir: -1 })
  })

  it('⚠️ toggles between two states, never a third "off"', () => {
    // A third step means two of every three clicks land somewhere you did not
    // want. You leave a sort by choosing another column.
    let st = { key: 'bs', dir: -1 }
    st = S.nextSort(st, 'bs'); expect(st).toEqual({ key: 'bs', dir: 1 })
    st = S.nextSort(st, 'bs'); expect(st).toEqual({ key: 'bs', dir: -1 })
    st = S.nextSort(st, 'bs'); expect(st).toEqual({ key: 'bs', dir: 1 })
    expect(st.key).not.toBeNull()
  })

  it('switching column starts that column descending', () => {
    expect(S.nextSort({ key: 'bs', dir: 1 }, 'status')).toEqual({ key: 'status', dir: -1 })
  })
})

describe('rowState', () => {
  it('keeps every field memberState() writes, plus the travel latch', () => {
    // ⚠️ travel_departed_at is a COLUMN, not part of the state jsonb — the
    // ticker latches it when the poll observes the transition (#330), and the
    // ETA is meaningless without it.
    const st = S.rowState({
      member_id: 7,
      state: { last_action: { status: 'Online' }, status: { state: 'Okay' }, is_revivable: true, revive_setting: 'Everyone' },
      travel_departed_at: '2026-08-20T11:00:00+00',
    })
    expect(st).toMatchObject({
      is_revivable: true, revive_setting: 'Everyone',
      travel_departed_at: '2026-08-20T11:00:00+00',
    })
    expect(st.last_action.status).toBe('Online')
  })

  it('coerces the flags, so a missing one is false rather than undefined', () => {
    const st = S.rowState({ member_id: 7, state: {} })
    expect(st.is_revivable).toBe(false)
    expect(st.is_on_wall).toBe(false)
    expect(st.status).toBeNull()
  })

  it('returns null for no row at all', () => {
    expect(S.rowState(null)).toBeNull()
  })
})

describe('the flight table stays in step with the dashboard', () => {
  it('⚠️ carries all eleven destinations and four methods', () => {
    // Duplicated from warRoomTravel.js because a userscript is one file with no
    // build step. If a destination is dropped here its travellers silently show
    // no ETA at all, which looks like the poll is broken.
    expect(Object.keys(S.FLIGHT_SECONDS)).toHaveLength(11)
    for (const [name, times] of Object.entries(S.FLIGHT_SECONDS)) {
      expect(Object.keys(times).sort(), name).toEqual(['airstrip', 'business', 'standard', 'wlt'])
      expect(times.business, name).toBeLessThan(times.standard)
    }
  })

  it('⚠️ resolves the ambiguous airliner to business, not standard', () => {
    // Torn draws three aircraft for four methods, so `airliner` covers both the
    // fastest and the slowest. In a war the question is "how soon could they be
    // back", so the earlier candidate is the one worth planning against.
    expect(S.PLANE_TYPE_METHOD.airliner).toBe('business')
  })
})

describe('the dibs label fits the chip it has to live in', () => {
  it('⚠️ keeps every unclaimed/own label inside the 40px cap', () => {
    // The badge is copied from CAT's .call-button: width auto, max-width 40px,
    // font-size .65em, uppercase. At that size roughly five characters fit
    // before the ellipsis bites. A decorated label like "+ Dibs" or "✓ Yours"
    // spends two of those five on a glyph saying nothing the colour does not
    // already say — and the extra width is what pushed the row over Torn's
    // float layout in the first place (#511).
    expect(S.buttonState(null, '2250591').label).toBe('Dibs')
    expect(S.buttonState({ by: 2250591 }, '2250591').label).toBe('Yours')
    for (const label of ['Dibs', 'Yours']) expect(label.length).toBeLessThanOrEqual(5)
  })

  it('a holder’s name is still the label, and truncation is the CSS’s job', () => {
    // Not shortened here. The tooltip is what makes a truncated name
    // recoverable, and paintDibs sets it on every state for exactly that reason.
    expect(S.buttonState({ by: 4242, name: 'SomeVeryLongName' }, '2250591').label)
      .toBe('SomeVeryLongName')
  })
})

// ── The stylesheet ─────────────────────────────────────────────────────────
//
// injectStyles() is the one function the rest of this file cannot reach: it
// returns early when `document` is undefined, which is exactly the guard every
// other test relies on. That blind spot shipped a broken script — a backtick
// inside a CSS comment terminated the template literal early, the remainder
// parsed as JavaScript, and the browser threw `ReferenceError: button is not
// defined`. `node --check` passes, because the result is still valid syntax.

/** Load the script with a stub `document` but no `window`, so main() stays off. */
function loadWithDom() {
  const mod = { exports: {} }
  const created = []
  const appended = []
  const document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = { tagName: tag, style: {}, dataset: {}, classList: { add() {}, remove() {} } }
      created.push(el)
      return el
    },
    head: { appendChild: (el) => appended.push(el) },
    documentElement: { appendChild: (el) => appended.push(el), classList: { toggle() {} } },
  }
  new Function('module', 'window', 'document', 'GM', 'GM_getValue', 'GM_setValue', source)(
    mod, undefined, document, { xmlHttpRequest() {} }, (_k, d) => d, () => {},
  )
  return { S: mod.exports, document, created, appended }
}

describe('injectStyles', () => {
  it('builds a stylesheet and appends it', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    expect(appended).toHaveLength(1)
    expect(typeof appended[0].textContent).toBe('string')
    expect(appended[0].textContent.length).toBeGreaterThan(500)
  })

  it('⚠️ interpolates every class name instead of leaking a raw ${…}', () => {
    // A template literal that terminated early would stop interpolating, so the
    // rendered sheet is the only place this is observable.
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const css = appended[0].textContent
    expect(css).not.toMatch(/\$\{/)
    for (const cls of ['tnl-dibs-badge', 'tnl-col', 'tnl-col-bs', 'tnl-tint', 'tnl-status']) {
      expect(css, cls).toContain(cls)
    }
  })

  it('⚠️ contains no backtick — one would have closed the template early', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    expect(appended[0].textContent).not.toContain('`')
  })

  it('carries the rules the layout depends on', () => {
    const { S: s, appended } = loadWithDom()
    const css = (s.injectStyles(), appended[0].textContent)
    // Room is made by narrowing Torn's columns, never by widening ours.
    expect(css).toMatch(/points___/)
    expect(css).toMatch(/attack___/)
  })

  it('⚠️ makes the header, the list AND the row flex — all three, or none', () => {
    // Torn floats its cells; the cells we inject are not floated, and
    // non-floated content does not sit in DOM order relative to floats. Leave
    // any one of the three on floats and the columns disagree about their own
    // order — a flex header showed BS before Score while a float row rendered
    // it after, from the very same markup. (Superseded the float clearfix that
    // used to live here.)
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const sheet = appended[0].textContent
    expect(sheet).toMatch(/\.white-grad[^{]*\{[^}]*display: flex/)
    expect(sheet).toMatch(/ul\.members-list,[^{]*\{[^}]*display: flex/)
    expect(sheet).toMatch(/ul\.members-list > li,[^{]*\{[^}]*display: flex/)
  })
})

// ── The launcher ───────────────────────────────────────────────────────────

/**
 * Load the script with a document that has Torn's page-title links list, so
 * ensureLauncher() has somewhere to mount.
 */
function loadWithLinksList() {
  const mod = { exports: {} }
  const byId = new Map()
  const makeEl = (tag) => {
    const el = {
      tagName: tag,
      style: { cssText: '' },
      dataset: {},
      children: [],
      isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { this[k] = v },
      addEventListener() {},
      appendChild(child) { this.children.push(child); return child },
      insertBefore(child) { this.children.unshift(child); return child },
      getBoundingClientRect: () => ({ left: 100, bottom: 40 }),
    }
    return el
  }
  const list = makeEl('div')
  const existingLink = makeEl('a')
  list.children.push(existingLink)
  byId.set('top-page-links-list', list)

  const document = {
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = makeEl(tag)
      // Mimic the browser: an element with an id is findable by it once mounted.
      Object.defineProperty(el, 'id', {
        get() { return this._id },
        set(v) { this._id = v; byId.set(v, this) },
        configurable: true,
      })
      return el
    },
    head: { appendChild() {} },
    documentElement: { appendChild() {}, classList: { toggle() {} } },
  }
  new Function('module', 'window', 'document', 'GM', 'GM_getValue', 'GM_setValue', source)(
    mod, undefined, document, { xmlHttpRequest() {} }, (_k, d) => d, () => {},
  )
  return { S: mod.exports, list, existingLink, byId }
}

describe('ensureLauncher', () => {
  it('mounts a link among Torn’s own page-title links', () => {
    const { S: s, list } = loadWithLinksList()
    const link = s.ensureLauncher()
    expect(link).toBeTruthy()
    expect(list.children).toContain(link)
    expect(link.tagName).toBe('a')
  })

  it('is named for the tool and labelled for screen readers', () => {
    const { S: s } = loadWithLinksList()
    const link = s.ensureLauncher()
    const label = link.children.find((c) => c.textContent === s.LAUNCHER_NAME)
    expect(label, 'a visible text label').toBeTruthy()
    expect(link['aria-labelledby']).toBeTruthy()
  })

  it('⚠️ mounts once, however many times it is called', () => {
    // It runs on every render pass (so Torn re-rendering the title cannot lose
    // it), which makes duplicate-suppression the whole contract, not a nicety.
    const { S: s, list } = loadWithLinksList()
    const before = list.children.length
    s.ensureLauncher()
    s.ensureLauncher()
    s.ensureLauncher()
    expect(list.children.length).toBe(before + 1)
  })

  it('carries the connectivity light as its icon', () => {
    // The light used to be a separate fixed dot in the corner; it rides along
    // with the link now, so one element answers both "open it" and "is it up".
    const { S: s } = loadWithLinksList()
    const link = s.ensureLauncher()
    const iconWrap = link.children.find((c) => c.children.length > 0)
    expect(iconWrap, 'an icon wrapper').toBeTruthy()
    const dot = iconWrap.children[0].children[0]
    expect(dot.style.cssText).toContain('border-radius:50%')
  })

  it('does nothing, and does not throw, when the links list is absent', () => {
    // Every Torn page that is not the faction page, and the moment before the
    // title renders on the one that is.
    const { S: s } = loadWithDom()
    expect(() => s.ensureLauncher()).not.toThrow()
    expect(s.ensureLauncher()).toBeNull()
  })
})

describe('attackUrl', () => {
  it('⚠️ uses page.php — Torn retired loader.php for attacks', () => {
    // loader.php now answers {"error":"This endpoint is no longer available.
    // Please use the new endpoints instead (page.php)."} — so the link opened a
    // JSON error page rather than the fight.
    expect(S.attackUrl(2139172)).toBe('https://www.torn.com/page.php?sid=attack&user2ID=2139172')
    expect(S.attackUrl('2139172')).toBe('https://www.torn.com/page.php?sid=attack&user2ID=2139172')
    expect(S.attackUrl(2139172)).not.toContain('loader.php')
  })

  it('refuses a missing or non-positive id rather than linking to nobody', () => {
    expect(S.attackUrl(0)).toBeNull()
    expect(S.attackUrl(null)).toBeNull()
    expect(S.attackUrl('abc')).toBeNull()
  })
})

describe('statsTip', () => {
  const stats = {
    total: 5_000_000, str: 2_100_000, def: 900_000, spd: 1_200_000, dex: 800_000,
    source: 'tornstats', spiedAt: null,
  }

  it('stacks one line per stat, then Total, then the source', () => {
    const lines = S.statsTip(stats, 2.4).split('\n').filter((l) => !/^─+$/.test(l))
    expect(lines[0]).toMatch(/^FF/)
    expect(lines.slice(1, 5).map((l) => l.trim().split(/\s+/)[0])).toEqual(['STR', 'DEF', 'SPD', 'DEX'])
    expect(lines[5]).toMatch(/^Total/)
    expect(lines.at(-1)).toContain('(TS)')
  })

  it('aligns the two columns, which is what white-space: pre is for', () => {
    const lines = S.statsTip(stats, 2.4).split('\n')
    const str = lines.find((l) => l.startsWith('STR'))
    const dex = lines.find((l) => l.startsWith('DEX'))
    expect(str.length).toBe(dex.length)
  })

  it('omits stats we do not have rather than printing N/A', () => {
    // A BSP estimate is one number, not four. Four lines of N/A is noise
    // pretending to be data.
    const tip = S.statsTip({ total: 4_000_000, str: null, def: null, spd: null, dex: null, source: 'bsp' }, null)
    expect(tip).not.toContain('STR')
    expect(tip).toContain('Total')
    expect(tip).toContain('FF')
  })

  it('marks an own-key reading as exact', () => {
    expect(S.statsTip({ ...stats, source: 'torn' }, 1.5)).toContain('Exact')
    expect(S.statsTip(stats, 1.5)).not.toContain('Exact')
  })

  it('says so plainly when there is nothing on record', () => {
    expect(S.statsTip(null, null)).toBe('No battle stats on record')
    expect(S.statsTip({ total: null }, null)).toBe('No battle stats on record')
  })
})

describe('tipPosition', () => {
  const W = 1000, H = 800

  it('opens below-right of the cursor', () => {
    expect(S.tipPosition(100, 100, 160, 120, W, H)).toEqual({ left: 114, top: 114 })
  })

  it('flips rather than spilling off the right or bottom edge', () => {
    // The tooltip lives on <body> at position:fixed, so nothing clips it — but
    // nothing stops it leaving the viewport either.
    expect(S.tipPosition(950, 100, 160, 120, W, H).left).toBe(950 - 14 - 160)
    expect(S.tipPosition(100, 780, 160, 120, W, H).top).toBe(780 - 14 - 120)
  })

  it('never goes negative on a tooltip larger than the space either side', () => {
    const { left, top } = S.tipPosition(20, 20, 900, 700, W, H)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
  })
})

describe('the stylesheet carries the fixes from v1.15.0', () => {
  const css = () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    return appended[0].textContent
  }

  it('⚠️ sets -webkit-text-fill-color, not just color', () => {
    // Torn's war-list name is an honor-bar <img> with a plain
    // <span class="honor-text"> twin behind it. Showing the twin is not enough:
    // Torn paints honor text with a gradient clipped to the glyphs, which needs
    // BOTH `color: transparent` and `-webkit-text-fill-color: transparent` —
    // and text-fill-color wins over color. Setting colour alone left every name
    // invisible, twice.
    const sheet = css()
    expect(sheet).toContain('honor-text')
    expect(sheet).toContain('-webkit-text-fill-color')
    expect(sheet).toMatch(/honor-text:not\(\.honor-text-svg\)/)
    // And the background must be cleared, or the gradient paints over it.
    expect(sheet).toMatch(/background: none/)
  })

  it('hides the honor image, the SVG twin, the dot and the faction tag', () => {
    const sheet = css()
    expect(sheet).toMatch(/tnl-plain-name img\s*\{\s*display: none/)
    expect(sheet).toContain('honor-text-svg')
    expect(sheet).toContain('userStatusWrap___')
    expect(sheet).toContain('factionWrap___')
  })

  it('⚠️ reclaims the hidden icons’ width with flex, NEVER a negative margin', () => {
    // Under the old float layout, hiding the dot and faction tag left a hole
    // the row could not reabsorb, so the name column was dragged back over it
    // by a hardcoded -46px. The name column is flex:1 1 auto now and takes the
    // freed space on its own; a negative margin would instead pull the NEXT
    // column into an overlap. Neither that constant nor a runtime measurement
    // (which deadlocked — measuring a display:none icon always reads 0) may
    // come back.
    const sheet = css()
    expect(sheet).not.toMatch(/margin-right: -\d+px/)
    expect(sheet).not.toContain('tnl-name-trim')
    expect(sheet).toMatch(/member___[\s\S]*?flex: 1 1 auto/)
  })

  it('hides the whole battle-stat column, header included, when it is off', () => {
    expect(css()).toMatch(/tnl-no-bs[\s\S]*?display: none/)
  })

  it('draws the column separators', () => {
    // Every divider is a border-left on the right-hand cell of its pair (BS,
    // Score, Status, Attack, Dibs each carry their own) — no shared
    // border-right mechanism anymore.
    const matches = css().match(/border-left: 1px solid/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  it('⚠️ puts the tooltip on body, not inside the column', () => {
    // An ::after inside .tnl-col can never paint above the rows below it:
    // .tnl-col has a z-index and therefore a stacking context, and a descendant
    // cannot escape its ancestor's. The tooltip is a fixed-position element on
    // <body> for exactly that reason.
    const sheet = css()
    expect(sheet).toContain('#tnl-dibs-tip')
    expect(sheet).toMatch(/#tnl-dibs-tip[\s\S]*?position: fixed/)
    expect(sheet).not.toContain('data-tnl-tip]:hover::after')
  })
})

describe('formatStatShort', () => {
  it('⚠️ never exceeds five characters, whatever the magnitude', () => {
    // The column has room for five and the number was spilling out of it.
    // Three significant digits keeps the width fixed: 1.23B, 12.3B, 123B.
    for (const v of [1, 950, 1234, 156_340_000, 1_234_567_890, 12_340_000_000,
                     123_400_000_000, 999_999_999_999]) {
      expect(S.formatStatShort(v).length, String(v)).toBeLessThanOrEqual(5)
    }
  })

  it('holds three significant digits across the decades', () => {
    expect(S.formatStatShort(1_234_567_890)).toBe('1.23B')
    expect(S.formatStatShort(12_340_000_000)).toBe('12.3B')
    expect(S.formatStatShort(123_400_000_000)).toBe('123B')
    expect(S.formatStatShort(156_340_000)).toBe('156M')
  })

  it('⚠️ carries into the next unit when rounding pushes past 999', () => {
    // 999.6M is 1.00B, not "1000M" — which is six characters and reads wrong.
    // The first implementation recursed here instead of promoting, and hung.
    expect(S.formatStatShort(999_600_000)).toBe('1.00B')
    expect(S.formatStatShort(999_999_999_999)).toBe('1.00T')
  })

  it('leaves small numbers alone and reports an unknown as ???', () => {
    expect(S.formatStatShort(950)).toBe('950')
    expect(S.formatStatShort(0)).toBe('0')
    expect(S.formatStatShort(null)).toBe('???')
    expect(S.formatStatShort('nonsense')).toBe('???')
  })

  it('⚠️ does not replace formatStat, which the tooltip still uses', () => {
    // formatStat is kept byte-identical to the dashboard's formatStats so the
    // two screens never disagree. The compact form is for the column only, and
    // the tooltip remains the place the exact dashboard figure is readable.
    expect(S.formatStat(1_234_567_890)).toBe('1.23B')
    expect(S.formatStat(156_340_000)).toBe('156.34M')
    expect(S.statsTip({ total: 156_340_000, str: null, def: null, spd: null, dex: null, source: 'bsp' }, null))
      .toContain('156.34M')
  })
})

describe('the stylesheet handles Torn’s honor-bar names', () => {
  const css = () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    return appended[0].textContent
  }

  it('hides the honor image and the SVG twin, showing the plain text', () => {
    const sheet = css()
    expect(sheet).toMatch(/tnl-plain-name img\s*\{\s*display: none/)
    expect(sheet).toContain('honor-text-svg')
    expect(sheet).toMatch(/honor-text:not\(\.honor-text-svg\)/)
  })

  it('drops Torn’s own online dot only while we are tinting names', () => {
    expect(css()).toMatch(/html\.tnl-tinting \[class\*="userStatusWrap___"\]/)
  })

  it('centres both halves of the column on the row', () => {
    const sheet = css()
    expect(sheet).toMatch(/tnl-col-dibs[\s\S]*?align-items: center/)
    expect(sheet).toMatch(/tnl-col-bs[\s\S]*?align-items: center/)
  })
})

describe('the tinted name uses a plain, readable font', () => {
  it('sets an explicit sans-serif stack, not whatever Torn styled honor-text with', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const css = appended[0].textContent
    expect(css).toMatch(/honor-text:not\(\.honor-text-svg\)[\s\S]*?font-family:\s*-apple-system/)
  })
})

describe('the score column', () => {
  it('is narrower than the battle-stat total needs, since the content is short', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const css = appended[0].textContent
    expect(css).toMatch(/points___[\s\S]*?width: 44px !important/)
  })
})

describe('the BS header is centered, not right-aligned like its numbers', () => {
  it('overrides justify-content for the header box specifically', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const css = appended[0].textContent
    // The BS header cell carries both classes directly now (no wrapping
    // ancestor), so the override is a compound selector, not a descendant one.
    expect(css).toMatch(/tnl-col-head\.tnl-col-bs \{[\s\S]*?justify-content: center/)
  })
})

describe('the Attack column stays narrow, header included', () => {
  it('caps the column at 30px', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    expect(appended[0].textContent).toMatch(/attack___[\s\S]*?width: 30px !important/)
  })
})

describe('the narrowed columns carry no leftover Torn margin', () => {
  it('zeroes margin on level, score and status alongside their width', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const css = appended[0].textContent
    // Three separate rule blocks; each narrows a column AND strips its margin,
    // so nothing Torn's own class carried can reopen a gap once the box shrinks.
    expect(css.match(/margin: 0 !important/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
