// API Key Usage consent: versions, ordering, and what each one permits (#894).
//
// ⚠️ **The mechanism this replaces did nothing.** `config.js` declared
// `consentVersion: '2.0'` with the comment "bump to re-prompt the disclosure";
// nothing read it, the server stored a hardcoded `'login-v1'` instead, and no
// comparison existed anywhere. The page could be edited and no member was ever
// asked again — precisely the "sliding it in" the rule exists to prevent
// (MonChoon, 2026-10-04).
//
// ⚠️ **The naive fix would halt the faction.** Dropping un-re-consented keys
// from the pool stops every scraper for that member until they next log in. It
// does not have to: consent is PER PURPOSE. Somebody who has not accepted the
// new disclosure has still accepted the old one, and their key keeps serving
// everything it covered. Only a new purpose's calls skip them.

/**
 * Every disclosure version, **oldest first**.
 *
 * ⚠️ The ARRAY POSITION is the ordering. These ids do not compare as strings —
 * `'login-v1' < '2.0'` is false, and a lexical compare would silently invert
 * the whole gate. Anything that needs "is A at least B" goes through
 * `versionRank` and nothing else.
 *
 * ⚠️ `login-v1` is not a historical first draft — it is what every enrolled
 * member has stored right now, and it stands for the disclosure as it exists
 * today. Adding an entry here is what makes everyone stale, so an entry is
 * added in the SAME change that edits `ApiKeyDisclosure.jsx`, never before.
 */
export const DISCLOSURE_VERSIONS = [
  {
    id: 'login-v1',
    summary:
      'Identity and faction verification, CPR scraping, live War Room polling, ' +
      'background faction scrapers, own battle stats, opt-in event start time.',
    // ⚠️ Fingerprint of `ApiKeyDisclosure.jsx`'s ROWS as they stood for this
    // version. A guard test hashes the live rows and compares. Editing the
    // disclosure without adding a version here FAILS CI — which is the rule
    // "anytime we adjust the API Key Usage page, force a re-approval"
    // (MonChoon, 2026-10-04) made structural instead of remembered.
    rowsHash: '26fba5b54a067745',
  },
  {
    // #889 slice 0. Adds the Target Lookups row: a member's key may be used to
    // read the public profile of somebody a TEAMMATE added to the shared target
    // list, and that person's faction member list.
    //
    // ⚠️ Adding this entry is what re-prompts the whole faction. It was added
    // in the same change that edited `ApiKeyDisclosure.jsx`, which is the only
    // way the guard permits — and deliberately BEFORE the lookups themselves
    // ship, so members have time to accept before anything uses it.
    id: 'target-lookup-v1',
    summary:
      'Everything in login-v1, plus looking up players and factions that a ' +
      'member has added to the faction\u2019s shared target list.',
    rowsHash: 'd44d2274a0c49254',
  },
] as const

export type DisclosureVersion = (typeof DISCLOSURE_VERSIONS)[number]['id']

/** What a member must have accepted today. */
export const CURRENT_DISCLOSURE_VERSION: string =
  DISCLOSURE_VERSIONS[DISCLOSURE_VERSIONS.length - 1].id

/**
 * Purposes that need more than the baseline, and the version that disclosed
 * each. A purpose absent from here needs no minimum — which is every existing
 * scraper, and why none of them change behaviour.
 */
export const PURPOSE_VERSIONS: Record<string, string> = {
  // ⚠️ The Book of Grudges target lookups (#889). A key whose owner has not
  // accepted `target-lookup-v1` is SKIPPED for these calls and for nothing
  // else — every other scraper claims without a purpose and is unaffected.
  'target-lookup': 'target-lookup-v1',
}

/**
 * Position in the ordered list, or `null` for a version we do not recognise.
 *
 * ⚠️ Unknown is NOT "oldest". A value we cannot place — a rollback, a hand-
 * edited row, a version from a future build — is unplaceable, and treating it
 * as 0 would silently grant it everything the first version covers.
 */
export function versionRank(version: unknown): number | null {
  const id = String(version ?? '')
  const i = DISCLOSURE_VERSIONS.findIndex((v) => v.id === id)
  return i === -1 ? null : i
}

/**
 * May a key whose owner accepted `accepted` be used for `purpose`?
 *
 * ⚠️ **Fails CLOSED for a gated purpose and OPEN for an ungated one**, and the
 * asymmetry is the whole design. An unrecognised accepted version cannot be
 * shown to cover a new purpose, so it does not; but it must not cost the member
 * their existing scrapers either, and those ask for no purpose at all.
 */
export function consentCovers(accepted: unknown, purpose?: string | null): boolean {
  if (!purpose) return true
  const required = PURPOSE_VERSIONS[purpose]
  // A purpose nobody has gated is part of the baseline.
  if (!required) return true
  const need = versionRank(required)
  const have = versionRank(accepted)
  if (need === null) {
    // ⚠️ A purpose pointing at a version that is not in the list is a
    // programming error. Refuse rather than quietly permitting everything.
    return false
  }
  return have !== null && have >= need
}

/** Has this member accepted the disclosure as it stands today? */
export function consentIsCurrent(accepted: unknown): boolean {
  const have = versionRank(accepted)
  const now = versionRank(CURRENT_DISCLOSURE_VERSION)
  return have !== null && now !== null && have >= now
}
