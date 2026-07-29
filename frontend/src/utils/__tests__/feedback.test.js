import { describe, it, expect } from 'vitest'
import { buildFeedbackPayload, FEEDBACK_TITLE_MAX } from '../feedback.js'

describe('buildFeedbackPayload (#253)', () => {
  it('assembles a trimmed payload for a valid bug report', () => {
    expect(buildFeedbackPayload({ category: 'bug', title: '  Score stuck  ', description: '  details \n' }))
      .toEqual({ ok: true, payload: { category: 'bug', title: 'Score stuck', description: 'details' } })
  })

  it('accepts a suggestion with an empty description', () => {
    const r = buildFeedbackPayload({ category: 'suggestion', title: 'Nicer charts' })
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ category: 'suggestion', title: 'Nicer charts', description: '' })
  })

  it('requires a valid category', () => {
    expect(buildFeedbackPayload({ category: 'praise', title: 'x' }).ok).toBe(false)
    expect(buildFeedbackPayload({ title: 'x' }).ok).toBe(false)
  })

  it('requires a non-empty title', () => {
    expect(buildFeedbackPayload({ category: 'bug', title: '   ' }).ok).toBe(false)
  })

  it('rejects an over-long title', () => {
    const r = buildFeedbackPayload({ category: 'bug', title: 'x'.repeat(FEEDBACK_TITLE_MAX + 1) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/too long/i)
  })
})
