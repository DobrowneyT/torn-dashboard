import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ROWS } from '../../components/ApiKeyDisclosure.jsx'

/**
 * Editing the API Key Usage page forces a re-approval (#894).
 *
 * ⚠️ **This guard exists because the rule is otherwise unenforceable.** The
 * standing instruction is: *"Anytime we adjust the API Key Usage page then,
 * lets force a re-approval"* (MonChoon, 2026-10-04). Nothing about editing a
 * JSX array reminds anybody of that, and the old mechanism failed in exactly
 * this way — `config.js` said "bump to re-prompt the disclosure", nothing read
 * the value, and the page could be rewritten with no member ever asked again.
 *
 * So the disclosure and its version are pinned together: each entry in
 * `DISCLOSURE_VERSIONS` carries a fingerprint of the rows as they stood for it.
 * Change the rows and this fails, and the only way to make it pass is to add a
 * version — which is what re-prompts everybody.
 *
 * ⚠️ Reads the server file as TEXT rather than importing it. The version list
 * is server-side on purpose (it gates the key pool) and this is a frontend
 * suite; the repo's other guards — `noUndefinedCalls`, `sortColumnKinds` — scan
 * source the same way.
 */

const CONSENT_TS = new URL('../../../../server/src/consent.ts', import.meta.url).pathname

/** Must match the hashing in this file's sibling check in `consent.ts`. */
function hashRows(rows) {
  // Hash the SHOWN TEXT, so re-indenting or editing a code comment does not
  // trip the guard while any change to what a member reads does.
  const body = rows.map((r) => r.join('\u001f')).join('\u001e').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

describe('the API Key Usage disclosure is pinned to a consent version', () => {
  const src = readFileSync(CONSENT_TS, 'utf8')
  const hashes = [...src.matchAll(/rowsHash:\s*'([0-9a-f]{16})'/g)].map((m) => m[1])
  const ids = [...src.matchAll(/^\s*id:\s*'([^']+)'/gm)].map((m) => m[1])

  it('declares a version and a fingerprint for it', () => {
    expect(ids.length).toBeGreaterThan(0)
    expect(hashes.length).toBe(ids.length)
  })

  it('⚠️ the live disclosure matches the CURRENT version’s fingerprint', () => {
    const current = hashes[hashes.length - 1]
    expect(
      hashRows(ROWS),
      'The API Key Usage disclosure has changed. That requires a NEW entry in ' +
      'DISCLOSURE_VERSIONS in server/src/consent.ts, carrying this hash — ' +
      'which is what forces every member to re-accept. Do not edit the ' +
      'existing entry’s hash: that would change the page without asking anybody, ' +
      'which is the exact thing this guard prevents.'
    ).toBe(current)
  })

  it('⚠️ every version id is distinct, since position is the ordering', () => {
    // A duplicate id makes `versionRank` return the first match and silently
    // mis-rank everything after it.
    expect(new Set(ids).size).toBe(ids.length)
  })
})
