/**
 * The HMAC scope string for a tenant's Chain Watch token (#782).
 *
 * ⚠️ Its own tiny module so the CLI and the tests agree on the exact bytes.
 * The scope prefix is the whole point of the token — get it wrong in one place
 * and the bot 401s with no hint as to which side is mistaken.
 */
export const chainWatchScope = (slug) => `chain-watch:${slug}`
