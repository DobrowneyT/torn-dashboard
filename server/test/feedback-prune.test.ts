// Feedback attachment prune (#255): delete attachments once their linked GitHub
// issue is closed, with a TTL fallback. Job seam against the templated Postgres
// + the GitHub fixture (issue-state stub).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestStack, type TestStack } from './harness.js'
import { pruneFeedbackAttachments } from '../src/feedback.js'

let stack: TestStack

beforeAll(async () => {
  stack = await startTestStack()
}, 30000)

afterAll(async () => {
  await stack?.close()
})

async function seedAttachment(issueNumber: number, createdAt: string) {
  const res = await stack.db.query(
    `INSERT INTO feedback_attachments (issue_number, content_type, bytes, created_at)
     VALUES ($1, 'image/png', '\\x00'::bytea, $2) RETURNING id`,
    [issueNumber, createdAt]
  )
  return res.rows[0].id as string
}

describe('pruneFeedbackAttachments (#255)', () => {
  it('deletes closed and over-TTL attachments, keeps open recent ones, and survives API errors', async () => {
    const NOW = new Date('2026-07-29T00:00:00Z')
    const recent = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString()  // 3 days old
    const old = new Date(NOW.getTime() - 120 * 24 * 3600 * 1000).toISOString()   // 120 days old

    // Closed issue → pruned. Open recent → kept. Over-TTL (open) → pruned by TTL.
    // Errored issue → kept, counted as an error (resilience).
    const closedId = await seedAttachment(9101, recent)
    const openId = await seedAttachment(9102, recent)
    const ttlId = await seedAttachment(9103, old)
    const errorId = await seedAttachment(9104, recent)

    stack.github.setIssueState(9101, 'closed')
    stack.github.setIssueState(9102, 'open')
    stack.github.setIssueState(9103, 'open') // still open, but past the TTL
    stack.github.setIssueState(9104, 'error')

    const result = await pruneFeedbackAttachments({
      db: stack.db,
      githubToken: 'gh-test-token',
      githubRepo: 'test-owner/test-repo',
      githubBaseUrl: stack.github.baseUrl,
      ttlDays: 90,
      now: () => NOW,
    })

    expect(result.ttlDeleted).toBe(1)               // the 120-day-old one
    expect(result.closedIssuesPruned).toBe(1)       // issue 9101
    expect(result.closedAttachmentsDeleted).toBe(1)
    expect(result.errors).toBe(1)                   // issue 9104 fetch 500'd

    const remaining = await stack.db.query(
      'SELECT id FROM feedback_attachments WHERE id = ANY($1)',
      [[closedId, openId, ttlId, errorId]]
    )
    const ids = remaining.rows.map((r) => r.id)
    expect(ids).toContain(openId)   // open + recent kept
    expect(ids).toContain(errorId)  // errored issue's files kept
    expect(ids).not.toContain(closedId)
    expect(ids).not.toContain(ttlId)
  })
})
