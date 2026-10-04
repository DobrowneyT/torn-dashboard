import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every function called in a component must exist in that file.
 *
 * ⚠️ Why this is a test and not a lint rule: this repo has **no eslint config
 * at all**, so nothing catches an undeclared identifier. `vite build` does not
 * either — an unresolved bare name is a runtime `ReferenceError`, not a build
 * error, so the bundle compiles cleanly and the page explodes when it renders.
 *
 * That is exactly what happened. #836 (the shared-sort epic) deleted
 * `raceGroupHeaders` from `WarPayoutManagement` and left both call sites. The
 * build passed, every test passed, and War Payouts crashed with
 * "raceGroupHeaders is not defined" for three days until somebody opened it.
 * Its companion `raceColHeaders` survived the same commit, so only one of the
 * two header rows was missing — which is why nothing looked obviously wrong in
 * the diff.
 *
 * ⚠️ Deliberately narrow. It only checks names called as `name(` where `name`
 * is not preceded by a dot, which is where a deleted helper actually bites. It
 * is not a type checker and should not grow into one.
 */

const SRC = new URL('../../', import.meta.url).pathname

/** Globals and builtins a file may call without declaring. */
const AMBIENT = new Set([
  'require', 'import', 'fetch', 'alert', 'confirm', 'prompt', 'structuredClone',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob',
  'requestAnimationFrame', 'cancelAnimationFrame', 'reportError',
  // Control flow and operators the regex can brush against.
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
  // Not callees: `async (` opens an arrow, `constructor(` is a definition.
  'async', 'constructor',
  'super', 'new', 'do', 'else', 'try', 'yield', 'void', 'delete', 'in', 'of', 'case',
])

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__' || e === 'dist') continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.jsx$/.test(e)) out.push(full)
  }
  return out
}

/**
 * Comments only — ⚠️ string literals are deliberately NOT stripped.
 *
 * Stripping them destroyed the file. JSX prose is not a string literal, so an
 * apostrophe in ordinary text ("doesn't", "member's") opens a quote that runs
 * until the next apostrophe hundreds of lines later. On
 * `WarPayoutManagement.jsx` that swallowed **more than half the source**
 * (120,632 chars down to 57,351) — including the very call sites this guard
 * exists to find, so it passed while the bug was present.
 *
 * Leaving strings in risks a false positive only if a literal contains the
 * exact text `{name(`, which is vanishingly rare and would be obvious.
 * Comments must still go: the warnings in this repo NAME the functions they
 * warn about.
 */
const stripped = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')

/** Names this file declares, imports, destructures or takes as a parameter. */
function declaredIn(code) {
  const names = new Set()
  const add = (re, group = 1) => {
    for (const m of code.matchAll(re)) {
      for (const part of String(m[group] ?? '').split(',')) {
        // ⚠️ Split off the DEFAULT first and keep the left side. A default can
        // itself be an arrow (`fmt = (n) => n`), so splitting on `=` and taking
        // the last piece yields `> n` and the binding is lost — which made
        // every destructured-param-with-a-default read as undeclared.
        // Renames are the other way round: `a as b` and `key: value` bind the
        // RIGHT side, so those are resolved after the default is removed.
        const n = part.trim().replace(/^\.\.\./, '').split('=')[0]
          .split(/\s+as\s+|:/).pop()?.trim()
        if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n)
      }
    }
  }
  add(/\bfunction\s+([A-Za-z_$][\w$]*)/g)
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g)
  // import X, { a, b as c } from '...'
  add(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)
  add(/\bimport\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}/g)
  // Object destructuring, including function parameters.
  add(/\{([^{}]*)\}\s*(?:=[^=>]|=>|\))/g)
  // ⚠️ ARRAY destructuring — `const [open, setOpen] = useState(false)`. Without
  // this every React setter in the codebase reads as undeclared: 615 false
  // positives on the first run, which is a guard nobody would keep.
  add(/\[([^[\]]*)\]\s*=[^=]/g)
  // Plain parameters: (a, b) => and function f(a, b)
  add(/\(([^()]*)\)\s*=>/g)
  add(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g)
  return names
}

describe('no component calls a function that does not exist', () => {
  it('finds no undeclared callee in any .jsx file', () => {
    const offenders = []
    for (const file of walk(SRC)) {
      const code = stripped(readFileSync(file, 'utf8'))
      const declared = declaredIn(code)
      const seen = new Set()
      // ⚠️ Only `{name(` — a call inside a JSX expression container, which is
      // exactly where a deleted helper bites and exactly what `raceGroupHeaders`
      // was. Scanning every `name(` instead pulled in 63 false positives: class
      // method DEFINITIONS (`render() {`) match their own call shape, and JSX
      // prose ("...uses (both)") is not a string literal so the stripper leaves
      // it. A guard with 63 known-good failures is a guard that gets deleted.
      for (const m of code.matchAll(/\{\s*([a-z_$][\w$]*)\s*\(/g)) {
        const name = m[1]
        if (seen.has(name) || AMBIENT.has(name) || declared.has(name)) continue
        seen.add(name)
        offenders.push(`${file.replace(SRC, '')}: ${name}()`)
      }
    }
    expect(
      offenders,
      'These files call a function that is not declared or imported in them. ' +
      'A bundler will not catch it — it is a runtime ReferenceError, so the ' +
      'page compiles and then crashes when it renders.'
    ).toEqual([])
  })
})
