import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The split lives in ONE place (#payoutShare).
 *
 * ⚠️ Why this is a lint and not a code review: the OC split existed in four
 * copies, three of them in a single component, and they disagreed about which
 * time field counts, whether eligibility counts, and whether equal mode exists
 * at all. Every disagreement rendered a sheet of plausible numbers — no crash,
 * no failing test, nothing to notice — and the one the user actually saw was
 * the LAST copy to run, which was also the only one nobody had tested. A fifth
 * copy would be just as quiet, so the only reliable moment to catch it is the
 * moment somebody writes `sharePercent =` somewhere new.
 */

// ⚠️ Resolved off `import.meta.url`, not the cwd. Tests run per workspace
// (`npm run test:run --workspaces`), so a path relative to the repo root finds
// nothing and the guard passes by scanning zero files.
const SRC = new URL('../../', import.meta.url).pathname
const SOURCE_OF_TRUTH = join(SRC, 'utils/payoutCalculations.js')

// Chain Watch is deliberately NOT part of this: it is a flat rate per slot
// with no denominator and no redistribution, so it has no share to compute.
const ASSIGNS_A_SHARE = /\bsharePercent\s*[=:]/

// ⚠️ Reading the share back off a SAVED row is not deriving it. The restore
// path converts the persisted `share_percent` percentage into a fraction, and
// that is the one legitimate assignment outside payoutCalculations — it copies
// a decision made weeks ago rather than making one.
const READS_THE_SAVED_COLUMN = /share_percent/

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(jsx?|tsx?)$/.test(name) && !/__tests__/.test(full)) out.push(full)
  }
  return out
}

describe('the payout split has one source of truth', () => {
  it('no file outside payoutCalculations.js computes sharePercent', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      if (file === SOURCE_OF_TRUTH) continue
      const src = readFileSync(file, 'utf8')
      // Strip comments first — the warnings above talk ABOUT sharePercent.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const line of code.split('\n')) {
        if (ASSIGNS_A_SHARE.test(line) && !READS_THE_SAVED_COLUMN.test(line)) {
          offenders.push(`${file} — derives sharePercent (${line.trim()}); call payoutShare() instead`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('payoutShare is the only place that divides by the ticket denominator', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      if (file === SOURCE_OF_TRUTH) continue
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (/\/\s*totalAdjustedTickets/.test(code)) {
        offenders.push(`${file} — re-derives a ticket share; call payoutShare() instead`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the guard itself', () => {
  it('actually scans files — a zero-file sweep would pass silently', () => {
    // ⚠️ The failure mode of a filesystem lint is finding nothing and
    // reporting success. Pin a floor so a bad root cannot fake a pass.
    expect(walk(SRC).length).toBeGreaterThan(50)
  })
})
