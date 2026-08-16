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

function loadScript() {
  const mod = { exports: {} }
  // `window`/`document` deliberately undefined: proves the guard holds, and
  // means a future edit that runs DOM work at load time fails here rather than
  // in someone's browser.
  new Function('module', 'window', 'document', 'GM_getValue', 'GM_setValue', source)(
    mod, undefined, undefined, () => 'null', () => {}
  )
  return mod.exports
}

const S = loadScript()

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
