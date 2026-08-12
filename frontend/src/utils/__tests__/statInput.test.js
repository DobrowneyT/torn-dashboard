// Shared battle-stat input parsing (#355).
//
// Extracted from two identical copies in WarRoomViewV2 and MobileWarRoomView.
// These tests exist mostly to pin the shorthand contract, so a third page
// cannot quietly diverge from it again.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStatInput, formatStats, matchesStatRange } from '../statInput'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('parseStatInput', () => {
  it('reads the k/m/b shorthand people actually type', () => {
    expect(parseStatInput('3')).toBe(3)
    expect(parseStatInput('3k')).toBe(3_000)
    expect(parseStatInput('3m')).toBe(3_000_000)
    expect(parseStatInput('2.6b')).toBe(2_600_000_000)
    expect(parseStatInput('.8m')).toBe(800_000)
    expect(parseStatInput('  2.6 B  ')).toBe(2_600_000_000)
  })

  it('returns null for anything that is not a number', () => {
    // Null means "no bound". Returning 0 would turn a typo into a filter that
    // silently excludes the whole roster.
    for (const bad of ['', '   ', undefined, null, 'abc', '3.', '.', '3x', '1,000', '-5']) {
      expect(parseStatInput(bad)).toBeNull()
    }
  })
})

describe('formatStats', () => {
  it('scales to the largest unit that fits', () => {
    expect(formatStats(999)).toBe('999')
    expect(formatStats(1_500)).toBe('1.5K')
    expect(formatStats(2_600_000)).toBe('2.60M')
    expect(formatStats(2_600_000_000)).toBe('2.60B')
    expect(formatStats(1_200_000_000_000)).toBe('1.20T')
  })

  it('shows ??? rather than 0 when there is no reading', () => {
    expect(formatStats(null)).toBe('???')
    expect(formatStats(undefined)).toBe('???')
    expect(formatStats(0)).toBe('0')
  })
})

describe('matchesStatRange', () => {
  it('applies either bound, or both', () => {
    expect(matchesStatRange(5_000_000, '3m', '')).toBe(true)
    expect(matchesStatRange(2_000_000, '3m', '')).toBe(false)
    expect(matchesStatRange(2_000_000, '', '3m')).toBe(true)
    expect(matchesStatRange(5_000_000, '', '3m')).toBe(false)
    expect(matchesStatRange(5_000_000, '3m', '10m')).toBe(true)
  })

  it('passes everyone when no bound is set, unknowns included', () => {
    expect(matchesStatRange(null, '', '')).toBe(true)
    expect(matchesStatRange(5, '', '')).toBe(true)
    // An unparseable bound is no bound — a half-typed "3." must not blank the
    // table while the user is still typing.
    expect(matchesStatRange(5, '3.', '')).toBe(true)
  })

  it('excludes a member with no reading once a bound is set', () => {
    // "Everyone over 3b" is a question about known stats. An unknown is not a
    // small answer to it — same reasoning as the #351 sort rule.
    expect(matchesStatRange(null, '3b', '')).toBe(false)
    expect(matchesStatRange(null, '', '3b')).toBe(false)
  })

  it('treats the bounds as inclusive', () => {
    expect(matchesStatRange(3_000_000, '3m', '3m')).toBe(true)
  })
})

describe('no page keeps its own copy of the parser', () => {
  // The reason this util exists. Two identical implementations had already
  // drifted apart in comments; a third was about to be written for Member
  // Overview. A scanner is the only thing that stops the fourth.
  it('finds no local parseStatInput definition in src', () => {
    const srcDir = path.resolve(__dirname, '../..')
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
        } else if (/\.(js|jsx)$/.test(entry.name) && entry.name !== 'statInput.js') {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(function|const)\s+parseStatInput\b/.test(line)) {
              offenders.push(path.relative(srcDir, full) + ':' + (i + 1))
            }
          })
        }
      }
    }
    walk(srcDir)
    expect(offenders, 'import parseStatInput from utils/statInput instead').toEqual([])
  })
})
