// API Key Usage consent versioning (#894).
//
// The theme: the mechanism this replaces did NOTHING, and the obvious
// replacement would halt the faction. So these tests are weighted at the two
// failure modes that matter — a gate that silently permits, and a gate that
// silently stops every scraper.
import { describe, expect, it } from 'vitest'
import {
  DISCLOSURE_VERSIONS, CURRENT_DISCLOSURE_VERSION, PURPOSE_VERSIONS,
  versionRank, consentCovers, consentIsCurrent,
} from '../src/consent.js'

describe('the version list', () => {
  it('is ordered oldest first, with the current version last', () => {
    expect(DISCLOSURE_VERSIONS.length).toBeGreaterThan(0)
    expect(CURRENT_DISCLOSURE_VERSION).toBe(
      DISCLOSURE_VERSIONS[DISCLOSURE_VERSIONS.length - 1].id
    )
  })

  it('⚠️ still contains login-v1, which is what every enrolled key stores today', () => {
    // Dropping it would mark the whole faction unrecognised at once.
    expect(DISCLOSURE_VERSIONS.map((v) => v.id)).toContain('login-v1')
  })

  it('⚠️ every entry carries a disclosure fingerprint', () => {
    // The fingerprint is what ties a version to the page it described, and
    // what makes editing the page without adding a version fail CI.
    for (const v of DISCLOSURE_VERSIONS) {
      expect(v.rowsHash, `${v.id} has no rowsHash`).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('⚠️ has no duplicate ids, because POSITION is the ordering', () => {
    const ids = DISCLOSURE_VERSIONS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('versionRank', () => {
  it('ranks by position, not by string comparison', () => {
    // ⚠️ The whole reason ranks exist: 'login-v1' < '2.0' is FALSE as strings,
    // so a lexical compare would invert the gate.
    expect('login-v1' < '2.0').toBe(false)
    expect(versionRank('login-v1')).toBe(0)
  })

  it('⚠️ returns null for a version it cannot place, not zero', () => {
    // Treating unknown as "oldest" would silently grant it everything the
    // first version covers.
    expect(versionRank('from-a-future-build')).toBeNull()
    expect(versionRank(null)).toBeNull()
    expect(versionRank('')).toBeNull()
    expect(versionRank(undefined)).toBeNull()
  })
})

describe('consentCovers', () => {
  it('⚠️ permits everything when no purpose is asked for', () => {
    // This is the baseline every existing scraper uses, and the reason a
    // re-prompt does not stop the faction's data collection.
    expect(consentCovers('login-v1')).toBe(true)
    expect(consentCovers(null)).toBe(true)
    expect(consentCovers('anything-at-all')).toBe(true)
  })

  it('permits an ungated purpose', () => {
    expect(consentCovers('login-v1', 'not-a-gated-purpose')).toBe(true)
  })

  it('⚠️ refuses a gated purpose whose required version is not in the list', () => {
    // That is a programming error. Quietly permitting it would be the worst
    // possible reading of a broken gate.
    const saved = PURPOSE_VERSIONS['broken']
    PURPOSE_VERSIONS['broken'] = 'no-such-version'
    try {
      expect(consentCovers('login-v1', 'broken')).toBe(false)
    } finally {
      if (saved === undefined) delete PURPOSE_VERSIONS['broken']
      else PURPOSE_VERSIONS['broken'] = saved
    }
  })

  it('⚠️ gates on rank once a purpose declares a required version', () => {
    // Simulates the next disclosure bump without shipping one.
    PURPOSE_VERSIONS['future'] = 'login-v1'
    try {
      expect(consentCovers('login-v1', 'future')).toBe(true)
      // An unplaceable accepted version cannot be shown to cover it.
      expect(consentCovers('mystery', 'future')).toBe(false)
      expect(consentCovers(null, 'future')).toBe(false)
    } finally {
      delete PURPOSE_VERSIONS['future']
    }
  })
})

describe('consentIsCurrent', () => {
  it('is true for the version everybody has stored right now', () => {
    // ⚠️ Nobody should be prompted by the mere existence of this mechanism.
    // Shipping #894 must be invisible until a disclosure actually changes.
    expect(consentIsCurrent('login-v1')).toBe(true)
  })

  it('is false for a member with no recorded consent', () => {
    expect(consentIsCurrent(null)).toBe(false)
    expect(consentIsCurrent('')).toBe(false)
  })

  it('⚠️ is false for a version it cannot place', () => {
    expect(consentIsCurrent('rolled-back-v9')).toBe(false)
  })
})
