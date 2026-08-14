import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRAPER_JOB_INFO, scraperJobSummary } from '../scraperJobInfo.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Job names as actually registered by the scraper, read from the source of truth. */
function registeredJobNames() {
  const src = readFileSync(
    join(here, '..', '..', '..', '..', 'server', 'src', 'scraper', 'registerJobs.ts'),
    'utf8'
  )
  return [...src.matchAll(/\['([a-z0-9-]+)',\s*'[^']+',/g)].map((m) => m[1])
}

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

  it('covers every job the scraper actually registers', () => {
    // ⚠️ The gap this was written for: `crime-occupancy` (#389) and
    // `oc-scenarios-mirror` (#390) were both registered without a summary, so
    // Global Admin showed them the "details are not available" fallback. That
    // is silent — the row renders perfectly, just uselessly — and it will
    // happen again on the next job unless something fails the build.
    const registered = registeredJobNames()
    expect(registered.length).toBeGreaterThan(10)
    const missing = registered.filter((name) => !(name in SCRAPER_JOB_INFO))
    expect(missing, `jobs registered with no summary: ${missing.join(', ')}`).toEqual([])
  })

  it('has no summary for a job that no longer exists', () => {
    // The other direction: a renamed or deleted job leaves dead help text that
    // describes behaviour the system no longer has.
    const registered = new Set(registeredJobNames())
    // revives-sync registers as `revives-sync` via revivesContinuousJob; any
    // other orphan is a genuine leftover.
    const orphans = Object.keys(SCRAPER_JOB_INFO).filter((name) => !registered.has(name))
    expect(orphans, `summaries with no registered job: ${orphans.join(', ')}`).toEqual([])
  })

  it('falls back to a generic message for an unknown job', () => {
    const fallback = scraperJobSummary('some-future-job')
    expect(fallback).toMatch(/not available/i)
    expect(fallback).not.toBe('')
  })
})
