// Guard against the #140 trap coming back.
//
// Postgres serves timestamptz as text with a BARE two-digit offset
// ("2026-08-12T15:30:28.041124+00"), which is NOT valid ISO 8601. `Date.parse`
// returns NaN on it — silently, which is what makes it dangerous:
//
//   • #330 travel ETAs never rendered a single estimate in production
//   • cooldowns stopped ageing and showed a frozen value as though live
//   • stats staleness never displayed
//   • the #385 concurrency harness had two checks that had quietly stopped
//     checking
//
// Four separate features, one root cause, none of them failing loudly. Review
// has now missed it repeatedly, so this is a scanner rather than a convention.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDbTime } from '../time'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Escape hatch: put this on the line for a timestamp we constructed ourselves. */
const OPT_OUT = 'db-time-safe'

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

  it('returns null rather than an Invalid Date', () => {
    expect(parseDbTime('not-a-date')).toBeNull()
    expect(parseDbTime(null)).toBeNull()
  })
})

describe('no source file parses a DB timestamp with Date.parse', () => {
  it(`finds no unguarded Date.parse in src (mark exceptions "${OPT_OUT}")`, () => {
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
            if (!/Date\.parse\s*\(/.test(line)) return
            // Comments explaining the trap are fine, and so is an explicit
            // opt-out on the line itself or immediately above it — the marker
            // usually wants room to say WHY, which does not fit inline.
            if (/^\s*(\/\/|\*)/.test(line)) return
            if (line.includes(OPT_OUT)) return
            if ((lines[i - 1] ?? '').includes(OPT_OUT)) return
            if ((lines[i - 2] ?? '').includes(OPT_OUT)) return
            offenders.push(`${path.relative(srcDir, full)}:${i + 1}`)
          })
        }
      }
    }
    walk(srcDir)

    expect(
      offenders,
      'Date.parse returns NaN on the bare "+00" offset the API serves, and does ' +
      'it silently. Use parseDbTime from utils/time. If the value is NOT a DB ' +
      `timestamp (e.g. a datetime-local input you appended "Z" to), add a "${OPT_OUT}" ` +
      'comment on the line.'
    ).toEqual([])
  })
})
