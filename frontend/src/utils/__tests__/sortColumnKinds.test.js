import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every sort column states what KIND of value it holds.
 *
 * ⚠️ Why this is a guard: `compareValues` falls through to TEXT when a column
 * declares no `kind`. That is a reasonable default for a comparator, but it is
 * a silent one for a column — a numeric column that omits `kind` sorts
 * lexically, renders perfectly, and is simply in the wrong order.
 *
 * That is what shipped in #872. The Hall of Fame board declared four columns
 * and gave `kind` to only the text one, so every number on it sorted as a
 * string:
 *
 *     #             1, 10, 11, 12 … 19, 2, 20 … 29, 3
 *     Racing skill  9.77, 9.32, 8.94, 8.77, 77.35, 75.33, 7.91
 *     Racing wins   97, 94, 933, 93, 89, 8,775, 86, 83, 808
 *     Travel time   9,849,600 … 950,400 … 9,072,000 … 72,489,600
 *
 * Nothing looked wrong in the source: the accessor returns a number, the
 * header sorts, the arrow moves. It was reported by somebody reading the live
 * page, which is the one review step that should never be load-bearing.
 *
 * ⚠️ The signature is `key:` + `accessor:` in the same object literal, which
 * at the time of writing matches sort columns and nothing else in this
 * codebase — 125 of them already declare a `kind`, so the convention is real
 * and this only holds the line. A `compare:` satisfies it too: a bespoke
 * comparator IS the kind.
 *
 * ⚠️ A TEXT column must say `kind: 'text'` rather than lean on the default.
 * The whole failure above was a default nobody declared, and "it happens to be
 * right" is indistinguishable in the source from "nobody thought about it".
 */

const SRC = new URL('../../', import.meta.url).pathname

/** ⚠️ Prose in this repo's comments routinely contains braces and quotes. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__' || e === 'dist') continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.jsx?$/.test(e)) out.push(full)
  }
  return out
}

/**
 * Object literals that open with `key:`, sliced by brace counting.
 *
 * ⚠️ Capped at 2000 characters. An unbalanced brace inside a string literal
 * would otherwise run the slice to the end of the file and swallow a later
 * `kind:`, turning a real offender into a silent pass.
 */
function columnLiterals(code) {
  const out = []
  const re = /\{\s*key:\s*['"]/g
  let m
  while ((m = re.exec(code))) {
    let depth = 0
    let end = -1
    const stop = Math.min(code.length, m.index + 2000)
    for (let i = m.index; i < stop; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end !== -1) out.push(code.slice(m.index, end + 1))
  }
  return out
}

describe('every sort column declares its kind', () => {
  it('finds no column with an accessor but no kind or compare', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const lit of columnLiterals(code)) {
        if (!/\baccessor\s*:/.test(lit)) continue
        if (/\bkind\s*:/.test(lit) || /\bcompare\s*:/.test(lit)) continue
        const key = lit.match(/key:\s*['"]([^'"]+)['"]/)?.[1] ?? '?'
        offenders.push(`${file.replace(SRC, '')}: { key: '${key}' }`)
      }
    }
    expect(
      offenders,
      "These sort columns declare no `kind`, so they fall through to a TEXT " +
      "comparison. If they hold numbers they are sorting lexically right now " +
      "— 1, 10, 11, 2 — and the page looks completely normal while doing it. " +
      "Add kind: 'number' | 'date' | 'bool' | 'text', or a `compare`."
    ).toEqual([])
  })
})
