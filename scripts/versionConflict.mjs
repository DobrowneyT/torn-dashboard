/**
 * Resolving the one merge conflict this repo produces on purpose.
 *
 * ⚠️ **The conflict is a consequence of a convention worth keeping.** Every PR
 * bumps `VERSION`, the four `package.json` files and adds a dated `CHANGELOG`
 * heading, so `main`'s version strictly increases on every merge — verified
 * across 3.143.0 → 3.149.0 with no repeats. Two PRs cut from the same base
 * therefore always collide on exactly those six files, and on nothing else.
 *
 * So the fix is not to weaken the convention (the alternative needs an
 * `[Unreleased]` section, which this repo explicitly does not have) but to make
 * the collision a one-liner. The resolution is completely mechanical:
 *
 *   • VERSION        → the HIGHER of the two, never the incoming one blindly
 *   • package.json×4 → whatever VERSION ends up saying
 *   • CHANGELOG.md   → both entries, newest heading first
 *
 * Kept apart from the CLI so it can be tested without a git repo in conflict.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Compare two X.Y.Z strings. Returns >0 when `a` is newer. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a).trim())
  const pb = SEMVER.exec(String(b).trim())
  if (!pa || !pb) throw new Error(`not X.Y.Z: ${JSON.stringify(!pa ? a : b)}`)
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  return 0
}

/**
 * Split a conflicted file into its blocks.
 *
 * Returns a list of `{ ours, theirs }` plus the surrounding text, or `null`
 * when the file has no conflict markers at all.
 */
export function parseConflicts(text) {
  const lines = text.split('\n')
  const blocks = []
  const out = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { out.push(lines[i]); i += 1; continue }
    const ours = []
    const theirs = []
    i += 1
    while (i < lines.length && !lines[i].startsWith('=======')) { ours.push(lines[i]); i += 1 }
    // ⚠️ An unterminated block means the file is not what we think it is —
    // bail rather than "resolve" it into something plausible but wrong.
    if (i >= lines.length) throw new Error('conflict block has no ======= separator')
    i += 1
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) { theirs.push(lines[i]); i += 1 }
    if (i >= lines.length) throw new Error('conflict block has no >>>>>>> terminator')
    i += 1
    out.push({ __block: blocks.length })
    blocks.push({ ours, theirs })
  }
  if (blocks.length === 0) return null
  return { parts: out, blocks }
}

/** Re-assemble, replacing each block with the lines a resolver chose. */
function render(parsed, resolved) {
  return parsed.parts
    .map((p) => (typeof p === 'object' ? resolved[p.__block].join('\n') : p))
    .join('\n')
}

/** VERSION: the higher of the two sides. */
export function resolveVersionFile(text) {
  const parsed = parseConflicts(text)
  if (!parsed) return text
  const resolved = parsed.blocks.map(({ ours, theirs }) => {
    const a = ours.join('').trim()
    const b = theirs.join('').trim()
    // ⚠️ HIGHER, not "theirs". During a rebase "ours" is the branch being
    // replayed ONTO — so blindly taking one side can silently move the version
    // backwards, which is precisely the thing the convention exists to prevent.
    return [compareVersions(a, b) >= 0 ? a : b]
  })
  return render(parsed, resolved)
}

const HEADING = /^## \[(\d+\.\d+\.\d+)\]/

/** The first `## [X.Y.Z]` heading in a run of lines, or null. */
function firstVersion(lines) {
  for (const l of lines) {
    const m = HEADING.exec(l)
    if (m) return m[1]
  }
  return null
}

/**
 * CHANGELOG: keep BOTH sides, newest heading first.
 *
 * ⚠️ Never drops a side. Each entry documents something that shipped, and a
 * resolution that quietly kept one would leave a released change with no record
 * — the opposite of what the file is for.
 */
export function resolveChangelog(text) {
  const parsed = parseConflicts(text)
  if (!parsed) return text
  const resolved = parsed.blocks.map(({ ours, theirs }) => {
    const vo = firstVersion(ours)
    const vt = firstVersion(theirs)
    // ⚠️ No heading on one side means this is not the ordinary two-releases
    // collision. Keep both in the order git presented them rather than
    // inventing a ranking from nothing.
    if (!vo || !vt) return [...theirs, ...ours]
    return compareVersions(vt, vo) >= 0 ? [...theirs, ...ours] : [...ours, ...theirs]
  })
  return render(parsed, resolved)
}
