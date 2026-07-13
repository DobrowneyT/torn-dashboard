// The `comment` every Torn API call carries.
//
// Torn shows this against each request in the key owner's personal API-usage
// log. Members lend their keys to the faction key pool, so this is how they see
// what is spending their calls — which only works if EVERY call path sets it and
// they all agree. Historically they didn't (TNL-Scraper here, TNL-Inventory-Sync
// there, nothing at all on login/OC), which made the log unreadable.
//
// Torn only accepts a restricted character set, so keep it alphanumeric with
// hyphens/underscores — no spaces (see the test that guards this).
export const TORN_API_COMMENT = process.env.TORN_API_COMMENT || 'Faction-Dashboard'

/** Append key + app comment to a Torn URL, choosing `?` or `&` as needed. */
export function withTornAuth(url: string, key: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}key=${encodeURIComponent(key)}&comment=${encodeURIComponent(TORN_API_COMMENT)}`
}
