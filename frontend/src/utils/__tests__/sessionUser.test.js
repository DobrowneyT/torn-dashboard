import { describe, expect, it } from 'vitest'
import {
  buildUserFromBootstrap, sessionFieldsChanged, describeRoleDelta, SESSION_SYNC_FIELDS,
} from '../sessionUser'

const boot = (over = {}, userOver = {}) => ({
  feedback_enabled: true,
  ...over,
  user: {
    torn_user_id: '2250591',
    member_name: 'MonChoon',
    roles: [],
    api_key_hint: 'abcd',
    consent_version: 'login-v1',
    consent_required: false,
    ...userOver,
  },
})

describe('buildUserFromBootstrap', () => {
  it('maps each role onto the flag the UI gates on', () => {
    const u = buildUserFromBootstrap(boot({}, { roles: ['warlead', 'ocmanager'] }))
    expect(u).toMatchObject({
      isWarLead: true, isOCManager: true, isLeadership: false, isAdmin: false,
    })
  })

  it('falls back to an id-based name for somebody not on the roster', () => {
    const u = buildUserFromBootstrap(boot({}, { member_name: null }))
    expect(u.name).toBe('Player 2250591')
  })

  it('never carries key material', () => {
    // ⚠️ In API mode the browser holds only the session token; a raw key must
    // never reach localStorage, and this object IS what gets persisted.
    const u = buildUserFromBootstrap(boot())
    expect(u).not.toHaveProperty('apiKey')
    expect(u.apiKeyHint).toBe('abcd')
  })

  it('reads an absent role list as no roles rather than throwing', () => {
    const u = buildUserFromBootstrap(boot({}, { roles: undefined }))
    expect(u.isLeadership).toBe(false)
  })

  /**
   * ⚠️ The refresh path rebuilds this object every few hours. Stamping "now"
   * each time would silently redate a session nobody has logged into for a
   * week — and `lastLogin` is the only field that differs on every rebuild, so
   * it is also what would make a change-detector fire forever.
   */
  it('carries an existing lastLogin instead of restamping it', () => {
    const was = '2026-01-01T00:00:00.000Z'
    expect(buildUserFromBootstrap(boot(), { lastLogin: was }).lastLogin).toBe(was)
  })

  it('stamps lastLogin when there is none to carry', () => {
    expect(buildUserFromBootstrap(boot()).lastLogin).toBeTruthy()
  })

  it('titles the position by the highest role held', () => {
    expect(buildUserFromBootstrap(boot({}, { roles: ['admin'] })).factionPosition).toBe('Admin')
    expect(buildUserFromBootstrap(boot({}, { roles: ['leadership'] })).factionPosition).toBe('Leadership')
    expect(buildUserFromBootstrap(boot({}, { roles: ['warlead'] })).factionPosition).toBe('Member')
  })
})

describe('sessionFieldsChanged', () => {
  const base = buildUserFromBootstrap(boot(), { lastLogin: 'x' })

  it('sees a role being granted', () => {
    const fresh = buildUserFromBootstrap(boot({}, { roles: ['warlead'] }), { lastLogin: 'x' })
    expect(sessionFieldsChanged(base, fresh)).toBe(true)
  })

  /** ⚠️ The direction that matters more: controls must stop being offered. */
  it('sees a role being revoked', () => {
    const had = buildUserFromBootstrap(boot({}, { roles: ['warlead'] }), { lastLogin: 'x' })
    expect(sessionFieldsChanged(had, base)).toBe(true)
  })

  it('says nothing changed when nothing did', () => {
    const again = buildUserFromBootstrap(boot(), { lastLogin: 'x' })
    expect(sessionFieldsChanged(base, again)).toBe(false)
  })

  /**
   * ⚠️ THE case that would make this useless. `lastLogin` differs on every
   * rebuild, so counting it would report a change on every refresh and
   * re-render the whole app on a four-hour timer forever.
   */
  it('ignores lastLogin, which differs on every single rebuild', () => {
    const later = buildUserFromBootstrap(boot(), { lastLogin: '2030-01-01T00:00:00.000Z' })
    expect(sessionFieldsChanged(base, later)).toBe(false)
    expect(SESSION_SYNC_FIELDS).not.toContain('lastLogin')
  })

  /**
   * ⚠️ Same staleness bug as the roles, and it defeats a rule MonChoon set:
   * bumping the API Key Usage disclosure must force a re-acceptance, which a
   * member with a tab open would otherwise not see until their next login.
   */
  it('sees a consent re-prompt becoming required', () => {
    const fresh = buildUserFromBootstrap(boot({}, { consent_required: true }), { lastLogin: 'x' })
    expect(sessionFieldsChanged(base, fresh)).toBe(true)
  })

  it('sees the key hint change, so a re-enrolled key is not shown stale', () => {
    const fresh = buildUserFromBootstrap(boot({}, { api_key_hint: 'wxyz' }), { lastLogin: 'x' })
    expect(sessionFieldsChanged(base, fresh)).toBe(true)
  })

  it('reports no change rather than throwing when either side is missing', () => {
    expect(sessionFieldsChanged(null, base)).toBe(false)
    expect(sessionFieldsChanged(base, null)).toBe(false)
  })
})

describe('describeRoleDelta', () => {
  it('names what was gained and what was lost', () => {
    const before = buildUserFromBootstrap(boot({}, { roles: ['leadership'] }), { lastLogin: 'x' })
    const after = buildUserFromBootstrap(boot({}, { roles: ['warlead', 'admin'] }), { lastLogin: 'x' })
    const d = describeRoleDelta(before, after)
    expect(d.gained.sort()).toEqual(['admin', 'warlead'])
    expect(d.lost).toEqual(['leadership'])
  })

  it('is empty on both sides when the roles held steady', () => {
    const u = buildUserFromBootstrap(boot({}, { roles: ['warlead'] }), { lastLogin: 'x' })
    expect(describeRoleDelta(u, u)).toEqual({ gained: [], lost: [] })
  })

  it('handles a missing cached user', () => {
    const fresh = buildUserFromBootstrap(boot({}, { roles: ['warlead'] }), { lastLogin: 'x' })
    expect(describeRoleDelta(null, fresh)).toEqual({ gained: ['warlead'], lost: [] })
  })
})
