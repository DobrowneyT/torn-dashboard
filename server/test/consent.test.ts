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

  it('⚠️ still contains login-v1, which is what enrolled keys stored before slice 0', () => {
    // Dropping it would make every un-re-consented key UNRECOGNISED rather
    // than merely out of date — and an unplaceable version is refused for
    // gated purposes, so they would silently lose more than they should.
    expect(DISCLOSURE_VERSIONS.map((v) => v.id)).toContain('login-v1')
  })

  it('⚠️ gates target lookups on the version that disclosed them', () => {
    // The Book of Grudges reads players outside the faction. A member who has
    // not accepted that row is skipped for those calls and nothing else.
    expect(PURPOSE_VERSIONS['target-lookup']).toBe('target-lookup-v1')
    expect(consentCovers('login-v1', 'target-lookup')).toBe(false)
    expect(consentCovers('target-lookup-v1', 'target-lookup')).toBe(true)
  })

  it('⚠️ an un-re-consented key still covers everything ungated', () => {
    // The assertion the whole purpose-scoped design exists for.
    expect(consentCovers('login-v1')).toBe(true)
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
  it('⚠️ is FALSE for login-v1, because the disclosure has since changed', () => {
    // This assertion was the opposite when #894 shipped, and the flip is the
    // point: #894 landed inert, and #889 slice 0 added the Target Lookups row,
    // which is what re-prompts the faction. If this ever reads true again with
    // a newer version in the list, the gate has stopped working.
    expect(consentIsCurrent('login-v1')).toBe(false)
  })

  it('is true for the newest version in the list', () => {
    expect(consentIsCurrent(CURRENT_DISCLOSURE_VERSION)).toBe(true)
  })

  it('is false for a member with no recorded consent', () => {
    expect(consentIsCurrent(null)).toBe(false)
    expect(consentIsCurrent('')).toBe(false)
  })

  it('⚠️ is false for a version it cannot place', () => {
    expect(consentIsCurrent('rolled-back-v9')).toBe(false)
  })
})

// #968 — the attack-log disclosure for Halloween (#967).
//
// ⚠️ The two halves of this change pull in opposite directions, and both are
// asserted: every member MUST be re-prompted (the page changed), and NO key
// may be gated (members had already consented and been told). A version that
// re-prompted and gated would silently drop the keys the event needs; one that
// gated without re-prompting would be worse still.
describe('attack-logs-v1 (#968)', () => {
  it('is superseded by attack-logs-v2, which dropped the call-rate promise', () => {
    expect(CURRENT_DISCLOSURE_VERSION).toBe('attack-logs-v2')
  })

  it('⚠️ re-prompts a member who accepted any earlier version', () => {
    // The page changed — including REMOVING a sentence — so the terms a
    // member agreed to no longer match it.
    expect(consentIsCurrent('target-lookup-v1')).toBe(false)
    expect(consentIsCurrent('attack-logs-v1')).toBe(false)
    expect(consentIsCurrent('attack-logs-v2')).toBe(true)
  })

  it('⚠️ is NOT a purpose gate — no key is skipped for attack logs', () => {
    // MonChoon confirmed consent with members already. A gate here would leave
    // the archive short of keys during the busiest event of the year, while
    // the re-prompts trickle in.
    expect(Object.values(PURPOSE_VERSIONS)).not.toContain('attack-logs-v1')
    expect(Object.values(PURPOSE_VERSIONS)).not.toContain('attack-logs-v2')
    for (const accepted of ['login-v1', 'target-lookup-v1', 'attack-logs-v1', 'attack-logs-v2']) {
      expect(consentCovers(accepted, 'attack-logs')).toBe(true)
      expect(consentCovers(accepted)).toBe(true)
    }
  })

  it('leaves the target-lookup gate exactly as it was', () => {
    expect(consentCovers('login-v1', 'target-lookup')).toBe(false)
    expect(consentCovers('target-lookup-v1', 'target-lookup')).toBe(true)
    // Newer still covers it — rank, not equality.
    expect(consentCovers('attack-logs-v1', 'target-lookup')).toBe(true)
  })
})

it('⚠️ the disclosure makes no call-rate promise (#968)', async () => {
  // MonChoon: "Lets not make any promises on the number of calls per minute".
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../frontend/src/components/ApiKeyDisclosure.jsx', import.meta.url), 'utf8')
  const attackRow = src.split('\n').find((l) => l.includes("['Attack Logs'")) ?? ''
  expect(attackRow).not.toBe('')
  expect(attackRow).not.toMatch(/per minute|a minute|times a minute/i)
})
