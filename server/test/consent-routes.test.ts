// Consent at the HTTP seam, and the key pool underneath it (#894).
//
// ⚠️ The single most important assertion in this file is that a member whose
// consent is STALE still gets claimed for ordinary work. The naive version of
// this feature stops every scraper for them until they log in again, which
// would make the faction's data collection hostage to whoever is on holiday.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { createKeyPool } from '../src/scraper/keyPool.js'
import { PURPOSE_VERSIONS, CURRENT_DISCLOSURE_VERSION } from '../src/consent.js'

let stack: TestStack
let token: string

async function loginAs(key: string, id: string) {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as any).token as string
}

const call = async (method: string, path: string, tok?: string) => {
  const res = await fetch(`${stack.baseUrl}${path}`, {
    method, headers: tok ? { authorization: `Bearer ${tok}` } : {},
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  stack = await startTestStack()
  token = await loginAs('CONSENTMEMBER1XX', '9100')
})
afterAll(async () => { await stack?.close() })

describe('GET /api/health', () => {
  it('reports the current disclosure version', async () => {
    const r = await call('GET', '/api/health')
    expect(r.body.consent_version).toBe(CURRENT_DISCLOSURE_VERSION)
  })

  it('⚠️ keeps the app build and the disclosure as SEPARATE fields', async () => {
    // Shipping a release must not re-prompt anybody, and bumping the
    // disclosure must not force a reload. One field could not express both.
    const r = await call('GET', '/api/health')
    expect(r.body.version).toBeTruthy()
    expect(r.body.consent_version).toBeTruthy()
    expect(r.body.version).not.toBe(r.body.consent_version)
  })

  it('still needs no session, which is why the poller can use it', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200)
  })
})

describe('bootstrap', () => {
  it('reports what the member accepted, not merely whether', async () => {
    const r = await call('GET', '/api/bootstrap', token)
    expect(r.body.user.consent_version).toBe('login-v1')
  })

  it('⚠️ does not prompt anybody on the version everyone already has', async () => {
    // Shipping this mechanism must be invisible until a disclosure changes.
    const r = await call('GET', '/api/bootstrap', token)
    expect(r.body.user.consent_required).toBe(false)
  })

  it('⚠️ prompts a member whose stored version cannot be placed', async () => {
    await stack.db.query(
      `UPDATE member_secrets SET consent_version = 'rolled-back-v9' WHERE member_id = '9100'`
    )
    const r = await call('GET', '/api/bootstrap', token)
    expect(r.body.user.consent_required).toBe(true)
    expect(r.body.user.consent_version).toBe('rolled-back-v9')
  })
})

describe('POST /api/auth/consent', () => {
  it('records acceptance of the current version and clears the prompt', async () => {
    const r = await call('POST', '/api/auth/consent', token)
    expect(r.status).toBe(200)
    expect(r.body.consent_version).toBe(CURRENT_DISCLOSURE_VERSION)
    expect((await call('GET', '/api/bootstrap', token)).body.user.consent_required).toBe(false)
  })

  it('⚠️ takes no version from the client', async () => {
    // A stale tab could otherwise accept a disclosure that has since been
    // replaced, recording agreement to wording nobody showed that member.
    const res = await fetch(`${stack.baseUrl}/api/auth/consent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ consent_version: 'something-i-made-up' }),
    })
    expect(res.status).toBe(200)
    const row = await stack.db.query(
      `SELECT consent_version FROM member_secrets WHERE member_id = '9100'`
    )
    expect(row.rows[0].consent_version).toBe(CURRENT_DISCLOSURE_VERSION)
  })

  it('refuses a session with no key enrolled', async () => {
    await stack.db.query(`DELETE FROM member_secrets WHERE member_id = '9200'`)
    const other = await loginAs('CONSENTNOKEY1XXX', '9200')
    await stack.db.query(`DELETE FROM member_secrets WHERE member_id = '9200'`)
    // Consent without a key is a record of agreeing to nothing.
    expect((await call('POST', '/api/auth/consent', other)).status).toBe(404)
  })

  it('rejects an anonymous caller', async () => {
    expect((await call('POST', '/api/auth/consent')).status).toBe(401)
  })
})

describe('⚠️ the key pool when consent is stale', () => {
  const pool = () => createKeyPool({ db: stack.db as any, encryptionKey: 'e'.repeat(64) })

  beforeAll(async () => {
    await stack.db.query(
      `UPDATE member_secrets SET consent_version = 'rolled-back-v9' WHERE member_id = '9100'`
    )
  })

  it('⚠️ STILL claims the key for ordinary work', async () => {
    // The assertion this whole design exists for. A member who has not
    // re-accepted has still accepted everything the old disclosure covered,
    // and their scrapers must keep running.
    const claimed = await pool().claim()
    expect(claimed).not.toBeNull()
    expect(claimed!.member_id).toBe('9100')
  })

  it('⚠️ refuses the key for a purpose their version does not cover', async () => {
    PURPOSE_VERSIONS['future-purpose'] = 'login-v1'
    try {
      const claimed = await pool().claim({ purpose: 'future-purpose' })
      expect(claimed).toBeNull()
    } finally {
      delete PURPOSE_VERSIONS['future-purpose']
    }
  })

  it('claims it again for that purpose once they accept', async () => {
    await stack.db.query(
      `UPDATE member_secrets SET consent_version = 'login-v1' WHERE member_id = '9100'`
    )
    PURPOSE_VERSIONS['future-purpose'] = 'login-v1'
    try {
      const claimed = await pool().claim({ purpose: 'future-purpose' })
      expect(claimed?.member_id).toBe('9100')
    } finally {
      delete PURPOSE_VERSIONS['future-purpose']
    }
  })

  it('⚠️ an unsatisfiable purpose claims NOTHING rather than falling through', async () => {
    PURPOSE_VERSIONS['impossible'] = 'no-such-version'
    try {
      expect(await pool().claim({ purpose: 'impossible' })).toBeNull()
    } finally {
      delete PURPOSE_VERSIONS['impossible']
    }
  })
})
