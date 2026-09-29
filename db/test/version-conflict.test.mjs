// Resolving the one merge conflict this repo produces on purpose.
//
// ⚠️ Every PR bumps VERSION + four package.json + a dated CHANGELOG heading, so
// main's version strictly increases on every merge. Two PRs cut from the same
// base therefore always collide on exactly those six files. The convention is
// worth keeping; the collision is mechanical, so it gets resolved mechanically.
import { describe, expect, it } from 'vitest'
import { compareVersions, resolveVersionFile, resolveChangelog, parseConflicts }
  from '../../scripts/versionConflict.mjs'

const conflict = (ours, theirs) =>
  `<<<<<<< HEAD\n${ours}\n=======\n${theirs}\n>>>>>>> incoming\n`

describe('compareVersions', () => {
  it('orders by each component numerically', () => {
    expect(compareVersions('3.149.0', '3.148.0')).toBeGreaterThan(0)
    expect(compareVersions('3.9.0', '3.10.0')).toBeLessThan(0)   // not string order
    expect(compareVersions('3.148.2', '3.148.10')).toBeLessThan(0)
    expect(compareVersions('3.149.0', '3.149.0')).toBe(0)
  })

  it('refuses anything that is not X.Y.Z', () => {
    // ⚠️ Throwing beats guessing: a silent fallback here would resolve a
    // version file to something plausible and wrong.
    expect(() => compareVersions('3.149', '3.148.0')).toThrow()
    expect(() => compareVersions('v3.149.0', '3.148.0')).toThrow()
  })
})

describe('VERSION', () => {
  it('⚠️ takes the HIGHER side, never simply "theirs"', () => {
    // During a rebase "ours" is the branch being replayed ONTO, so blindly
    // taking one side can move the version BACKWARDS — the exact thing the
    // bump-every-PR convention exists to prevent.
    expect(resolveVersionFile(conflict('3.148.0', '3.149.0')).trim()).toBe('3.149.0')
    expect(resolveVersionFile(conflict('3.149.0', '3.148.0')).trim()).toBe('3.149.0')
  })

  it('leaves a clean file untouched', () => {
    expect(resolveVersionFile('3.149.0\n')).toBe('3.149.0\n')
  })
})

describe('CHANGELOG', () => {
  const ours = '## [3.148.0] - 2026-09-28\n\n### Fixed\n- older thing'
  const theirs = '## [3.149.0] - 2026-09-29\n\n### Added\n- newer thing'

  it('⚠️ keeps BOTH entries, newest first', () => {
    // Never drops a side: each entry documents something that shipped, and a
    // resolution that quietly kept one would leave a released change with no
    // record — the opposite of what the file is for.
    const out = resolveChangelog(conflict(ours, theirs))
    expect(out).toContain('older thing')
    expect(out).toContain('newer thing')
    expect(out.indexOf('[3.149.0]')).toBeLessThan(out.indexOf('[3.148.0]'))
  })

  it('orders by version even when git puts the newer one first', () => {
    const out = resolveChangelog(conflict(theirs, ours))
    expect(out.indexOf('[3.149.0]')).toBeLessThan(out.indexOf('[3.148.0]'))
  })

  it('⚠️ keeps both, unordered, when a side carries no version heading', () => {
    // Not the ordinary two-releases collision — so keep everything in the order
    // git presented rather than inventing a ranking from nothing.
    const out = resolveChangelog(conflict('- a stray edit', theirs))
    expect(out).toContain('a stray edit')
    expect(out).toContain('newer thing')
  })

  it('handles several conflict blocks in one file', () => {
    const text = conflict(ours, theirs) + 'unrelated\n' + conflict('## [3.1.0] - x\n- p', '## [3.2.0] - y\n- q')
    const out = resolveChangelog(text)
    for (const s of ['older thing', 'newer thing', '- p', '- q', 'unrelated']) {
      expect(out).toContain(s)
    }
  })
})

describe('parseConflicts', () => {
  it('returns null for a file with no markers', () => {
    expect(parseConflicts('nothing here\n')).toBeNull()
  })

  it('⚠️ throws on a truncated block rather than resolving it', () => {
    // A half-written conflict means the file is not what we think it is.
    expect(() => parseConflicts('<<<<<<< HEAD\nonly ours\n')).toThrow()
    expect(() => parseConflicts('<<<<<<< HEAD\na\n=======\nb\n')).toThrow()
  })
})
