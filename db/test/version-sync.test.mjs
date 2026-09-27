// VERSION and every package.json must agree.
//
// ⚠️ Duplicated on purpose: CI runs `scripts/check-version-sync.mjs` as a
// blocking step, and this runs the same assertion inside the normal test
// suite so `npm test` catches it locally, before a PR exists. The drift this
// exists for (PR #804) was found by hand during a rebase, which is not a
// control — it was invisible to every automated check the repo had.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSIONED } from '../../scripts/check-version-sync.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))

describe('version sync', () => {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()

  it('VERSION is a plain X.Y.Z', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it.each(VERSIONED)('%s matches VERSION', (rel) => {
    // ⚠️ VERSION feeds the footer (VITE_APP_VERSION at build) and /api/health
    // at runtime; the package files feed npm and the Docker builds. When they
    // disagree the dashboard reports a version that was never built.
    expect(read(rel).version).toBe(version)
  })

  it('covers every package.json in the repo', () => {
    // ⚠️ A fifth workspace added later must be added to VERSIONED, or it drifts
    // silently — exactly the failure mode this whole check exists for.
    expect(new Set(VERSIONED)).toEqual(new Set([
      'package.json', 'frontend/package.json', 'server/package.json', 'db/package.json',
    ]))
  })
})
