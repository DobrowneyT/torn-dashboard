// Feedback → GitHub issue (#253), at the black-box HTTP seam. The GitHub API is
// the harness's second fake (stack.github captures created issues).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, TEST_FACTION, type TestStack } from './harness.js'
import { APP_VERSION } from '../src/version.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

/** Log a faction member in and return their session token. */
async function loginMember(id: string, name: string, key: string): Promise<string> {
  stack.torn.addKey(key, { id, factionId: TEST_FACTION.tornFactionId })
  await stack.db.query(
    `INSERT INTO members (member_id, member_name, is_current) VALUES ($1, $2, true)
     ON CONFLICT (member_id) DO UPDATE SET member_name = EXCLUDED.member_name`,
    [id, name]
  )
  const res = await fetch(`${stack.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  const body = (await res.json()) as { token: string }
  return body.token
}

async function submit(token: string | null, payload: unknown) {
  const res = await fetch(`${stack.baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe('POST /api/feedback', () => {
  it('files a triaged GitHub issue stamped with the submitter and tenant', async () => {
    const token = await loginMember('4001', 'Reporter', 'FEEDBACKKEY40001')
    const before = stack.github.issuesCreated().length

    const { status, body } = await submit(token, {
      category: 'bug', title: 'War score not updating', description: 'The live score is stuck.',
    })
    expect(status).toBe(200)
    expect(body.url).toContain('/issues/')
    expect(typeof body.number).toBe('number')

    const created = stack.github.issuesCreated()
    expect(created).toHaveLength(before + 1)
    const issue = created[created.length - 1]
    expect(issue.repo).toBe('test-owner/test-repo')
    expect(issue.title).toBe('[Bug] War score not updating')
    expect(issue.labels).toEqual(['needs-triage'])
    expect(issue.auth).toBe('Bearer gh-test-token')
    // Body carries category, description, submitter identity, and tenant slug.
    expect(issue.body).toContain('**Category:** Bug')
    expect(issue.body).toContain('Reporter [4001]')
    expect(issue.body).toContain(`**Faction:** ${TEST_FACTION.slug}`)
    expect(issue.body).toContain('The live score is stuck.')
  })

  it('takes the submitter from the session, ignoring a spoofed id in the body', async () => {
    const token = await loginMember('4002', 'RealMember', 'FEEDBACKKEY40002')
    await submit(token, {
      category: 'suggestion', title: 'Nicer charts',
      // Spoof attempt: none of these should influence the recorded submitter.
      submitter_id: '999999', submitter_name: 'Impersonator', torn_user_id: '999999',
    })
    const issue = stack.github.issuesCreated().at(-1)!
    expect(issue.title).toBe('[Suggestion] Nicer charts')
    expect(issue.body).toContain('RealMember [4002]')
    expect(issue.body).not.toContain('999999')
    expect(issue.body).not.toContain('Impersonator')
  })

  it('rejects read-only visitors with 403 and files nothing', async () => {
    stack.torn.addKey('VISITORFEEDBACK01', { id: '4003', factionId: '42' })
    await stack.db.query(`INSERT INTO role_assignments (torn_user_id, role) VALUES (4003, 'visitor')`)
    const loginRes = await fetch(`${stack.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'VISITORFEEDBACK01' }),
    })
    const { token } = (await loginRes.json()) as { token: string }
    const before = stack.github.issuesCreated().length

    const { status } = await submit(token, { category: 'bug', title: 'x', description: 'y' })
    expect(status).toBe(403)
    expect(stack.github.issuesCreated()).toHaveLength(before)
  })

  it('rejects an unauthenticated request (401)', async () => {
    const { status } = await submit(null, { category: 'bug', title: 'x' })
    expect(status).toBe(401)
  })

  it('validates category and title', async () => {
    const token = await loginMember('4004', 'Validator', 'FEEDBACKKEY40004')
    expect((await submit(token, { category: 'praise', title: 'x' })).status).toBe(400)
    expect((await submit(token, { category: 'bug', title: '   ' })).status).toBe(400)
  })

  it('rate-limits rapid repeat submissions from one member (429)', async () => {
    const token = await loginMember('4005', 'Spammer', 'FEEDBACKKEY40005')
    // Five succeed within the window, the sixth is throttled.
    for (let i = 0; i < 5; i++) {
      const { status } = await submit(token, { category: 'bug', title: `spam ${i}` })
      expect(status).toBe(200)
    }
    const { status } = await submit(token, { category: 'bug', title: 'one too many' })
    expect(status).toBe(429)
  })
})

describe('POST /api/feedback attachments (#254)', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==' // arbitrary bytes tagged image/png
  const MP4_B64 = 'AAAAIGZ0eXBpc29t'          // arbitrary bytes tagged video/mp4

  it('stores files, embeds them in the issue (image inline, video as link), and serves them back', async () => {
    const token = await loginMember('4200', 'Attacher', 'FEEDBACKKEY42000')
    const { status, body } = await submit(token, {
      category: 'bug', title: 'Screenshot attached', description: 'see below',
      attachments: [
        { content_type: 'image/png', data_base64: PNG_B64, filename: 'shot.png' },
        { content_type: 'video/mp4', data_base64: MP4_B64, filename: 'clip.mp4' },
      ],
    })
    expect(status).toBe(200)

    // Two rows recorded against the issue number.
    const rows = await stack.db.query(
      'SELECT id, content_type FROM feedback_attachments WHERE issue_number = $1 ORDER BY content_type',
      [body.number]
    )
    expect(rows.rows).toHaveLength(2)

    // Issue body embeds the image inline and the video as a plain link.
    const issue = stack.github.issuesCreated().at(-1)!
    const imageRow = rows.rows.find((r) => r.content_type === 'image/png')!
    const videoRow = rows.rows.find((r) => r.content_type === 'video/mp4')!
    expect(issue.body).toContain(`![shot.png](`)
    expect(issue.body).toContain(`/api/feedback/attachments/${imageRow.id}`)
    expect(issue.body).toContain(`[clip.mp4](`)
    expect(issue.body).not.toContain(`![clip.mp4]`) // video is a link, not an inline image

    // The stored image round-trips through the public serve endpoint.
    const served = await fetch(`${stack.baseUrl}/api/feedback/attachments/${imageRow.id}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    const servedBytes = Buffer.from(await served.arrayBuffer())
    expect(servedBytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
    void videoRow
  })

  it('rejects an unsupported file type (400) and files nothing', async () => {
    const token = await loginMember('4201', 'BadType', 'FEEDBACKKEY42001')
    const { status } = await submit(token, {
      category: 'bug', title: 'x',
      attachments: [{ content_type: 'application/pdf', data_base64: PNG_B64 }],
    })
    expect(status).toBe(400)
  })

  it('rejects an oversized file (>10 MB) with 413', async () => {
    const token = await loginMember('4202', 'TooBig', 'FEEDBACKKEY42002')
    const big = Buffer.alloc(10 * 1024 * 1024 + 16).toString('base64')
    const { status } = await submit(token, {
      category: 'bug', title: 'x', attachments: [{ content_type: 'image/png', data_base64: big }],
    })
    expect(status).toBe(413)
  })

  it('rejects more than five files (400)', async () => {
    const token = await loginMember('4203', 'TooMany', 'FEEDBACKKEY42003')
    const files = Array.from({ length: 6 }, () => ({ content_type: 'image/png', data_base64: PNG_B64 }))
    const { status } = await submit(token, { category: 'bug', title: 'x', attachments: files })
    expect(status).toBe(400)
  })

  it('serves 404 for an unknown attachment id', async () => {
    const res = await fetch(`${stack.baseUrl}/api/feedback/attachments/00000000-0000-0000-0000-000000000000`)
    expect(res.status).toBe(404)
  })
})

describe('the reporter\'s app version (#402)', () => {
  // The point of stamping this is the SKEW. The server's own version is the
  // deployed one; the reporter's is whatever their tab loaded, possibly weeks
  // ago. Stamping only the server's would report the fixed version while the
  // reporter sits on the broken one — worse than stamping nothing.
  // A fresh reporter per submission: feedback is rate-limited to 5/hour per
  // user (RATE_LIMIT), and a block of version cases would otherwise trip it and
  // fail for a reason that has nothing to do with versions.
  let next = 4300
  async function freshToken(): Promise<string> {
    const id = String(next++)
    return loginMember(id, `Versioned${id}`, `FEEDBACKKEY${id}0`)
  }

  const lastBody = () => stack.github.issuesCreated().at(-1)!.body

  it('records both versions and flags the mismatch', async () => {
    await submit(await freshToken(), { category: 'bug', title: 'Stale tab', app_version: '3.0.0-old' })
    const body = lastBody()
    expect(body).toContain('3.0.0-old')
    expect(body).toContain(APP_VERSION)
    expect(body).toMatch(/does not match/i)
  })

  it('says nothing about a mismatch when the reporter is current', async () => {
    await submit(await freshToken(), { category: 'bug', title: 'Current tab', app_version: APP_VERSION })
    const body = lastBody()
    expect(body).toContain(`**App version:** ${APP_VERSION}`)
    expect(body).not.toMatch(/does not match/i)
  })

  it('reads "unknown" when the client sends nothing', async () => {
    // An old cached bundle predating this change sends no version at all, so
    // this is a normal state and must not look like an error.
    await submit(await freshToken(), { category: 'bug', title: 'No version' })
    expect(lastBody()).toContain('**App version:** unknown')
  })

  it('refuses a version that could inject markup into the issue', async () => {
    // Untrusted input landing in a markdown document. Asserted on the RENDERED
    // BODY rather than on a validator, so this still fails if someone later
    // wires the raw value through a second path.
    const nasty = '3.1`</b>[x](javascript:0)'
    await submit(await freshToken(), { category: 'bug', title: 'Injection', app_version: nasty })
    const body = lastBody()
    expect(body).not.toContain('javascript:0')
    expect(body).not.toContain('</b>')
    expect(body).toContain('**App version:** unknown')
  })

  it('refuses an over-long version and a non-string one', async () => {
    for (const bad of ['9'.repeat(33), { toString: () => '3.19.1' }, 42, null]) {
      await submit(await freshToken(), { category: 'bug', title: 'Bad version', app_version: bad })
      expect(lastBody()).toContain('**App version:** unknown')
    }
  })

  it('still files the report when the version is rubbish', async () => {
    // Diagnostic metadata must never be able to block a bug report.
    const { status } = await submit(await freshToken(), { category: 'bug', title: 'Files anyway', app_version: '!!!' })
    expect(status).toBe(200)
  })
})

describe('POST /api/feedback when no PAT is configured', () => {
  it('is disabled (501) and reports feedback_enabled=false in bootstrap', async () => {
    // Boots a second embedded-Postgres stack — give it room under full-suite load.
    const off = await startTestStack(undefined, { enabled: false })
    try {
      const boot = await (await fetch(`${off.baseUrl}/api/bootstrap`)).json() as any
      expect(boot.feedback_enabled).toBe(false)

      off.torn.addKey('NOFEEDBACKTOKEN01', { id: '4100', factionId: TEST_FACTION.tornFactionId })
      await off.db.query(`INSERT INTO members (member_id, member_name, is_current) VALUES ('4100', 'X', true)`)
      const loginRes = await fetch(`${off.baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'NOFEEDBACKTOKEN01' }),
      })
      const { token } = (await loginRes.json()) as { token: string }
      const res = await fetch(`${off.baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ category: 'bug', title: 'x', description: 'y' }),
      })
      expect(res.status).toBe(501)
    } finally {
      await off.close()
    }
  }, 60000)
})
