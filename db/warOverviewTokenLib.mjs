/**
 * The HMAC scope string for a tenant's War Overview token (#811).
 *
 * ⚠️ Its own scope, NOT a reuse of `chain-watch:<slug>`. Both are held by the
 * same bot, but a scope is what stops one feature's credential becoming
 * another's: a leak of the board token must not also hand over a war's full
 * attack and revive history. #609 is explicit that reconnaissance handed over
 * by accident is still handed over.
 *
 * Its own tiny module so the CLI, the server and the tests agree on the exact
 * bytes — get it wrong in one place and the bot 401s with no hint which side
 * is mistaken.
 */
export const warOverviewScope = (slug) => `war-overview:${slug}`
