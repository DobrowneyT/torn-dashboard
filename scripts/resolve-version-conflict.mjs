#!/usr/bin/env node
// Resolve the version/changelog conflict this repo produces on purpose.
//
//   git rebase origin/dev          # conflicts on VERSION + package.json + CHANGELOG
//   node scripts/resolve-version-conflict.mjs
//   git rebase --continue
//
// ⚠️ It touches ONLY those six files, and only their conflict markers. If the
// rebase also stopped on real source, that is left alone and reported — the
// whole point is that this collision is mechanical and a code one is not.
//
// See scripts/versionConflict.mjs for why the convention that causes it is
// worth keeping.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveVersionFile, resolveChangelog } from './versionConflict.mjs'
import { VERSIONED } from './check-version-sync.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)
if (conflicted.length === 0) {
  console.log('No conflicted files. Nothing to do.')
  process.exit(0)
}

const OURS = new Set(['VERSION', 'CHANGELOG.md', ...VERSIONED])
const handled = []
const untouched = conflicted.filter((f) => !OURS.has(f))

if (existsSync(join(root, 'VERSION')) && conflicted.includes('VERSION')) {
  const p = join(root, 'VERSION')
  writeFileSync(p, resolveVersionFile(readFileSync(p, 'utf8')))
  handled.push('VERSION')
}
if (conflicted.includes('CHANGELOG.md')) {
  const p = join(root, 'CHANGELOG.md')
  writeFileSync(p, resolveChangelog(readFileSync(p, 'utf8')))
  handled.push('CHANGELOG.md')
}

// ⚠️ The package.json files are not merged line-by-line — they are DERIVED.
// Whatever VERSION ended up saying is the answer, so checking out either side
// and re-syncing is both simpler and impossible to get half-right.
const pkgConflicts = VERSIONED.filter((f) => conflicted.includes(f))
if (pkgConflicts.length > 0) {
  for (const f of pkgConflicts) git('checkout', '--theirs', '--', f)
  execFileSync(process.execPath, [join(root, 'scripts', 'check-version-sync.mjs'), '--fix'],
    { cwd: root, stdio: 'inherit' })
  handled.push(...pkgConflicts)
}

if (handled.length === 0) {
  console.log('Conflicts are all in source files — nothing here to resolve:')
  for (const f of untouched) console.log(`  ${f}`)
  process.exit(0)
}

git('add', '--', ...handled)
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
console.log(`\nResolved and staged at ${version}:`)
for (const f of handled) console.log(`  ${f}`)

if (untouched.length > 0) {
  // ⚠️ Loud, and a non-zero exit. A source conflict left unresolved while this
  // prints a tidy success message is exactly how half a rebase gets committed.
  console.error(`\n⚠️  STILL CONFLICTED — resolve these by hand:`)
  for (const f of untouched) console.error(`  ${f}`)
  process.exit(1)
}
console.log('\nNext:  git rebase --continue')
