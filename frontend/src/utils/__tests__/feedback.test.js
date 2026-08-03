import { describe, it, expect } from 'vitest'
import {
  buildFeedbackPayload,
  FEEDBACK_TITLE_MAX,
  validateFeedbackFiles,
  FEEDBACK_MAX_FILE_BYTES,
} from '../feedback.js'

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

describe('validateFeedbackFiles (#254)', () => {
  const img = { name: 'a.png', type: 'image/png', size: 1000 }
  const vid = { name: 'a.mp4', type: 'video/mp4', size: 2000 }

  it('accepts images and video within limits', () => {
    expect(validateFeedbackFiles([img, vid])).toEqual({ ok: true })
    expect(validateFeedbackFiles([])).toEqual({ ok: true })
  })

  it('rejects more than five files', () => {
    expect(validateFeedbackFiles(Array(6).fill(img)).ok).toBe(false)
  })

  it('rejects an unsupported type', () => {
    expect(validateFeedbackFiles([{ name: 'x.pdf', type: 'application/pdf', size: 10 }]).ok).toBe(false)
  })

  it('rejects a file over 10 MB', () => {
    expect(validateFeedbackFiles([{ name: 'big.png', type: 'image/png', size: FEEDBACK_MAX_FILE_BYTES + 1 }]).ok).toBe(false)
  })
})
