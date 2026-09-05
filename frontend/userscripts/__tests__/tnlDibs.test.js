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
/**
 * Strip the `html.tnl-war-active` gate from a scoped stylesheet.
 *
 * injectStyles() runs the sheet through scopeCss() so no rule can match off the
 * war page. These assertions are about what the rules SAY, which the gate does
 * not change - the gate has its own describe block. Without this their line
 * anchors stop matching and the failure reads like a stylesheet bug.
 */
function unscope(css) {
  return String(css)
    .replace(/html\.tnl-war-active\./g, 'html.')
    .replace(/html\.tnl-war-active /g, '')
}

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

  it('⚠️ a debug-host override (staging QA) wins over tenants.json and skips fetching it entirely', async () => {
    // tenants.json is production-only by design — there is no ordinary way to
    // point a login at a *_dev host, which is exactly why this exists. It
    // must never fall back to tenants.json when set, or a maintainer testing
    // #523-style backend work against staging would silently land on prod.
    const { S, calls } = loadScript({
      routes: routes(), values: { 'tnl-dibs-debug-host': 'dev.monchoon.me' },
    })
    const session = await S.establishSession(API_KEY)
    expect(session.host).toBe('dev.monchoon.me')
    expect(calls.some((c) => c.url.includes('tenants.json'))).toBe(false)
    expect(calls.find((c) => c.url.includes('/api/auth/login')).url).toContain('dev.monchoon.me')
  })

  it('resolves via tenants.json as normal when no debug host is set', async () => {
    const { S } = loadScript({ routes: routes() })
    const session = await S.establishSession(API_KEY)
    expect(session.host).toBe('forge.monchoon.me')
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

describe('panelPos — the popover follows its launcher (#590)', () => {
  // A launcher sitting 120px down the page, 40px from the left.
  const rect = { left: 40, bottom: 120 }

  it('sits just under the anchor', () => {
    expect(S.panelPos(rect, 1200)).toEqual({ left: 40, top: 126 })
  })

  it('⚠️ adds the scroll offset, which is what stops it hanging in mid-air', () => {
    // #590: the panel was `position: fixed` at the anchor's VIEWPORT
    // coordinates, so it opened under the launcher and then stayed welded to
    // the screen while the page scrolled out from under it. On mobile, where
    // the settings panel is most of the script's UI, that meant it covered the
    // roster you were scrolling to read. Page coordinates + `absolute` make it
    // scroll with the button that opened it.
    expect(S.panelPos(rect, 1200, { x: 0, y: 900 })).toEqual({ left: 40, top: 1026 })
  })

  it('keeps a right-edge launcher from pushing the panel off-screen', () => {
    // The launcher lives in the page-title links, which sit hard right.
    expect(S.panelPos({ left: 700, bottom: 50 }, 800).left).toBe(800 - 260 - 8)
  })

  it('never goes off the left edge either', () => {
    expect(S.panelPos({ left: -30, bottom: 50 }, 1200).left).toBe(8)
  })

  it('tucks the panel in on a phone-width viewport', () => {
    // 320px: 260 of panel plus an 8px margin leaves exactly 52px of slack, so
    // a right-hand launcher pulls the panel back to there rather than past it.
    expect(S.panelPos({ left: 200, bottom: 50 }, 320).left).toBe(52)
  })

  it('⚠️ never inverts on a viewport too narrow to hold the panel', () => {
    // Below ~276px the clamp's own upper bound goes negative. Math.max pins it
    // to the left margin instead — off the right edge is recoverable by
    // scrolling, off the left edge is not.
    expect(S.panelPos({ left: 200, bottom: 50 }, 200).left).toBe(8)
  })

  it('parks at the left margin when the viewport width is unknown', () => {
    expect(S.panelPos({ left: 40, bottom: 120 }, 0)).toEqual({ left: 8, top: 126 })
  })

  it('defaults to no scroll, so a pinned anchor gets viewport coordinates', () => {
    expect(S.panelPos(rect, 1200)).toEqual(S.panelPos(rect, 1200, { x: 0, y: 0 }))
  })
})

describe('indexAssists sees an UPDATE, not just a create (#603)', () => {
  const base = {
    id: 7, target_id: 500, requester_id: 9001, requester_name: 'Me',
    kind: 'smoke', wanted: 1, created_at: '2026-09-05T10:00:00Z',
  }

  it('⚠ raises the count when the same row comes back with a bigger wanted', () => {
    // The whole bug. The map is keyed by TARGET and recency was judged on
    // `created_at`, which does not change when #591 does
    // `SET wanted = wanted + 1`. The row came back carrying the new number,
    // compared equal, and was thrown away — so every increment was dropped by
    // the very client that asked for it, and a reload was the only way to see
    // the truth.
    const map = S.indexAssists([base])
    expect(map.get(500).wanted).toBe(1)
    S.indexAssists([{ ...base, wanted: 3 }], map)
    expect(map.get(500).wanted).toBe(3)
  })

  it('lowers it again on the way back down', () => {
    const map = S.indexAssists([{ ...base, wanted: 3 }])
    S.indexAssists([{ ...base, wanted: 1 }], map)
    expect(map.get(500).wanted).toBe(1)
  })

  it('⚠ lets the server correct an optimistic entry stamped with a client clock', () => {
    // requestAssist() writes `at: new Date().toISOString()` — strictly LATER
    // than the server's created_at. Under the old recency-only rule that entry
    // beat every subsequent server row for the life of the page, which is why
    // a refresh was the only thing that ever showed the real count.
    const map = new Map([[500, {
      kind: 'smoke', by: 9001, name: 'You', wanted: 1,
      at: '2030-01-01T00:00:00Z',   // a clock way ahead of the server's
    }]])
    S.indexAssists([{ ...base, wanted: 4 }], map)
    expect(map.get(500).wanted).toBe(4)
    expect(map.get(500).id).toBe(7)
  })

  it('still lets a NEWER requester take the badge slot from an older one', () => {
    // Several people can raise a hand on one target and the badge shows one.
    // That rule is what the fix had to preserve while making updates land.
    const map = S.indexAssists([base])
    S.indexAssists([{
      ...base, id: 8, requester_id: 4242, requester_name: 'Ally',
      kind: 'tear', created_at: '2026-09-05T10:05:00Z',
    }], map)
    expect(map.get(500)).toMatchObject({ id: 8, by: 4242, kind: 'tear' })
  })

  it('⚠ does not let an OLDER stranger displace the request on screen', () => {
    const map = S.indexAssists([{ ...base, id: 8, created_at: '2026-09-05T10:05:00Z' }])
    S.indexAssists([{
      ...base, id: 9, requester_id: 4242, created_at: '2026-09-05T09:00:00Z',
    }], map)
    expect(map.get(500).id).toBe(8)
  })

  it('a tombstone for the shown request clears the slot; a stranger\u2019s does not', () => {
    const map = S.indexAssists([base])
    S.indexAssists([{ ...base, id: 99, requester_id: 4242, deleted_at: '2026-09-05T10:01:00Z' }], map)
    expect(map.get(500)).toBeTruthy()
    S.indexAssists([{ ...base, deleted_at: '2026-09-05T10:02:00Z' }], map)
    expect(map.get(500)).toBeUndefined()
  })
})

describe('sameAssistRequest', () => {
  it('matches on row id when both carry one', () => {
    expect(S.sameAssistRequest({ id: 7, by: 1 }, { id: 7, requester_id: 2 })).toBe(true)
    expect(S.sameAssistRequest({ id: 7, by: 1 }, { id: 8, requester_id: 1 })).toBe(false)
  })

  it('falls back to the requester for an optimistic entry that has no id yet', () => {
    expect(S.sameAssistRequest({ by: 9001 }, { id: 7, requester_id: 9001 })).toBe(true)
    expect(S.sameAssistRequest({ by: 9001 }, { id: 7, requester_id: 4242 })).toBe(false)
  })
})

describe('assistPressAction — tap asks for one more, hold gives one back (#600)', () => {
  const me = '9001'
  const mineSmoke = { kind: 'smoke', by: 9001, wanted: 3 }

  it('⚠ a second tap on your own kind REQUESTS, it does not cancel', () => {
    // The whole bug (#600). This used to route to clearAssist — the #523
    // toggle-off, written before counting existed and never revisited when
    // #591 added it. So the one gesture that should raise the count was the
    // one that destroyed the request, and the counter was unreachable from
    // the surface built for it.
    expect(S.assistPressAction(mineSmoke, 'smoke', me, 'short')).toBe('request')
  })

  it('taps through to request for a different kind, a stranger\u2019s request, or nothing live', () => {
    // One verb on purpose: the server already distinguishes increment from
    // replace, and a second copy of that rule here could only disagree with it.
    expect(S.assistPressAction(mineSmoke, 'tear', me, 'short')).toBe('request')
    expect(S.assistPressAction({ kind: 'smoke', by: 4242 }, 'smoke', me, 'short')).toBe('request')
    expect(S.assistPressAction(null, 'smoke', me, 'short')).toBe('request')
  })

  it('holding your own kind takes one back', () => {
    expect(S.assistPressAction(mineSmoke, 'smoke', me, 'long')).toBe('decrement')
  })

  it('⚠ holding does nothing when there is nothing of yours to take back', () => {
    // "If it's already at 0 it does nothing" — a hold is fat-fingerable, and
    // the alternative is an error the overlay would have to render mid-fight.
    expect(S.assistPressAction(null, 'smoke', me, 'long')).toBe('noop')
    expect(S.assistPressAction(mineSmoke, 'tear', me, 'long')).toBe('noop')
  })

  it('⚠ never lets a hold shave a count off someone else\u2019s request', () => {
    expect(S.assistPressAction({ kind: 'smoke', by: 4242 }, 'smoke', me, 'long')).toBe('noop')
  })

  it('compares ids loosely, because the session carries a string and rows carry numbers', () => {
    expect(S.assistPressAction({ kind: 'smoke', by: 9001 }, 'smoke', 9001, 'long')).toBe('decrement')
    expect(S.assistPressAction({ kind: 'smoke', by: '9001' }, 'smoke', me, 'long')).toBe('decrement')
  })

  it('holds for long enough to be deliberate but not long enough to feel stuck', () => {
    expect(S.LONG_PRESS_MS).toBeGreaterThanOrEqual(350)
    expect(S.LONG_PRESS_MS).toBeLessThanOrEqual(800)
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

describe('a click on one of Torn\u2019s own sort headers releases ours', () => {
  // We permute with flex `order`, which beats DOM order outright, so a list left
  // under our sort ignores Torn's reordering entirely \u2014 its arrow moves and no
  // row does. The sort has to be handed back when Torn's own header is clicked.
  const cell = (classes, hasSortIcon) => ({
    classList: { contains: (c) => classes.includes(c) },
    querySelector: (sel) => (hasSortIcon && sel.includes('sortIcon') ? {} : null),
  })

  it('claims Torn\u2019s sortable headers \u2014 Name, Level, Score', () => {
    expect(S.isTornSortHeader(cell(['member', 'left'], true))).toBe(true)
    expect(S.isTornSortHeader(cell(['level', 'left'], true))).toBe(true)
    expect(S.isTornSortHeader(cell(['points', 'left'], true))).toBe(true)
  })

  it('leaves our own headers alone, or clicking BS would clear the sort it just set', () => {
    // Our Status header is Torn's cell with our class added, so it keeps the
    // sortIcon \u2014 the marker class is what has to decide, not the icon.
    expect(S.isTornSortHeader(cell(['status', 'tnl-sort'], true))).toBe(false)
    expect(S.isTornSortHeader(cell(['tnl-col-bs', 'tnl-sort'], false))).toBe(false)
  })

  it('ignores a header cell that sorts nothing, like Attack or our DIBS column', () => {
    expect(S.isTornSortHeader(cell(['attack', 'left'], false))).toBe(false)
    expect(S.isTornSortHeader(cell(['tnl-col-dibs'], false))).toBe(false)
  })

  it('ignores a click that landed outside any header cell', () => {
    expect(S.isTornSortHeader(null)).toBe(false)
    expect(S.isTornSortHeader(undefined)).toBe(false)
  })
})

describe('the panel shows which version is running', () => {
  it('prefixes a v, the way the dashboard footer does', () => {
    expect(S.versionLabel('1.32.0')).toBe('v1.32.0')
    expect(S.versionLabel('  1.32.0  ')).toBe('v1.32.0')
  })

  it('says nothing rather than something wrong when there is no version', () => {
    // Tampermonkey always supplies one, but the test seam and a hand-pasted
    // copy of the file do not \u2014 "vundefined" in the panel is worse than a
    // panel with no version in it at all.
    expect(S.versionLabel(undefined)).toBeNull()
    expect(S.versionLabel(null)).toBeNull()
    expect(S.versionLabel('')).toBeNull()
    expect(S.versionLabel('   ')).toBeNull()
    expect(S.versionLabel(1.32)).toBeNull()
  })

  it('reads GM_info, and survives its absence', () => {
    expect(S.scriptVersion()).toBeNull()
  })

  it('is the version the file actually declares', () => {
    // Bumping @version without the CHANGELOG is the usual slip; this at least
    // keeps the panel honest about the file it came from.
    const declared = source.match(/^\/\/ @version\s+(\S+)$/m)?.[1]
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/)
    expect(S.versionLabel(declared)).toBe(`v${declared}`)
  })
})

describe('the battle-stat total is a real link, not a click handler', () => {
  // Middle-click, ctrl/cmd-click, "open in new tab" and the status-bar URL
  // preview are the browser's to give, and it only offers them on an <a href>.
  // A <span> with a click handler gets middle-click AUTOSCROLL instead.
  const fakeSlot = () => ({
    dataset: {}, style: {}, children: [],
    querySelector() { return this.children[0] ?? null },
    appendChild(c) { this.children.push(c); return c },
  })

  describe('attackLinkAttrs', () => {
    it('is everything the anchor needs, for a real player — no target, a plain click stays in this tab', () => {
      expect(S.attackLinkAttrs(2569218)).toEqual({
        href: 'https://www.torn.com/page.php?sid=attack&user2ID=2569218',
        rel: 'noopener noreferrer',
      })
    })

    it('carries noopener AND noreferrer regardless — middle-click and ctrl/cmd-click still open a new tab on a real <a>', () => {
      // noopener denies that tab a window.opener handle back to the war page;
      // without it that tab can navigate this one. noreferrer keeps Torn from
      // being told which page the click came from. Neither depends on target.
      const rel = S.attackLinkAttrs(1).rel.split(' ')
      expect(rel).toContain('noopener')
      expect(rel).toContain('noreferrer')
    })

    it('is null for an id that is not a player, so no href is written', () => {
      for (const bad of [0, -5, NaN, null, undefined, 'abc']) {
        expect(S.attackLinkAttrs(bad)).toBeNull()
      }
    })
  })

  it('builds an <a> carrying the attack URL, with no target set', () => {
    const { S: s, created } = loadWithDom()
    const el = s.statValueOf(fakeSlot(), 2569218)
    expect(created.at(-1).tagName).toBe('a')
    expect(el.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=2569218')
    expect(el.target).toBeUndefined()
    expect(el.rel).toBe('noopener noreferrer')
  })

  it('⚠️ never calls preventDefault on the click', () => {
    // This is the whole bug. The old handler did preventDefault + window.open,
    // which works for a plain left click and silently breaks every other way of
    // opening a link. Navigation has to stay the anchor's own default action.
    const { S: s } = loadWithDom()
    const el = s.statValueOf(fakeSlot(), 2569218)
    let prevented = false
    let propagationStopped = false
    for (const fn of el.listeners.click) {
      fn({ preventDefault: () => { prevented = true }, stopPropagation: () => { propagationStopped = true } })
    }
    expect(prevented).toBe(false)
    // Still kept off Torn's own row handler, which is what stopPropagation was for.
    expect(propagationStopped).toBe(true)
  })

  it('repoints the href when the row is reused for another member', () => {
    // Torn recycles rows, so a stale href would send the attack at whoever
    // happened to occupy that row last.
    const { S: s } = loadWithDom()
    const slot = fakeSlot()
    s.statValueOf(slot, 111)
    const el = s.statValueOf(slot, 222)
    expect(el.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=222')
    expect(el.dataset.tnlTarget).toBe('222')
  })

  it('drops the href rather than linking nowhere when the id is unusable', () => {
    const { S: s } = loadWithDom()
    const slot = fakeSlot()
    s.statValueOf(slot, 111)
    const el = s.statValueOf(slot, 0)
    expect(el.href).toBeUndefined()
  })

  it('does not restyle itself as one of Torn’s links before the paint lands', () => {
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const sheet = appended[0].textContent
    const rule = sheet.slice(sheet.indexOf('.tnl-col-bsv {'))
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/text-decoration: none/)
  })
})

describe('the tooltip marks the dominant stat (#541)', () => {
  it('prefixes the dominant stat’s label, leaving every other row untouched', () => {
    const stats = { total: 5_000_000, str: 2_100_000, def: 900_000, spd: 1_200_000, dex: 800_000, source: 'bsp', spiedAt: null }
    const tip = S.statsTip(stats, null)
    const lines = tip.split('\n')
    expect(lines.find((l) => l.startsWith('▸STR'))).toBeTruthy()
    // Every other row is byte-identical to the un-marked function — no marker,
    // no shifted numeric column.
    expect(lines.find((l) => l.startsWith('DEF '))).toBeTruthy()
    expect(lines.find((l) => l.startsWith('SPD '))).toBeTruthy()
    expect(lines.find((l) => l.startsWith('DEX '))).toBeTruthy()
  })

  it('marks nothing on a balanced build', () => {
    const stats = { total: 4_000_000, str: 1_000_000, def: 1_000_000, spd: 1_000_000, dex: 1_000_000, source: 'bsp', spiedAt: null }
    const tip = S.statsTip(stats, null)
    expect(tip).not.toContain('▸')
  })

  it('never changes where the numeric column starts', () => {
    // Same fixture as above, but every line's overall length must match —
    // that is what proves padEnd(5) absorbed the marker rather than growing.
    const dominant = { total: 5_000_000, str: 2_100_000, def: 900_000, spd: 1_200_000, dex: 800_000, source: 'bsp', spiedAt: null }
    const balanced = { total: 4_000_000, str: 1_000_000, def: 1_000_000, spd: 1_000_000, dex: 1_000_000, source: 'bsp', spiedAt: null }
    const a = S.statsTip(dominant, null).split('\n').find((l) => l.startsWith('▸STR'))
    const b = S.statsTip(balanced, null).split('\n').find((l) => l.startsWith('DEF'))
    expect(a.length).toBe(b.length)
  })
})

describe('numeric settings (settingNum / settings.num)', () => {
  it('falls back to the setting’s own default when unset', () => {
    expect(S.settingNum(null, S.SETTING_FF_THRESHOLD)).toBe(S.FF_THRESHOLD_DEFAULT)
    expect(S.settingNum(undefined, S.SETTING_FF_THRESHOLD)).toBe(S.FF_THRESHOLD_DEFAULT)
    expect(S.settingNum('', S.SETTING_FF_THRESHOLD)).toBe(S.FF_THRESHOLD_DEFAULT)
  })

  it('parses a stored numeric string', () => {
    expect(S.settingNum('2.8', S.SETTING_FF_THRESHOLD)).toBe(2.8)
    expect(S.settingNum('1', S.SETTING_FF_THRESHOLD)).toBe(1)
  })

  it('falls back on garbage rather than returning NaN', () => {
    expect(S.settingNum('not-a-number', S.SETTING_FF_THRESHOLD)).toBe(S.FF_THRESHOLD_DEFAULT)
    expect(Number.isNaN(S.settingNum('abc', S.SETTING_FF_THRESHOLD))).toBe(false)
  })

  it('settings.num() reads the same value settings.setNum() wrote', () => {
    // loadWithDom()'s GM mocks are no-ops; loadScript()'s `values` object is
    // the harness that actually persists a write, so it is the one that can
    // prove a round trip.
    const { S: s } = loadScript()
    expect(s.settings.num(s.SETTING_FF_THRESHOLD)).toBe(s.FF_THRESHOLD_DEFAULT)
    s.settings.setNum(s.SETTING_FF_THRESHOLD, 2.0)
    expect(s.settings.num(s.SETTING_FF_THRESHOLD)).toBe(2.0)
  })

})

describe('hospitalExits (#526 dibs hospital-exit alert)', () => {
  const hospital = { status: { state: 'Hospital', until: 999 } }
  const okay = { status: { state: 'Okay' } }

  it('fires only for a target that was hospital last poll and is not now', () => {
    const prev = new Map([[1, true]])
    const state = new Map([[1, okay]])
    expect(S.hospitalExits([1], prev, state)).toEqual([1])
  })

  it('never fires on the first poll — a target absent from the previous snapshot is skipped', () => {
    const prev = new Map()
    const state = new Map([[1, okay]])
    expect(S.hospitalExits([1], prev, state)).toEqual([])
  })

  it('does not fire while still in hospital', () => {
    const prev = new Map([[1, true]])
    const state = new Map([[1, hospital]])
    expect(S.hospitalExits([1], prev, state)).toEqual([])
  })

  it('does not fire for a target that was never in hospital to begin with', () => {
    const prev = new Map([[1, false]])
    const state = new Map([[1, okay]])
    expect(S.hospitalExits([1], prev, state)).toEqual([])
  })

  it('does not fire for a target that vanished from the roster entirely', () => {
    // Cannot positively confirm "out" for a target we no longer have any
    // state for — that is a disappearance, not a discharge.
    const prev = new Map([[1, true]])
    const state = new Map()
    expect(S.hospitalExits([1], prev, state)).toEqual([])
  })

  it('only reports the ids asked for, even if prev/state carry others', () => {
    const prev = new Map([[1, true], [2, true]])
    const state = new Map([[1, okay], [2, okay]])
    expect(S.hospitalExits([1], prev, state)).toEqual([1])
  })
})

describe('chain math (#524)', () => {
  describe('chainSecondsLeft', () => {
    it('is the gap to the timeout when the chain is live', () => {
      expect(S.chainSecondsLeft({ current: 50, timeout: 1000, cooldown: null }, 940)).toBe(60)
    })

    it('is null with no chain at all', () => {
      expect(S.chainSecondsLeft(null, 100)).toBeNull()
    })

    it('is null while on cooldown, even with a future timeout', () => {
      expect(S.chainSecondsLeft({ current: 50, timeout: 1000, cooldown: 2000 }, 100)).toBeNull()
    })

    it('is null once the timeout has already passed', () => {
      expect(S.chainSecondsLeft({ current: 50, timeout: 100, cooldown: null }, 200)).toBeNull()
    })

    it('is null with no chain actually built', () => {
      expect(S.chainSecondsLeft({ current: 0, timeout: 1000, cooldown: null }, 100)).toBeNull()
    })
  })

  describe('chainDropDue', () => {
    it('is true inside the threshold window', () => {
      expect(S.chainDropDue({ current: 50, timeout: 1000, cooldown: null }, 950, 60)).toBe(true)
    })

    it('is false outside the threshold window', () => {
      expect(S.chainDropDue({ current: 50, timeout: 1000, cooldown: null }, 800, 60)).toBe(false)
    })

    it('is false once the timer has already lapsed (0 seconds left is not "due")', () => {
      expect(S.chainDropDue({ current: 50, timeout: 1000, cooldown: null }, 1000, 60)).toBe(false)
    })
  })

  describe('nextBonusHit', () => {
    it('is the next milestone above the current count', () => {
      expect(S.nextBonusHit(0)).toBe(10)
      expect(S.nextBonusHit(9)).toBe(10)
      expect(S.nextBonusHit(10)).toBe(25)
      expect(S.nextBonusHit(24)).toBe(25)
    })

    it('is null past the last milestone', () => {
      expect(S.nextBonusHit(100000)).toBeNull()
      expect(S.nextBonusHit(500000)).toBeNull()
    })

    it('is null for a negative or unparseable count', () => {
      expect(S.nextBonusHit(-1)).toBeNull()
      expect(S.nextBonusHit('abc')).toBeNull()
      expect(S.nextBonusHit(undefined)).toBeNull()
    })
  })

  describe('chainBadgeText', () => {
    it('is null when there is no active chain — the widget has nothing to show', () => {
      expect(S.chainBadgeText(null, 100)).toBeNull()
      expect(S.chainBadgeText({ current: 0 }, 100)).toBeNull()
    })

    it('is the count alone when there is no live timer', () => {
      expect(S.chainBadgeText({ current: 42, timeout: null, cooldown: null }, 100)).toBe('⛓42')
    })

    it('appends the countdown when the timer is live', () => {
      expect(S.chainBadgeText({ current: 42, timeout: 160, cooldown: null }, 100)).toBe('⛓42 · 1m00s')
    })
  })

  describe('chainSaveButtonState', () => {
    it('offers to claim when nobody holds it', () => {
      expect(S.chainSaveButtonState({ save_claimed_by: null }, 5, false))
        .toEqual({ label: 'Claim save', action: 'claim', mine: false, taken: false })
    })

    it('offers to release when it is mine', () => {
      expect(S.chainSaveButtonState({ save_claimed_by: 5, save_claimed_name: 'You' }, 5, false))
        .toEqual({ label: 'Release save', action: 'release', mine: true, taken: true })
    })

    it('is read-only when held by someone else and I am not admin', () => {
      const s = S.chainSaveButtonState({ save_claimed_by: 9, save_claimed_name: 'Bob' }, 5, false)
      expect(s).toEqual({ label: 'Held by Bob', action: 'none', mine: false, taken: true })
    })

    it('lets an admin release someone else’s claim, mirroring buttonState()', () => {
      const s = S.chainSaveButtonState({ save_claimed_by: 9, save_claimed_name: 'Bob' }, 5, true)
      expect(s.action).toBe('release')
      expect(s.mine).toBe(false)
    })
  })
})

describe('claimChainSave / releaseChainSave', () => {
  it('claims the save and pokes the poll on success', async () => {
    const { S: s } = loadScript({
      routes: { '/api/war-room/chain-save': { status: 200, body: { ok: true } } },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.claimChainSave()
    expect(res.ok).toBe(true)
  })

  it('surfaces a 409 with the current holder’s name', async () => {
    const { S: s } = loadScript({
      routes: {
        '/api/war-room/chain-save': { status: 409, body: { error: 'Already claimed by Bob', owner: { id: 9, name: 'Bob' } } },
      },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.claimChainSave()
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Bob')
  })

  it('releases on success', async () => {
    const { S: s } = loadScript({
      routes: { '/api/war-room/chain-save': { status: 200, body: { ok: true } } },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.releaseChainSave()
    expect(res.ok).toBe(true)
  })

  it('surfaces a non-200 release failure', async () => {
    const { S: s } = loadScript({
      routes: { '/api/war-room/chain-save': { status: 403, body: { error: 'not yours' } } },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.releaseChainSave()
    expect(res.ok).toBe(false)
    expect(res.message).toBe('not yours')
  })
})

describe('checkDibsHospitalAlerts / checkChainAlert do not throw with no DOM', () => {
  it('checkDibsHospitalAlerts is a no-op without a session', () => {
    const { S: s } = loadWithDom()
    expect(() => s.checkDibsHospitalAlerts()).not.toThrow()
  })

  it('checkChainAlert is a no-op with the chain setting off', () => {
    const { S: s, values } = loadScript()
    values[s.SETTING_CHAIN] = 'false'
    expect(() => s.checkChainAlert()).not.toThrow()
  })

  it('showToast is a no-op with no document', () => {
    expect(() => S.showToast('test')).not.toThrow()
  })
})

describe('relabelColumnHeaders actually claims Name/Lv/Score for our own sort (#547)', () => {
  // Exercises the real call site — a test that only drives orderList()/
  // sortValueFor() directly would keep passing even if the three bindSort()
  // calls that make this feature exist at all were deleted.
  const fakeCell = (text) => ({
    dataset: {}, childNodes: [], children: [],
    classList: { add() {}, contains: () => false },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
    appendChild(child) { this.children.push(child); return child },
    // A real element's textContent setter wipes every child node — the
    // property has to behave that way here too, or the badge-survival test
    // below cannot actually distinguish the fix from the bug it guards.
    _text: text,
    get textContent() {
      return this.children.length > 0
        ? this.children.map((c) => c.textContent ?? '').join('')
        : this._text
    },
    set textContent(v) { this._text = v; this.children = [] },
  })

  function fakeRowWithHeader() {
    const memberCell = fakeCell('Members')
    const levelCell = fakeCell('Level')
    const scoreCell = fakeCell('Score')
    const attackCell = fakeCell('Attack')
    const header = {
      querySelector(sel) {
        if (sel.includes('member')) return memberCell
        if (sel.includes('level')) return levelCell
        if (sel.includes('points')) return scoreCell
        if (sel.includes('attack')) return attackCell
        return null
      },
    }
    const list = { dataset: {}, previousElementSibling: null, querySelector: () => header }
    const row = { parentNode: list, closest: () => list }
    return { row, list, memberCell, levelCell, scoreCell }
  }

  it('binds our sort to Name, Lv and Score, each keyed to its own list', () => {
    const { S: s } = loadWithDom()
    const { row, list, memberCell, levelCell, scoreCell } = fakeRowWithHeader()
    s.relabelColumnHeaders(row)
    expect(memberCell.dataset.tnlSortKey).toBe('name')
    expect(levelCell.dataset.tnlSortKey).toBe('level')
    expect(scoreCell.dataset.tnlSortKey).toBe('score')
    expect(memberCell._tnlSortList).toBe(list)
    expect(levelCell._tnlSortList).toBe(list)
    expect(scoreCell._tnlSortList).toBe(list)
  })

  it('the online/idle count badge survives repeated paintSortHeaders() calls — it is a sibling child, not overwritten text', () => {
    // This is the exact collision the label-span design exists to avoid:
    // membersHeaderCellOf() finds this SAME cell and appends the badge as a
    // child of it. A blind el.textContent = text on that cell would wipe the
    // badge out on every render pass. loadWithDom()'s querySelectorAll is a
    // stub that always returns [] — paintSortHeaders() would otherwise
    // silently touch nothing and the test would pass for the wrong reason —
    // so it is pointed at the cell this test actually bound.
    const { S: s, document: doc } = loadWithDom()
    const { row, memberCell } = fakeRowWithHeader()
    s.relabelColumnHeaders(row)
    const badge = { tagName: 'span', marker: 'member-count-badge' }
    memberCell.appendChild(badge)
    expect(memberCell.children).toContain(badge)

    doc.querySelectorAll = () => [memberCell]
    s.paintSortHeaders()
    s.paintSortHeaders()   // twice: also proves it isn't re-appended by luck

    expect(memberCell.children).toContain(badge)
  })

  it('a click on the Name header updates only that list’s sort state', () => {
    const { S: s } = loadWithDom()
    const { row, list, memberCell } = fakeRowWithHeader()
    s.relabelColumnHeaders(row)
    const otherList = {}
    expect(s.sortStateIndex().get(list)).toBeUndefined()
    memberCell.listeners.click[0]({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} })
    expect(s.sortStateIndex().get(list).key).toBe('name')
    expect(s.sortStateIndex().get(otherList)).toBeUndefined()
  })
})

describe('nameSortValue / levelSortValue / scoreSortValue (#547) — Torn’s own columns, read off the row', () => {
  const row = ({ name, level, score } = {}) => ({
    querySelector: (sel) => {
      if (sel.includes('profiles.php')) {
        return name === undefined ? null : { textContent: name, getAttribute: () => '/profiles.php?XID=1' }
      }
      if (sel.includes('level')) return level === undefined ? null : { textContent: level }
      if (sel.includes('points___')) return score === undefined ? null : { textContent: score }
      return null
    },
  })

  it('reads the honor-text name straight off the anchor, trimmed', () => {
    expect(S.nameSortValue(row({ name: '  Juggernaut  ' }))).toBe('Juggernaut')
  })

  it('is an empty string, not null, when there is no readable name — locale-compares fine either way', () => {
    expect(S.nameSortValue(row({}))).toBe('')
  })

  it('reads level as a number', () => {
    expect(S.levelSortValue(row({ level: '77' }))).toBe(77)
  })

  it('is null for an unparseable level, not a stray 0', () => {
    expect(S.levelSortValue(row({}))).toBeNull()
  })

  it('reads score as a number, decimals included', () => {
    expect(S.scoreSortValue(row({ score: '12.50' }))).toBe(12.5)
  })

  it('⚠️ strips Torn\'s thousands comma — a real top score once sorted as "missing" and dropped to the bottom (#547)', () => {
    expect(S.scoreSortValue(row({ score: '1,009.26' }))).toBe(1009.26)
    expect(S.scoreSortValue(row({ score: '12,345' }))).toBe(12345)
  })

  it('is null with no score cell', () => {
    expect(S.scoreSortValue(row({}))).toBeNull()
  })
})

describe('each war table sorts independently (#547)', () => {
  const fakeRow = (id, extra = {}) => ({
    dataset: {}, style: {},
    querySelector: (sel) => {
      if (sel.includes('profiles.php')) return { getAttribute: () => `/profiles.php?XID=${id}`, textContent: extra.name ?? '' }
      if (sel.includes('level')) return extra.level === undefined ? null : { textContent: extra.level }
      if (sel.includes('points___')) return extra.score === undefined ? null : { textContent: extra.score }
      return null
    },
  })
  const fakeList = (ids) => ({ children: ids.map((id) => fakeRow(id)), dataset: {} })

  it('sorting one list by BS leaves an unrelated list’s row order untouched', () => {
    const { S: s } = loadWithDom()
    const listA = fakeList([1, 2, 3])
    const listB = fakeList([4, 5, 6])
    const stats = s.statsIndex()
    stats.set(1, { total: 10 }); stats.set(2, { total: 30 }); stats.set(3, { total: 20 })

    s.sortStateIndex().set(listA, { key: 'bs', dir: -1 })
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    // listA: descending by total → 2 (30), 3 (20), 1 (10) → slots 1,2,3 in that order.
    expect(listA.children.map((r) => r.style.order)).toEqual(['3', '1', '2'])
    // listB was never given a sort state — untouched.
    expect(listB.children.every((r) => !r.style.order)).toBe(true)
  })

  it('two lists can each hold a different active sort at the same time', () => {
    const { S: s } = loadWithDom()
    const listA = fakeList([1, 2])
    const listB = fakeList([3, 4])
    s.sortStateIndex().set(listA, { key: 'bs', dir: -1 })
    s.sortStateIndex().set(listB, { key: 'status', dir: 1 })
    expect(s.sortStateIndex().get(listA).key).toBe('bs')
    expect(s.sortStateIndex().get(listB).key).toBe('status')
  })

  it('clearing one list’s sort does not touch the other’s', () => {
    const { S: s } = loadWithDom()
    const listA = fakeList([1, 2, 3])
    const listB = fakeList([4, 5, 6])
    const stats = s.statsIndex()
    stats.set(1, { total: 10 }); stats.set(2, { total: 30 }); stats.set(3, { total: 20 })
    stats.set(4, { total: 1 }); stats.set(5, { total: 3 }); stats.set(6, { total: 2 })

    s.sortStateIndex().set(listA, { key: 'bs', dir: -1 })
    s.sortStateIndex().set(listB, { key: 'bs', dir: -1 })
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    // Release A only.
    s.sortStateIndex().set(listA, { key: null, dir: 0 })
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    expect(listA.children.every((r) => !r.style.order)).toBe(true)
    // B keeps its own order — same shape sort as A had, unaffected by A's release.
    expect(listB.children.map((r) => r.style.order)).toEqual(['3', '1', '2'])
  })

  // The exact bug report: with the script disabled, Torn already sorts both
  // war tables from one click, because "Name"/"Lv"/"Score" are its own
  // columns and (as far as we can tell) share state across both tables at
  // the network/data layer, not just in the DOM. We cannot fix Torn's own
  // sort from outside — the only way to make these three columns behave
  // per-table is to take them over entirely, the same way BS/Status already
  // are, so this exercises 'name'/'level'/'score' through the identical path.
  it('sorting one list by Torn’s own Name column leaves the other list’s order alone', () => {
    const { S: s } = loadWithDom()
    const namesA = { 1: 'Zeta', 2: 'Alpha', 3: 'Mike' }
    const rowsA = [1, 2, 3].map((id) => fakeRow(id, { name: namesA[id] }))
    const listA = { children: rowsA, dataset: {} }
    const listB = fakeList([4, 5, 6])

    s.sortStateIndex().set(listA, { key: 'name', dir: 1 })   // ascending
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    // Alpha, Mike, Zeta -> ids 2, 3, 1 -> slots 1,2,3 in that order.
    expect(rowsA.map((r) => r.style.order)).toEqual(['3', '1', '2'])
    expect(listB.children.every((r) => !r.style.order)).toBe(true)
  })

  it('sorting one list by Torn’s own Level column leaves the other list’s order alone', () => {
    const { S: s } = loadWithDom()
    const levelsA = { 1: '50', 2: '10', 3: '30' }
    const rowsA = [1, 2, 3].map((id) => fakeRow(id, { level: levelsA[id] }))
    const listA = { children: rowsA, dataset: {} }
    const listB = fakeList([4, 5, 6])

    s.sortStateIndex().set(listA, { key: 'level', dir: -1 })   // descending
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    // 50, 30, 10 -> ids 1, 3, 2.
    expect(rowsA.map((r) => r.style.order)).toEqual(['1', '3', '2'])
    expect(listB.children.every((r) => !r.style.order)).toBe(true)
  })

  it('sorting one list by Torn’s own Score column leaves the other list’s order alone', () => {
    const { S: s } = loadWithDom()
    const scoresA = { 1: '5.00', 2: '25.00', 3: '15.00' }
    const rowsA = [1, 2, 3].map((id) => fakeRow(id, { score: scoresA[id] }))
    const listA = { children: rowsA, dataset: {} }
    const listB = fakeList([4, 5, 6])

    s.sortStateIndex().set(listA, { key: 'score', dir: -1 })   // descending
    s.orderList(listA, Date.now())
    s.orderList(listB, Date.now())

    // 25, 15, 5 -> ids 2, 3, 1.
    expect(rowsA.map((r) => r.style.order)).toEqual(['3', '1', '2'])
    expect(listB.children.every((r) => !r.style.order)).toBe(true)
  })
})

describe('submitFeedback (#547) — same endpoint the dashboard’s Feedback modal posts to', () => {
  it('rejects an empty title without making a request', async () => {
    const { S: s, calls } = loadScript()
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.submitFeedback('bug', '   ', 'desc')
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/title/i)
    expect(calls).toHaveLength(0)
  })

  it('rejects a title over the server’s own 200-char limit, client-side', () => {
    const { S: s } = loadScript()
    expect(s.FEEDBACK_TITLE_MAX).toBe(200)
    expect(s.FEEDBACK_DESC_MAX).toBe(5000)
  })

  it('rejects an over-length title before sending', async () => {
    const { S: s, calls } = loadScript()
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.submitFeedback('bug', 'x'.repeat(201), '')
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('rejects an over-length description before sending', async () => {
    const { S: s, calls } = loadScript()
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.submitFeedback('bug', 'ok', 'x'.repeat(5001))
    expect(res.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('posts to /api/feedback with the category, title, description and running version', async () => {
    const { S: s, calls } = loadScript({
      routes: { '/api/feedback': { status: 200, body: { url: 'https://github.com/x/y/issues/9', number: 9 } } },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.submitFeedback('suggestion', 'Make names clickable', 'Please')
    expect(res.ok).toBe(true)
    expect(res.number).toBe(9)
    const call = calls.find((c) => c.url.includes('/api/feedback'))
    expect(call.method).toBe('POST')
    const body = JSON.parse(call.data)
    expect(body).toMatchObject({ category: 'suggestion', title: 'Make names clickable', description: 'Please' })
    expect(body.app_version).toBeDefined()
  })

  it('surfaces the server error on a non-200, e.g. the rate limit', async () => {
    const { S: s } = loadScript({
      routes: { '/api/feedback': { status: 429, body: { error: 'Too many feedback submissions — please try again in a bit.' } } },
    })
    s.setSession({ userId: '5', host: 'x', token: 't' })
    const res = await s.submitFeedback('bug', 'ok', '')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Too many')
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
      const el = {
        tagName: tag, style: {}, dataset: {}, classList: { add() {}, remove() {} },
        children: [], listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
        appendChild(child) { this.children.push(child); return child },
        querySelector: () => null,
        removeAttribute(name) { delete this[name] },
      }
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
    expect(sheet).toMatch(/ul\.members-list > li[^,{]*,[^{]*\{[^}]*display: flex/)
  })

  it('⚠️ never un-hides a row TornTools has filtered out', () => {
    // TornTools is a browser extension a lot of players run; its Ranked War
    // Filter hides rows with .tt-hidden on the <li>. Our row rule targets the
    // same element and is MORE specific (ul.members-list > li = 0,1,2 vs their
    // 0,1,0), so at equal !important an unqualified display:flex wins and
    // their filter silently does nothing while our script is on. The :not()
    // is what keeps their rule the only one in play for a filtered row.
    const { S: s, appended } = loadWithDom()
    s.injectStyles()
    const sheet = unscope(appended[0].textContent)
    // Anchored to line start: the explanatory comment above the rule names the
    // same selector, and a bare indexOf finds the prose instead of the CSS.
    const rowRule = sheet.slice(sheet.indexOf('\nul.members-list > li') + 1)
    const selector = rowRule.slice(0, rowRule.indexOf('{'))
    expect(selector).toContain(':not(.tt-hidden)')
    // Both halves, or the .table-body variant leaks through unqualified.
    const parts = selector.split(',').filter(p => p.trim())
    expect(parts).toHaveLength(2)
    for (const part of parts) expect(part, part).toContain(':not(.tt-hidden)')
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
    // STR is dominant in this fixture (2.1M of 5M), so its line carries the
    // ▸ marker (#541) — strip it before comparing labels.
    expect(lines.slice(1, 5).map((l) => l.trim().replace(/^▸/, '').split(/\s+/)[0])).toEqual(['STR', 'DEF', 'SPD', 'DEX'])
    expect(lines[5]).toMatch(/^Total/)
    expect(lines.at(-1)).toContain('(TS)')
  })

  it('aligns the two columns, which is what white-space: pre is for', () => {
    const lines = S.statsTip(stats, 2.4).split('\n')
    // STR is dominant here and carries the ▸ marker — match either way.
    const str = lines.find((l) => /^▸?STR/.test(l))
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
    return unscope(appended[0].textContent)
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

  it('⚠️ a narrow screen hides NOTHING — not a column, not the badge', () => {
    // Three earlier versions of this rule dropped something on phones: BS,
    // then Score, then the badge. All were the float layout's reasoning, where
    // a row that did not fit wrapped. Under flex the name column is
    // flex:1 1 auto with min-width:0, so the row absorbs the squeeze by
    // ellipsising the name and everything survives.
    const sheet = css()
    const media = sheet.slice(sheet.indexOf('@media screen and (max-width:'))
    // The badge itself is never display:none — only the WORDS inside it are,
    // which is what turns "3 online / 8 idle" into "3 / 8".
    expect(media).toMatch(/\.tnl-member-count \.tnl-mc-word \{ display: none/)
    expect(media).not.toMatch(/\.tnl-member-count \{[^}]*display: none/)
    // Colour replaces the words it drops.
    expect(media).toMatch(/tnl-mc-on \{ color:/)
    expect(media).toMatch(/tnl-mc-idle \{ color:/)
    // Data columns appear only to be NARROWED, never hidden.
    for (const col of ['tnl-col-bs', 'points___', 'tnl-col-dibs', 'level___', 'status']) {
      const rule = new RegExp(`${col}[^{]*\\{[^}]*display: none`)
      expect(media, `${col} must not be hidden`).not.toMatch(rule)
    }
    expect(media).toMatch(/tnl-col-bs \{ width: \d+px/)
  })

  it('⚠️ declares the badge BEFORE the media query that compacts it', () => {
    // Same selector, same specificity, no !important — so source order is the
    // only thing deciding which padding/font-size wins. Emitted the other way
    // round (as it first was), the base rule silently overrides the compact
    // one and the badge stays full-size on a phone.
    const sheet = css()
    const base = sheet.indexOf('.tnl-member-count {')
    const query = sheet.indexOf('@media screen and (max-width:')
    expect(base).toBeGreaterThan(-1)
    expect(query).toBeGreaterThan(-1)
    expect(base).toBeLessThan(query)
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
    return unscope(appended[0].textContent)
  }

  it('hides the honor image and the SVG twin, showing the plain text', () => {
    const sheet = css()
    expect(sheet).toMatch(/tnl-plain-name img\s*\{\s*display: none/)
    expect(sheet).toContain('honor-text-svg')
    expect(sheet).toMatch(/honor-text:not\(\.honor-text-svg\)/)
  })

  it('pulls the plain-text span and its wrappers out of absolute positioning (#548) — an absolutely positioned honor-text is blockified and never sizes the <a> around it, collapsing the link to zero size once the image is hidden', () => {
    const sheet = css()
    expect(sheet).toMatch(/tnl-plain-name \.honor-text-wrap,\s*\n\.tnl-plain-name > a \{[\s\S]{0,120}position: static !important/)
    expect(sheet).toMatch(/honor-text:not\(\.honor-text-svg\) \{[\s\S]{0,80}position: static !important/)
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

describe('shrinkAttack (#548) — Torn does not always give the Attack cell a real link', () => {
  function attackRow({ hasHref } = {}) {
    let cell
    const leaf = {
      tagName: hasHref ? 'A' : 'SPAN',
      textContent: 'Attack',
      children: [],
      className: hasHref ? 't-blue h c-pointer' : 't-gray-9',
      getAttribute(name) {
        return hasHref && name === 'href' ? '/page.php?sid=attack&user2ID=39773' : null
      },
      replaceWith(node) {
        const i = cell._kids.indexOf(leaf)
        if (i !== -1) cell._kids[i] = node
      },
    }
    cell = { dataset: {}, _kids: [leaf], querySelectorAll: () => cell._kids.slice() }
    const row = { dataset: {}, querySelector: (sel) => (sel.includes('attack') ? cell : null) }
    return { row, cell, leaf }
  }

  it('leaves Torn’s own working link alone, just relabelling the text', () => {
    const { S: s } = loadWithDom()
    const { row, cell, leaf } = attackRow({ hasHref: true })
    s.shrinkAttack(row, 39773)
    expect(leaf.textContent).toBe('Atk')
    expect(cell._kids[0]).toBe(leaf)
    expect(cell.dataset.tnlAtk).toBe('1')
  })

  it('builds a real, working attack link — same URL the BS column uses — when Torn only gave a disabled span', () => {
    const { S: s } = loadWithDom()
    const { row, cell } = attackRow({ hasHref: false })
    s.shrinkAttack(row, 39773)
    const link = cell._kids[0]
    expect(link.textContent).toBe('Atk')
    expect(link.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=39773')
    // No target: a plain click stays in this tab; middle/ctrl-click still
    // opens a new one on its own, same as the BS link (#547 revert).
    expect(link.target).toBeUndefined()
  })

  it('falls back to a label-only rename with no player to link to — never link a teammate row', () => {
    const { S: s } = loadWithDom()
    const { row, cell, leaf } = attackRow({ hasHref: false })
    s.shrinkAttack(row, null)
    expect(leaf.textContent).toBe('Atk')
    expect(cell._kids[0]).toBe(leaf)
  })

  it('does nothing on a second call — the per-row guard is idempotent', () => {
    const { S: s } = loadWithDom()
    const { row, cell } = attackRow({ hasHref: false })
    s.shrinkAttack(row, 39773)
    const first = cell._kids[0]
    s.shrinkAttack(row, 39773)
    expect(cell._kids[0]).toBe(first)
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

// ── Assist requests (#523): two @match surfaces, one script ────────────────

describe('page-surface matching', () => {
  it('factionPageMatch matches only the faction page path', () => {
    const { S } = loadScript()
    expect(S.factionPageMatch('/factions.php')).toBe(true)
    expect(S.factionPageMatch('/loader.php')).toBe(false)
    expect(S.factionPageMatch('/')).toBe(false)
  })

  it('attackPageMatch requires BOTH the page.php path and sid=attack', () => {
    const { S } = loadScript()
    expect(S.attackPageMatch('/page.php', '?sid=attack&user2ID=123')).toBe(true)
    expect(S.attackPageMatch('/page.php', '?sid=hospital&user2ID=123')).toBe(false)
    expect(S.attackPageMatch('/factions.php', '?sid=attack')).toBe(false)
  })

  it('⚠️ rejects loader.php — Torn retired it for attacks; this exact mismatch once made isAttackPage() always false and the overlay never rendered', () => {
    const { S } = loadScript()
    expect(S.attackPageMatch('/loader.php', '?sid=attack&user2ID=123')).toBe(false)
  })

  it('attackTargetId reads user2ID off the query string', () => {
    const { S } = loadScript()
    expect(S.attackTargetId('?sid=attack&user2ID=90200')).toBe(90200)
    expect(S.attackTargetId('?sid=attack')).toBeNull()
    expect(S.attackTargetId('?sid=attack&user2ID=0')).toBeNull()
    expect(S.attackTargetId('?sid=attack&user2ID=not-a-number')).toBeNull()
  })

  it('⚠️ isFactionPage/isAttackPage degrade to false with no `location` (proves the guard, matches every other page-scoped helper in this file)', () => {
    const { S } = loadScript()
    expect(S.isFactionPage()).toBe(false)
    expect(S.isAttackPage()).toBe(false)
  })

  // The faction page is a hash-routed SPA and the path alone matches every tab
  // on it, which is how injectStyles' roster overrides ended up on Armory and
  // Crimes - visibly, as an empty full-width bar carrying the tab name.
  it('warRankRouteMatch gates on the hash route, not the tab query', () => {
    const { S } = loadScript()
    expect(S.warRankRouteMatch('#/war/rank')).toBe(true)
    expect(S.warRankRouteMatch('/war/rank')).toBe(true)
  })

  it('⚠️ ignores the type=N tab id entirely - it differs per faction, so gating on it would work for one faction and silently fail for the next', () => {
    const { S } = loadScript()
    for (const type of ['1', '2', '7', '13']) {
      expect(S.warRankRouteMatch('#/war/rank')).toBe(true)
      expect(`?step=your&type=${type}#/war/rank`.includes('#/war/rank')).toBe(true)
    }
  })

  it('lets deeper war sub-routes through, but nothing else', () => {
    const { S } = loadScript()
    expect(S.warRankRouteMatch('#/war/rank/12345')).toBe(true)
    expect(S.warRankRouteMatch('#/war/rank?tab=x')).toBe(true)
    expect(S.warRankRouteMatch('#/armory')).toBe(false)
    expect(S.warRankRouteMatch('#/crimes')).toBe(false)
    expect(S.warRankRouteMatch('#/war/ranked')).toBe(false)
    expect(S.warRankRouteMatch('#/war')).toBe(false)
    expect(S.warRankRouteMatch('')).toBe(false)
    expect(S.warRankRouteMatch(null)).toBe(false)
  })

  it('isWarRankPage degrades to false with no `location`', () => {
    const { S } = loadScript()
    expect(S.isWarRankPage()).toBe(false)
  })
})

// The assist panel is position:fixed on a page whose own controls it used to
// cover, so it is draggable - and a remembered position must never strand it
// outside a window it can no longer be dragged back into.
describe('clampAssistPos', () => {
  const size = { w: 200, h: 40 }
  const viewport = { vw: 1000, vh: 800 }

  it('leaves a position that already fits alone', () => {
    const { S } = loadScript()
    expect(S.clampAssistPos({ left: 300, top: 400 }, size, viewport)).toEqual({ left: 300, top: 400 })
  })

  it('⚠️ pulls a position saved on a wider window back inside a smaller one - an off-screen panel has no handle left to drag it back by', () => {
    const { S } = loadScript()
    expect(S.clampAssistPos({ left: 1800, top: 1400 }, size, viewport))
      .toEqual({ left: 1000 - 200 - 12, top: 800 - 40 - 12 })
  })

  it('keeps a negative position on-screen', () => {
    const { S } = loadScript()
    expect(S.clampAssistPos({ left: -500, top: -20 }, size, viewport)).toEqual({ left: 12, top: 12 })
  })

  it('⚠️ a null coordinate means "that edge" - Number(null) is 0, which is finite, so a null top must not silently mean the TOP edge', () => {
    const { S } = loadScript()
    expect(S.clampAssistPos({ left: 12, top: null }, size, viewport)).toEqual({ left: 12, top: 800 - 40 - 12 })
  })

  it('survives a viewport smaller than the panel without going negative', () => {
    const { S } = loadScript()
    const pos = S.clampAssistPos({ left: 50, top: 50 }, { w: 400, h: 400 }, { vw: 200, vh: 200 })
    expect(pos.left).toBeGreaterThanOrEqual(0)
    expect(pos.top).toBeGreaterThanOrEqual(0)
  })
})

describe('parseAssistPos', () => {
  it('reads a stored JSON position', () => {
    const { S } = loadScript()
    expect(S.parseAssistPos('{"left":10,"top":20}')).toEqual({ left: 10, top: 20 })
    expect(S.parseAssistPos({ left: 10, top: 20 })).toEqual({ left: 10, top: 20 })
  })

  it('returns null for anything unusable, so the caller falls back to a corner', () => {
    const { S } = loadScript()
    for (const bad of [null, '', 'not json', '{"left":"x","top":2}', '{}']) {
      expect(S.parseAssistPos(bad)).toBeNull()
    }
  })
})

// ── Fight-log observation ─────────────────────────────────────────────────
//
// Rows transcribed from a real captured fight (MonChoon vs 4444444, with
// ziuta_616 and Onyx joining). The `attacking-events-*` classes are the stable
// hooks; everything else on the row is a rotating CSS-module hash.

const LOG = {
  monchoonFired: { eventClass: 'attacking-events-attack-win', text: 'MonChoon_616 fired 3 rounds of his SIG 552 hitting 4444444 in the Stomach for 6296', age: '26s' },
  targetMissed:  { eventClass: 'attacking-events-miss', text: '4444444 missed ziuta_616 with his Fists', age: '51s' },
  ziutaTear:     { eventClass: 'attacking-events-grenade-use', text: 'ziuta_616 threw a Tear Gas Grenade near 4444444', age: '51s' },
  ziutaJoin:     { eventClass: 'attacking-events-attack-join', text: 'ziuta_616 joined the fight against 4444444', age: '53s' },
  onyxSmoke:     { eventClass: 'attacking-events-grenade-use', text: 'Onyx threw a Smoke Grenade, smoke clouds around 4444444', age: '67s' },
  onyxJoin:      { eventClass: 'attacking-events-attack-join', text: 'Onyx joined the fight against 4444444', age: '69s' },
  monchoonInit:  { eventClass: 'attacking-events-attack-join', text: 'MonChoon_616 initiated an attack against 4444444', age: '132s' },
}
const ALL_ROWS = Object.values(LOG)

describe('parseFightLogAge', () => {
  it('reads the plain-seconds form Torn writes today', () => {
    const { S } = loadScript()
    expect(S.parseFightLogAge('26s')).toBe(26)
    expect(S.parseFightLogAge('132s')).toBe(132)
  })

  it('⚠️ reads minutes and hours too - a unit Torn might start using must not parse as a much smaller number, since an event mis-dated as recent wrongly answers a request', () => {
    const { S } = loadScript()
    expect(S.parseFightLogAge('2m 12s')).toBe(132)
    expect(S.parseFightLogAge('2m')).toBe(120)
    expect(S.parseFightLogAge('1h 1m 1s')).toBe(3661)
  })

  it('returns null for anything it cannot read, rather than a wrong number', () => {
    const { S } = loadScript()
    for (const bad of ['', null, undefined, 'just now', 'abc', '12x']) {
      expect(S.parseFightLogAge(bad)).toBeNull()
    }
  })
})

describe('parseFightLogRow', () => {
  it('reads a join', () => {
    const { S } = loadScript()
    expect(S.parseFightLogRow(LOG.onyxJoin)).toEqual({ kind: 'join', actor: 'Onyx', subject: '4444444' })
  })

  it('reads both grenades, despite Torn wording them differently', () => {
    const { S } = loadScript()
    expect(S.parseFightLogRow(LOG.onyxSmoke)).toEqual({ kind: 'smoke', actor: 'Onyx', subject: '4444444' })
    expect(S.parseFightLogRow(LOG.ziutaTear)).toEqual({ kind: 'tear', actor: 'ziuta_616', subject: '4444444' })
  })

  it('⚠️ ignores "initiated an attack" - it carries the SAME attacking-events-attack-join class as a real join, and counting it would make every requester their own first answer', () => {
    const { S } = loadScript()
    expect(S.parseFightLogRow(LOG.monchoonInit)).toBeNull()
  })

  it('ignores hits and misses', () => {
    const { S } = loadScript()
    expect(S.parseFightLogRow(LOG.monchoonFired)).toBeNull()
    expect(S.parseFightLogRow(LOG.targetMissed)).toBeNull()
  })

  it('ignores an unknown event class outright, whatever the text says', () => {
    const { S } = loadScript()
    expect(S.parseFightLogRow({ eventClass: 'attacking-events-something-new', text: 'Onyx joined the fight against 4444444', age: '1s' })).toBeNull()
  })
})

describe('assistCandidates', () => {
  const opts = { targetName: '4444444', requesterName: 'MonChoon_616', nowMs: 1000000 }

  it('picks the joins and grenades aimed at our target', () => {
    const { S } = loadScript()
    expect(S.assistCandidates(ALL_ROWS, opts).map((e) => `${e.kind}:${e.actor}`).sort())
      .toEqual(['join:Onyx', 'join:ziuta_616', 'smoke:Onyx', 'tear:ziuta_616'])
  })

  it('⚠️ drops a join against SOMEONE ELSE - once several people are in, one log carries joins aimed at several different people, including at us', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([{ eventClass: 'attacking-events-attack-join', text: 'SomeEnemy joined the fight against MonChoon_616', age: '5s' }], opts)).toEqual([])
  })

  it('⚠️ drops a grenade thrown AT one of ours - that is an enemy attacking us, and it has the identical event class to a member helping', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([{ eventClass: 'attacking-events-grenade-use', text: 'SomeEnemy threw a Tear Gas Grenade near ziuta_616', age: '5s' }], opts)).toEqual([])
  })

  it('drops the target own actions - they fight back, in the same log', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([{ eventClass: 'attacking-events-grenade-use', text: '4444444 threw a Smoke Grenade, smoke clouds around 4444444', age: '5s' }], opts)).toEqual([])
  })

  it('⚠️ counts only what happened AFTER the hand went up - this is what makes "smoke first, then ask" behave, since your own earlier smoke cannot answer the later request', () => {
    const { S } = loadScript()
    const got = S.assistCandidates(ALL_ROWS, { ...opts, requestedAtMs: 1000000 - 60000 })
    expect(got.map((e) => e.kind).sort()).toEqual(['join', 'tear'])
  })

  it('a join is never the requester - they are already in the fight', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([{ eventClass: 'attacking-events-attack-join', text: 'MonChoon_616 joined the fight against 4444444', age: '5s' }], opts)).toEqual([])
  })

  it('but a grenade the requester throws themselves DOES count - asking for three smokes and throwing one is one of the three', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([{ eventClass: 'attacking-events-grenade-use', text: 'MonChoon_616 threw a Smoke Grenade, smoke clouds around 4444444', age: '5s' }], opts).map((e) => e.kind)).toEqual(['smoke'])
  })

  it('stamps an absolute time, so the server is not left to trust a relative one', () => {
    const { S } = loadScript()
    expect(S.assistCandidates([LOG.onyxJoin], opts)[0].at_ms).toBe(1000000 - 69000)
  })

  it('returns nothing when the target is unknown, rather than guessing', () => {
    const { S } = loadScript()
    expect(S.assistCandidates(ALL_ROWS, { ...opts, targetName: null })).toEqual([])
    expect(S.assistCandidates(null, opts)).toEqual([])
  })
})

// ── Stylesheet scoping ────────────────────────────────────────────────────
//
// The roster stylesheet targets Torn's OWN component classes (.white-grad,
// .table-header, ul.members-list) because on the war roster those ARE the
// roster. They are reused on every other faction tab, so a sheet that outlives
// the war page inflates Torn's section header into an empty full-width bar
// carrying the tab name. Removing the <style> on route change is the intended
// path, but it can miss: a pushState that changes no hash fires neither
// hashchange nor popstate. Scoping makes the leak impossible instead.

describe('scopeCss', () => {
  it('prefixes an ordinary selector with the gate class', () => {
    const { S } = loadScript()
    expect(S.scopeCss('.white-grad { display: flex; }', 'g'))
      .toBe('html.g .white-grad { display: flex; }')
  })

  it('prefixes every selector in a comma-separated list, not just the first', () => {
    const { S } = loadScript()
    const out = S.scopeCss('.a, .b, .c { color: red; }', 'g')
    expect(out).toContain('html.g .a')
    expect(out).toContain('html.g .b')
    expect(out).toContain('html.g .c')
  })

  it('⚠️ adds the class TO an html-leading selector rather than in front of it - `html.g html.x` can never match, since html is nobody\'s descendant', () => {
    const { S } = loadScript()
    expect(S.scopeCss('html.tnl-tinting .x { display: none; }', 'g'))
      .toBe('html.g.tnl-tinting .x { display: none; }')
  })

  it('scopes rules INSIDE an at-rule block, and leaves the preamble alone', () => {
    const { S } = loadScript()
    const out = S.scopeCss('@media (max-width: 600px) { .a { color: red; } }', 'g')
    expect(out).toContain('@media (max-width: 600px) {')
    expect(out).toContain('html.g .a')
    expect(out).not.toContain('html.g @media')
  })

  it('⚠️ leaves keyframe steps alone - `from`, `to` and `0%` are not selectors, and scoping them silently kills the animation', () => {
    const { S } = loadScript()
    const out = S.scopeCss('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }', 'g')
    expect(out).not.toContain('html.g from')
    expect(out).not.toContain('html.g to')
  })

  it('does not trip over braces inside comments', () => {
    const { S } = loadScript()
    const out = S.scopeCss('/* a } brace { in a comment */ .a { color: red; }', 'g')
    expect(out).toContain('html.g .a { color: red; }')
    expect(out).toContain('/* a } brace { in a comment */')
  })

  it('leaves declaration bodies untouched', () => {
    const { S } = loadScript()
    expect(S.scopeCss('.a { background: url("x{y}"); }', 'g')).toContain('background: url("x{y}")')
  })

  it('keeps a :not() list whole - a top-level comma split would break it', () => {
    const { S } = loadScript()
    const out = S.scopeCss('li:not(.a, .b) { color: red; }', 'g')
    expect(out).toBe('html.g li:not(.a, .b) { color: red; }')
  })
})

describe('the shipped stylesheet, once scoped', () => {
  it('⚠️ leaves NO rule able to match while the gate class is off - that is the whole point, and one unscoped rule is the bug returning', () => {
    const { S, appended } = loadWithDom()
    S.injectStyles()
    const sheet = appended[0].textContent
    // Round-trip: strip the gate, put it back, and the sheet must be identical.
    // A rule that escaped scoping would come back with a gate it did not have
    // before, so the two strings would differ. This checks the real shipped
    // sheet without re-implementing a CSS parser in the test to do it.
    expect(S.scopeCss(unscope(sheet), S.WAR_ACTIVE_CLASS)).toBe(sheet)
  })

  it('actually carries the gate - the round-trip above would also pass on an unscoped sheet', () => {
    const { S, appended } = loadWithDom()
    S.injectStyles()
    const sheet = appended[0].textContent
    expect(sheet).toContain(`html.${S.WAR_ACTIVE_CLASS} .white-grad`)
    expect(sheet).toContain(`html.${S.WAR_ACTIVE_CLASS} ul.members-list`)
    // And the html-leading rules got the class merged in, not prefixed.
    expect(sheet).toContain(`html.${S.WAR_ACTIVE_CLASS}.tnl-tinting`)
  })
})

// ── Torn PDA compatibility ────────────────────────────────────────────────
//
// The dashboard API is on a different origin from torn.com and serves NO CORS
// headers, so a privileged transport is the ONLY way this script reaches its
// own backend. Torn PDA ships PDA_httpGet/PDA_httpPost rather than the GM API,
// and the GM one only if the user separately installs GMforPDA.user.js - so
// "no GM" has to mean "try PDA", not "give up".
describe('transportName', () => {
  it('reports GM when a userscript manager provides one', () => {
    const { S } = loadScript()
    expect(S.transportName()).toBe('GM')
  })
})

describe('gmGet/gmSet', () => {
  it('reads through the GM API when it exists', () => {
    const { S } = loadScript({ values: { 'some-key': 'some-value' } })
    expect(S.gmGet('some-key', null)).toBe('some-value')
  })

  it('returns the fallback for a key that was never set', () => {
    const { S } = loadScript()
    expect(S.gmGet('missing-key', 'dflt')).toBe('dflt')
  })

  it('⚠️ never throws when neither GM storage nor localStorage exists - this ran as a bare ReferenceError on Torn PDA, where GM_setValue is simply not defined', () => {
    const { S } = loadScript()
    expect(() => S.gmSet('k', 'v')).not.toThrow()
    expect(() => S.gmGet('k', null)).not.toThrow()
  })
})

describe('indexAssists', () => {
  it('indexes a live row, keyed by target', () => {
    const { S } = loadScript()
    const idx = S.indexAssists([
      { target_id: 90200, requester_id: 1300, requester_name: 'Scout', kind: 'smoke', created_at: '2026-08-21T10:00:00Z' },
    ], new Map())
    // `id` joined the entry in #603 — it is how an UPDATE to this same request
    // is recognised on the next delta instead of being discarded as stale.
    expect(idx.get(90200)).toEqual({
      id: null, kind: 'smoke', by: 1300, name: 'Scout', at: '2026-08-21T10:00:00Z', wanted: 1,
    })
  })

  // #591: a request is a count. The index has to carry it or the badge and the
  // overlay pip have nothing to render from.
  it('carries the count through', () => {
    const { S } = loadScript()
    const idx = S.indexAssists([
      { target_id: 90201, requester_id: 1300, requester_name: 'Scout', kind: 'smoke', created_at: '2026-08-21T10:00:00Z', wanted: 4 },
    ], new Map())
    expect(idx.get(90201).wanted).toBe(4)
  })

  it('⚠️ floors an absent or unusable count at ONE, never zero — a row from before the column existed would otherwise render "×0", which reads as "nobody is asking", the opposite of what a live row means', () => {
    const { S } = loadScript()
    for (const bad of [undefined, null, 0, -3, 'x']) {
      expect(S.assistCount(bad), String(bad)).toBe(1)
    }
    expect(S.assistCount(4)).toBe(4)
  })

  it('the badge only shows a multiple when there is one', () => {
    const { S } = loadScript()
    const one = S.badgeState(null, { by: 7, name: 'A', kind: 'smoke', wanted: 1 }, 1, 9)
    expect(one.label).toBe('Smoke')
    const three = S.badgeState(null, { by: 7, name: 'A', kind: 'smoke', wanted: 3 }, 1, 9)
    expect(three.label).toBe('Smoke \u00D73')
    expect(three.title).toMatch(/3 still needed/)
  })

  it('a tombstone for the currently-shown requester clears the target', () => {
    const { S } = loadScript()
    const idx = new Map()
    S.indexAssists([{ target_id: 1, requester_id: 999, requester_name: 'A', kind: 'help', created_at: '2026-08-21T10:00:00Z' }], idx)
    S.indexAssists([{ target_id: 1, requester_id: 999, deleted_at: '2026-08-21T10:01:00Z' }], idx)
    expect(idx.has(1)).toBe(false)
  })

  it('⚠️ a tombstone for a DIFFERENT (losing) requester does not clear a still-live winner', () => {
    const { S } = loadScript()
    const idx = new Map()
    S.indexAssists([
      { target_id: 1, requester_id: 111, requester_name: 'Old', kind: 'smoke', created_at: '2026-08-21T10:00:00Z' },
      { target_id: 1, requester_id: 222, requester_name: 'New', kind: 'help', created_at: '2026-08-21T10:05:00Z' },
    ], idx)
    // Newest wins the slot — 222 ("New").
    expect(idx.get(1)).toMatchObject({ by: 222, name: 'New' })
    // 111's tombstone (arriving late) must not blank the target: it is not
    // the row currently shown.
    S.indexAssists([{ target_id: 1, requester_id: 111, deleted_at: '2026-08-21T10:06:00Z' }], idx)
    expect(idx.get(1)).toMatchObject({ by: 222, name: 'New' })
  })

  it('the newest live request wins the slot regardless of arrival order', () => {
    const { S } = loadScript()
    const idx = new Map()
    S.indexAssists([
      { target_id: 1, requester_id: 222, requester_name: 'New', kind: 'help', created_at: '2026-08-21T10:05:00Z' },
      { target_id: 1, requester_id: 111, requester_name: 'Old', kind: 'smoke', created_at: '2026-08-21T10:00:00Z' },
    ], idx)
    expect(idx.get(1)).toMatchObject({ by: 222, name: 'New' })
  })

  it('ignores a row with no usable target id', () => {
    const { S } = loadScript()
    const idx = S.indexAssists([{ target_id: 0, requester_id: 1, kind: 'help' }], new Map())
    expect(idx.size).toBe(0)
  })
})

describe('enemy loadout capture (#528 Part 2)', () => {
  describe('parseWeaponAriaLabel', () => {
    it('extracts the weapon name from "Attack with <name>"', () => {
      const { S } = loadScript()
      expect(S.parseWeaponAriaLabel('Attack with AK-47')).toBe('AK-47')
      expect(S.parseWeaponAriaLabel('Attack with  Baseball Bat  ')).toBe('Baseball Bat')
    })

    it('⚠️ returns null for an unrevealed slot ("This weapon is not available") — never guesses a name', () => {
      const { S } = loadScript()
      expect(S.parseWeaponAriaLabel('This weapon is not available')).toBeNull()
      expect(S.parseWeaponAriaLabel('')).toBeNull()
      expect(S.parseWeaponAriaLabel(null)).toBeNull()
      expect(S.parseWeaponAriaLabel(undefined)).toBeNull()
    })
  })

  describe('weaponItemIdFromSrc', () => {
    it('is a bonus-only signal parsed off Torn\'s own image path', () => {
      const { S } = loadScript()
      expect(S.weaponItemIdFromSrc('/images/items/206/large.png')).toBe(206)
      expect(S.weaponItemIdFromSrc('https://www.torn.com/images/items/206/large.png')).toBe(206)
    })

    it('⚠️ is null, never required, when a gear-hiding script strips the src', () => {
      const { S } = loadScript()
      expect(S.weaponItemIdFromSrc('')).toBeNull()
      expect(S.weaponItemIdFromSrc(null)).toBeNull()
      expect(S.weaponItemIdFromSrc(undefined)).toBeNull()
      expect(S.weaponItemIdFromSrc('/images/items/silhouettes/primary.svg')).toBeNull()
    })
  })

  describe('mapArmorAltToSlot', () => {
    it('maps Torn\'s <area alt> body-part labels to our slot keys', () => {
      const { S } = loadScript()
      expect(S.mapArmorAltToSlot('Chest')).toBe('chest')
      expect(S.mapArmorAltToSlot('Helmet')).toBe('helmet')
      expect(S.mapArmorAltToSlot('Pants')).toBe('pants')
      expect(S.mapArmorAltToSlot('Boots')).toBe('boots')
      expect(S.mapArmorAltToSlot('Gloves')).toBe('gloves')
    })

    it('is null for a body part we do not track', () => {
      const { S } = loadScript()
      expect(S.mapArmorAltToSlot('Face')).toBeNull()
      expect(S.mapArmorAltToSlot('')).toBeNull()
      expect(S.mapArmorAltToSlot(null)).toBeNull()
    })
  })

  describe('loadoutIsEmpty', () => {
    it('is true when neither group captured anything', () => {
      const { S } = loadScript()
      expect(S.loadoutIsEmpty({ weapons: {}, armor: {} })).toBe(true)
      expect(S.loadoutIsEmpty({})).toBe(true)
      expect(S.loadoutIsEmpty(null)).toBe(true)
    })

    it('is false with at least one captured slot', () => {
      const { S } = loadScript()
      expect(S.loadoutIsEmpty({ weapons: { primary: { name: 'AK-47' } }, armor: {} })).toBe(false)
      expect(S.loadoutIsEmpty({ weapons: {}, armor: { chest: { name: 'Combat Vest' } } })).toBe(false)
    })
  })

  // ⚠️ Shipped to production once already: Torn duplicates BOTH
  // #modelLayersContainer and every #weapon_* id across the attacker's own
  // panel and the defender's, and the attacker's panel is always first in
  // document order. Three real captures on live production were every one
  // MonChoon's OWN gear, because the old code read
  // document.querySelector('#modelLayersContainer') unscoped — the first
  // match, always the attacker. The fix anchors on `defender___<hash>`, the
  // one class fragment Torn puts only on the opponent's weapon wrappers, and
  // scopes every subsequent read inside that ancestor. This harness models
  // that exact duplicate-id shape so a regression to the unscoped read fails
  // here, not in a live faction's data.
  describe('defenderScopeElement / captureWeapons / captureArmor / captureLoadout — attacker vs defender scoping', () => {
    function fakeElement(props = {}) {
      return {
        getAttribute: (name) => props[name] ?? null,
        querySelector: () => null,
        ...props,
      }
    }

    /** One player panel, with Torn's real duplicate ids: #modelLayersContainer
     *  and #weapon_main/#weapon_second/#weapon_melee/#weapon_temp — only a
     *  defender's weapon wrappers additionally carry a `defender___` class. */
    function fakePanel({ isDefender, weapons, armorAreas }) {
      const weaponEls = {}
      for (const [id, ariaLabel] of Object.entries(weapons)) {
        weaponEls[id] = fakeElement({
          'aria-label': ariaLabel,
          className: isDefender ? 'weaponWrapper___x defender___y7z' : 'weaponWrapper___x',
        })
      }
      const areaEls = armorAreas.map(([alt, title]) => fakeElement({ alt, title }))
      const panel = {
        querySelector(sel) {
          if (sel === '#modelLayersContainer') return fakeElement({ id: 'modelLayersContainer' })
          const id = sel.startsWith('#') ? sel.slice(1) : null
          return (id && weaponEls[id]) || null
        },
        querySelectorAll(sel) {
          return sel === '#modelLayersContainer map area[title][alt]' ? areaEls : []
        },
      }
      // The specific weapon node document.querySelector('[class*="defender___"]')
      // would find live — its parentElement is this panel, exactly like Torn's
      // real markup (weapon wrapper -> playerArea -> ... -> player panel).
      return { panel, defenderWeaponMain: weaponEls.weapon_main }
    }

    function loadDomWithFight() {
      const { S, document: doc } = loadWithDom()
      const attacker = fakePanel({
        isDefender: false,
        weapons: { weapon_main: 'Attack with Steyr AUG', weapon_second: 'Attack with China Lake' },
        armorAreas: [['Chest', 'Vanguard Body'], ['Helmet', 'Vanguard Respirator']],
      })
      const defender = fakePanel({
        isDefender: true,
        weapons: { weapon_main: 'Attack with Jackhammer', weapon_second: 'Attack with Dual 92G Berettas' },
        armorAreas: [['Chest', 'Combat Vest'], ['Helmet', 'Combat Helmet']],
      })
      defender.defenderWeaponMain.parentElement = defender.panel
      // Matches real behaviour: an unscoped '#modelLayersContainer' lookup
      // finds the ATTACKER's copy first — this is what the old, buggy code
      // asked for, and is exactly why it read the wrong side.
      doc.querySelector = (sel) => {
        if (sel === '[class*="defender___"]') return defender.defenderWeaponMain
        if (sel === '#modelLayersContainer') return fakeElement({ id: 'modelLayersContainer' })
        return null
      }
      return { S, attacker, defender }
    }

    it('defenderScopeElement() resolves to the DEFENDER panel, not the attacker\'s (which is first in document order)', () => {
      const { S, defender } = loadDomWithFight()
      expect(S.defenderScopeElement()).toBe(defender.panel)
    })

    it('captureWeapons() scoped to the defender panel reads the DEFENDER\'s weapons, never the attacker\'s', () => {
      const { S, defender } = loadDomWithFight()
      const weapons = S.captureWeapons(defender.panel)
      expect(weapons.primary?.name).toBe('Jackhammer')
      expect(weapons.secondary?.name).toBe('Dual 92G Berettas')
      expect(Object.values(weapons).map((w) => w.name)).not.toContain('Steyr AUG')
    })

    it('captureArmor() scoped to the defender panel reads the DEFENDER\'s armour, never the attacker\'s', () => {
      const { S, defender } = loadDomWithFight()
      const armor = S.captureArmor(defender.panel)
      expect(armor.chest?.name).toBe('Combat Vest')
      expect(armor.helmet?.name).toBe('Combat Helmet')
      expect(Object.values(armor).map((a) => a.name)).not.toContain('Vanguard Body')
    })

    it('⚠️ captureLoadout() end-to-end never returns the attacker\'s own gear — the exact bug three real production captures shipped', () => {
      const { S } = loadDomWithFight()
      const loadout = S.captureLoadout()
      expect(loadout.weapons.primary?.name).toBe('Jackhammer')
      expect(loadout.armor.chest?.name).toBe('Combat Vest')
      const allNames = [...Object.values(loadout.weapons), ...Object.values(loadout.armor)].map((e) => e.name)
      expect(allNames).not.toContain('Steyr AUG')
      expect(allNames).not.toContain('Vanguard Body')
    })

    it('is null when no defender weapon wrapper is found at all (e.g. the faction page, or a torn.com layout change)', () => {
      const { S, document: doc } = loadWithDom()
      doc.querySelector = () => null
      expect(S.defenderScopeElement()).toBeNull()
      expect(S.captureLoadout()).toBeNull()
    })
  })
})

describe('badgeState', () => {
  const ME = '2250591'

  it('falls through to buttonState with no active assist', () => {
    const { S } = loadScript()
    const st = S.badgeState(null, null, 90200, ME)
    expect(st).toMatchObject({ mode: 'dibs', label: 'Dibs', action: 'claim', href: null })
  })

  it('⚠️ an active assist morphs the SAME badge — dibs underneath is untouched but hidden', () => {
    const { S } = loadScript()
    const dib = { by: 999, name: 'Thug' } // dibbed too — must not show through
    const assist = { kind: 'smoke', by: 1300, name: 'Scout', at: new Date().toISOString() }
    const st = S.badgeState(dib, assist, 90200, ME)
    expect(st.mode).toBe('assist')
    expect(st.label).toBe('Smoke')
    expect(st.icon).toBe('cloud-fog')
    expect(st.href).toBe('https://www.torn.com/page.php?sid=attack&user2ID=90200')
    expect(st.title).toContain('Smoke')
    expect(st.title).toContain('Scout')
  })

  it('reads "you" when the current user is the requester', () => {
    const { S } = loadScript()
    const st = S.badgeState(null, { kind: 'help', by: ME, name: 'You', at: new Date().toISOString() }, 5, ME)
    expect(st.mine).toBe(true)
    expect(st.title).toContain('you')
  })

  it('reverts to the normal dibs control once the assist clears', () => {
    const { S } = loadScript()
    const dib = { by: ME, name: 'Me' }
    const st = S.badgeState(dib, null, 1, ME)
    expect(st).toMatchObject({ mode: 'dibs', action: 'release', mine: true, href: null })
  })

  it('shows each kind with its own Lucide icon name — matching the dashboard, not an emoji', () => {
    const { S } = loadScript()
    const at = new Date().toISOString()
    expect(S.badgeState(null, { kind: 'smoke', by: 1, at }, 1, ME).icon).toBe('cloud-fog')
    expect(S.badgeState(null, { kind: 'tear', by: 1, at }, 1, ME).icon).toBe('droplet')
    expect(S.badgeState(null, { kind: 'help', by: 1, at }, 1, ME).icon).toBe('life-buoy')
  })
})

describe('assistIconSvg (#523 icon pass) — inlines the same Lucide paths the dashboard renders as components', () => {
  it('returns a real <svg> for each known assist icon', () => {
    const { S } = loadScript()
    for (const key of ['cloud-fog', 'droplet', 'life-buoy']) {
      const svg = S.assistIconSvg(key)
      expect(svg).toContain('<svg')
      expect(svg).toContain('viewBox="0 0 24 24"')
      expect(svg).toContain('stroke="currentColor"')
    }
  })

  it('⚠️ is empty for an unknown key, never a raw [object Object] or a thrown error', () => {
    const { S } = loadScript()
    expect(S.assistIconSvg('not-a-real-icon')).toBe('')
  })

  it('draws a different path per icon — they must not silently collapse to the same glyph', () => {
    const { S } = loadScript()
    const svgs = ['cloud-fog', 'droplet', 'life-buoy'].map((k) => S.assistIconSvg(k))
    expect(new Set(svgs).size).toBe(3)
  })
})

describe('paintDibs renders a real icon for an active assist, not the old emoji text', () => {
  const fakeBadge = () => {
    const toggled = []
    return {
      textContent: '', innerHTML: '', title: '',
      classList: {
        toggle: (cls, on) => toggled.push([cls, on]),
        remove: () => {},
      },
      _toggled: toggled,
    }
  }

  it('sets innerHTML to a real <svg>, leaving textContent untouched, for a known icon', () => {
    const { S } = loadScript()
    const badge = fakeBadge()
    S.paintDibs(badge, { mode: 'assist', icon: 'cloud-fog', label: 'Smoke', title: 'Smoke requested by you · just now' })
    expect(badge.innerHTML).toContain('<svg')
    expect(badge.textContent).toBe('')
    expect(badge.title).toBe('Smoke requested by you · just now')
  })

  it('⚠️ falls back to the label text for an unrecognised icon key rather than leaving the badge blank', () => {
    const { S } = loadScript()
    const badge = fakeBadge()
    S.paintDibs(badge, { mode: 'assist', icon: 'not-a-real-icon', label: 'Assist', title: 't' })
    expect(badge.innerHTML).toBe('')
    expect(badge.textContent).toBe('Assist')
  })

  it('dibs mode is untouched — plain text, no innerHTML written', () => {
    const { S } = loadScript()
    const badge = fakeBadge()
    S.paintDibs(badge, { mode: 'dibs', label: 'Dibs', action: 'claim', mine: false, taken: false })
    expect(badge.textContent).toBe('Dibs')
    expect(badge.innerHTML).toBe('')
  })
})

describe('paintSignature carries the assist mode/title', () => {
  it('changes when mode flips from dibs to assist even if label/action/mine/taken happen to coincide', () => {
    const { S } = loadScript()
    const stats = { total: 5e6, str: 1e6, def: 1e6, spd: 1e6, dex: 2e6, source: 'torn', spiedAt: '2026-08-19' }
    const dibsState = { mode: 'dibs', label: 'X', action: null, mine: false, taken: true }
    const assistState = { mode: 'assist', label: 'X', action: null, mine: false, taken: true, title: 'Smoke requested by Scout · just now' }
    expect(S.paintSignature(dibsState, stats, '11', 4e6)).not.toBe(S.paintSignature(assistState, stats, '11', 4e6))
  })
})

describe('requestAssist / clearAssist', () => {
  const session = { host: 'forge.monchoon.me', token: 'jwt', userId: '2250591', factionId: '10739' }

  it('⚠️ shows the request as active the moment the POST succeeds (same optimistic-paint contract as claim)', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/assist': { status: 200, body: {} } } })
    S.setSession({ ...session })

    const res = await S.requestAssist(90200, 'smoke')

    expect(res.ok).toBe(true)
    const entry = S.assistsIndex().get(90200)
    expect(entry).toMatchObject({ kind: 'smoke', by: session.userId })
  })

  it('mirrors the one-live-assist-per-requester rule locally, so a switch does not show two', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/assist': { status: 200, body: {} } } })
    S.setSession({ ...session })

    await S.requestAssist(111, 'smoke')
    await S.requestAssist(222, 'help')

    expect(S.assistsIndex().has(111)).toBe(false)
    expect(S.assistsIndex().get(222)).toMatchObject({ kind: 'help' })
  })

  it('paints nothing when the server refuses the request', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/assist': { status: 500, body: { error: 'boom' } } } })
    S.setSession({ ...session })

    const res = await S.requestAssist(90200, 'help')

    expect(res.ok).toBe(false)
    expect(S.assistsIndex().has(90200)).toBe(false)
  })

  it('clears the local index the moment a release succeeds', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/assist/': { status: 200, body: {} } } })
    S.setSession({ ...session })
    S.indexAssists([{ target_id: 90200, requester_id: 2250591, requester_name: 'You', kind: 'smoke', created_at: new Date().toISOString() }], S.assistsIndex())

    const res = await S.clearAssist(90200)

    expect(res.ok).toBe(true)
    expect(S.assistsIndex().has(90200)).toBe(false)
  })

  it('leaves a failed clear alone rather than dropping the badge', async () => {
    const { S } = loadScript({ routes: { '/api/war-room/assist/': { status: 500, body: {} } } })
    S.setSession({ ...session })
    S.indexAssists([{ target_id: 90200, requester_id: 2250591, requester_name: 'You', kind: 'smoke', created_at: new Date().toISOString() }], S.assistsIndex())

    const res = await S.clearAssist(90200)

    expect(res.ok).toBe(false)
    expect(S.assistsIndex().has(90200)).toBe(true)
  })
})
