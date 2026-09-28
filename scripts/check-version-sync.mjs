#!/usr/bin/env node
// VERSION and every package.json must agree.
//
// ⚠️ **This shipped undetected once.** PR #804 (2026-09-27) branched off `dev`
// before another version bump landed, so its `sed` looked for a version string
// that was not in the file. Result: `VERSION` said 3.146.0 while all four
// package.json files still said 3.144.1 — and CI passed, because the changelog
// gate only checks that CHANGELOG.md *changed*, never that the numbers agree.
// It was caught by hand during a rebase, which is not a control.
//
// It matters because the two are read in different places: `VERSION` feeds the
// footer (VITE_APP_VERSION at build) and `/api/health` at runtime, while the
// package files are what npm and the Docker builds see. When they disagree the
// dashboard reports a version that was never built.
//
//   node scripts/check-version-sync.mjs          # check
//   node scripts/check-version-sync.mjs --fix    # write VERSION into all of them
//
// ⚠️ There is deliberately no escape hatch. The changelog gate has one because
// a test-only PR legitimately needs no changelog line; there is no such thing
// as a legitimate version mismatch.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every file that carries the app version, relative to the repo root. */
export const VERSIONED = [
  'package.json',
  'frontend/package.json',
  'server/package.json',
  'db/package.json',
]

/**
 * Compare VERSION against every package.json.
 *
 * Returns `{ version, wrong }` — `wrong` lists `{ rel, found }` for each file
 * that disagrees. With `fix`, rewrites them to match and returns what changed.
 */
export function checkVersionSync({ fix = false } = {}) {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`VERSION is "${version}", which is not X.Y.Z.`)
  }

  const wrong = []
  for (const rel of VERSIONED) {
    const path = join(root, rel)
    const text = readFileSync(path, 'utf8')
    const found = JSON.parse(text).version
    if (found === version) continue
    wrong.push({ rel, found })
    if (!fix) continue
    // ⚠️ A targeted substitution, not JSON.stringify of the parsed object —
    // that would reformat the whole file and bury the one-line change in
    // noise. Anchored to the FIRST "version" key, which is the package's own;
    // a dependency named "version" would otherwise be rewritten.
    writeFileSync(path, text.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`))
  }
  return { version, wrong }
}

// ⚠️ CLI body guarded, because this module is ALSO imported by
// db/test/version-sync.test.mjs. Without the guard the import runs the script,
// which calls process.exit() and kills the test run before a single test is
// collected — it did exactly that once.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const fix = process.argv.includes('--fix')
  let result
  try {
    result = checkVersionSync({ fix })
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  const { version, wrong } = result

  if (wrong.length === 0) {
    console.log(`\u2713 VERSION ${version} matches all ${VERSIONED.length} package.json files.`)
    process.exit(0)
  }
  if (fix) {
    console.log(`Set ${wrong.length} file(s) to ${version}: ${wrong.map(w => w.rel).join(', ')}`)
    process.exit(0)
  }
  console.error(
    `VERSION is ${version}, but:\n` +
    wrong.map(w => `  ${w.rel} says ${w.found}`).join('\n') +
    `\n\nThe footer and /api/health read VERSION; npm and the Docker builds read\n` +
    `the package files. Disagreeing means the dashboard reports a version that\n` +
    `was never built.\n\nFix:  node scripts/check-version-sync.mjs --fix`
  )
  process.exit(1)
}
