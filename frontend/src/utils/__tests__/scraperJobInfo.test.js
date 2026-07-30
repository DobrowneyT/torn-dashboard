import { describe, it, expect } from 'vitest'
import { SCRAPER_JOB_INFO, scraperJobSummary } from '../scraperJobInfo.js'

describe('scraperJobSummary', () => {
  it('returns the specific summary for a known job', () => {
    expect(scraperJobSummary('inventory-sync')).toBe(SCRAPER_JOB_INFO['inventory-sync'])
    expect(scraperJobSummary('inventory-sync')).toMatch(/armory/i)
    expect(scraperJobSummary('members-sync')).toMatch(/roster/i)
  })

  it('mentions API call footprint in every summary', () => {
    for (const summary of Object.values(SCRAPER_JOB_INFO)) {
      expect(summary).toMatch(/\bcalls?\b/i)
    }
  })

  it('falls back to a generic message for an unknown job', () => {
    const fallback = scraperJobSummary('some-future-job')
    expect(fallback).toMatch(/not available/i)
    expect(fallback).not.toBe('')
  })
})
