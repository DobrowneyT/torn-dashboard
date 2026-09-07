/**
 * In-place edits to `deploy/.env` for credential rotation (#646).
 *
 * ⚠️ Kept separate from the generator so it can be tested without minting
 * credentials or touching a real deploy directory. Rewriting the file that
 * holds every faction's database password deserves tests of its own.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'

/**
 * Set keys in an env file, preserving everything else.
 *
 * ⚠️ Rewrites a key IN PLACE rather than appending a second copy. `dotenv` and
 * docker compose both take the LAST occurrence, so appending would work by
 * accident while leaving the old credential visible above it — and an operator
 * reading the file would see two `ADMIN_PASSWORD_HASH` lines with no way to
 * know which is live.
 *
 * ⚠️ Comments, blank lines and ordering survive untouched. This file is
 * hand-maintained and heavily commented; a rotation that reformatted it would
 * make every future diff unreadable.
 */
export function setEnvValues(text, values) {
  const remaining = new Map(Object.entries(values))
  const lines = text.split('\n')

  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (!m || !remaining.has(m[1])) return line
    const key = m[1]
    const value = remaining.get(key)
    remaining.delete(key)
    return `${key}=${value}`
  })

  // ⚠️ A hand-edited .env may lack a trailing newline; appending without one
  // glues onto the last line. The same trap db/new-faction.mjs and
  // db/new-global.mjs already guard.
  if (remaining.size > 0) {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
    for (const [key, value] of remaining) out.push(`${key}=${value}`)
    out.push('')
  }
  return out.join('\n')
}

export function readEnv(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Current value of one key, or null. Last occurrence wins, as dotenv does. */
export function envValue(text, key) {
  let found = null
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${key}=(.*)$`).exec(line)
    if (m) found = m[1]
  }
  return found
}

/**
 * ⚠️ Written via a temp file and renamed, not truncated in place.
 *
 * `deploy/.env` holds every faction's database password and is not in git. A
 * crash midway through a plain write leaves it truncated, and the recovery is
 * re-provisioning every tenant credential by hand. Rename is atomic on the same
 * filesystem, so the file is either the old one or the new one.
 */
export function writeEnv(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}
