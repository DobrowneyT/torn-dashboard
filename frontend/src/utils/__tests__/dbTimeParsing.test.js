// Guard against the #140 trap coming back.
//
// Postgres serves timestamptz as text with a BARE two-digit offset
// ("2026-08-12T15:30:28.041124+00"), which is NOT valid ISO 8601. JS returns
// NaN on it — silently, which is what makes it dangerous:
//
//   • #330 travel ETAs never rendered a single estimate in production
//   • cooldowns stopped ageing and showed a frozen value as though live
//   • stats staleness never displayed
//   • the #385 concurrency harness had two checks that had quietly stopped
//     checking
//   • RW payout history rendered a literal "Invalid Date" for every row
//
// The scanner originally covered `Date.parse` only. That was half the trap:
// `new Date(str)` runs the SAME parser, and the codebase used it far more
// often. Five further live bugs were sitting in `new Date` call sites when
// this check was widened — including the RW payout history the scanner was
// widened in response to. Both spellings are checked now.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDbTime } from '../time'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Escape hatch: put this on the line for a timestamp we constructed ourselves. */
const OPT_OUT = 'db-time-safe'

/**
 * Argument shapes that cannot be a DB timestamp string.
 *
 * `new Date` is only dangerous when handed a STRING. Epoch arithmetic, a Date
 * copy, and `Date.UTC` are all fine and are the overwhelming majority of call
 * sites, so recognising them keeps the opt-out for cases that genuinely need a
 * human to have thought about it.
 */
const NUMERIC_ARG = /^\s*$|Date\.UTC\(|Date\.now\(\)|\.getTime\(\)|\*\s*1000|^\s*\d+\s*$/

/** The argument text of a `new Date(...)` call, with nesting balanced. */
function newDateArgs(line) {
  const args = []
  for (const m of line.matchAll(/new Date\(/g)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < line.length && depth > 0; i++) {
      if (line[i] === '(') depth++
      else if (line[i] === ')') depth--
    }
    // An unbalanced line is a wrapped call; treat it as needing review rather
    // than silently skipping it.
    args.push(line.slice(start, depth === 0 ? i - 1 : line.length))
  }
  return args
}

describe('parseDbTime handles what the API actually sends', () => {
  it('reads a bare two-digit offset that Date.parse rejects', () => {
    const wire = '2026-08-12T15:30:28.041124+00'
    expect(Number.isNaN(Date.parse(wire))).toBe(true)
    expect(parseDbTime(wire)?.getTime()).toBe(Date.UTC(2026, 7, 12, 15, 30, 28, 41))
  })

  it('reads negative offsets too', () => {
    expect(parseDbTime('2026-08-12T10:30:28.041-05')?.getTime())
      .toBe(Date.UTC(2026, 7, 12, 15, 30, 28, 41))
  })

  it('reads a timestamp-without-tz as UTC, not as local time', () => {
    // sync_metadata.last_sync is `timestamp without time zone` written by
    // now(), so it IS UTC but carries no offset. Bare `new Date` reads it in
    // the viewer's zone, which is not Invalid Date — it is quietly wrong by
    // the offset, which is the harder version of this bug to notice.
    expect(parseDbTime('2026-08-12T15:30:28.041')?.getTime())
      .toBe(Date.UTC(2026, 7, 12, 15, 30, 28, 41))
  })

  it('returns null rather than an Invalid Date', () => {
    expect(parseDbTime('not-a-date')).toBeNull()
    expect(parseDbTime(null)).toBeNull()
  })
})

describe('no source file parses a DB timestamp itself', () => {
  it(`finds no unguarded Date.parse / new Date in src (mark exceptions "${OPT_OUT}")`, () => {
    const srcDir = path.resolve(__dirname, '../..')
    const offenders = []

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
        } else if (/\.(js|jsx)$/.test(entry.name) && entry.name !== 'time.js') {
          const lines = fs.readFileSync(full, 'utf8').split('\n')
          lines.forEach((line, i) => {
            // Comments explaining the trap are fine, and so is an explicit
            // opt-out on the line itself or immediately above it — the marker
            // usually wants room to say WHY, which does not fit inline.
            if (/^\s*(\/\/|\*)/.test(line)) return
            if (line.includes(OPT_OUT)) return
            if ((lines[i - 1] ?? '').includes(OPT_OUT)) return
            if ((lines[i - 2] ?? '').includes(OPT_OUT)) return

            const bad = /Date\.parse\s*\(/.test(line)
              || newDateArgs(line).some((a) => !NUMERIC_ARG.test(a))
            if (bad) offenders.push(`${path.relative(srcDir, full)}:${i + 1}`)
          })
        }
      }
    }
    walk(srcDir)

    expect(
      offenders,
      'Date.parse and `new Date(str)` share one parser, and it returns NaN on ' +
      'the bare "+00" offset the API serves — silently. Use parseDbTime from ' +
      'utils/time. If the value is NOT a DB timestamp string (epoch maths, a ' +
      `Date copy, a datetime-local input), add a "${OPT_OUT}" comment saying which.`
    ).toEqual([])
  })

  it('recognises epoch arithmetic and Date copies as safe', () => {
    // Guards the allowlist itself: if NUMERIC_ARG ever stops matching these,
    // the scanner turns into noise and gets opted out of wholesale.
    for (const safe of [
      'const d = new Date()',
      'new Date(ts * 1000).toISOString()',
      'new Date(Date.UTC(y, m - 1, d))',
      'const copy = new Date(other.getTime())',
      'new Date(Date.now())',
    ]) {
      expect(newDateArgs(safe).every((a) => NUMERIC_ARG.test(a)), safe).toBe(true)
    }
  })

  it('flags a bare identifier, which is where every real bug was', () => {
    for (const bad of [
      'new Date(payout.created_at).toLocaleDateString()',
      'new Date(r.last_claimed_at).getTime()',
      'Math.floor(new Date(m.tsSpyAt).getTime() / 1000)',
    ]) {
      expect(newDateArgs(bad).some((a) => !NUMERIC_ARG.test(a)), bad).toBe(true)
    }
  })
})
