/**
 * The HMAC scope string for a tenant's member-threads token (#942).
 *
 * ⚠️ Its own scope, NOT a reuse of `war-overview:<slug>` or
 * `chain-watch:<slug>`. The same bot holds all three, but a scope is what stops
 * one feature's credential becoming another's: this one lets the holder drain a
 * queue of per-member performance records and mark them posted, which is write
 * access to a permanent roll-call log. A leak of the board token must not
 * confer it. #609 is explicit that reconnaissance handed over by accident is
 * still handed over.
 *
 * Its own tiny module so the CLI, the server and the tests agree on the exact
 * bytes — get it wrong in one place and the bot 401s with no hint which side
 * is mistaken.
 */
export const memberThreadsScope = (slug) => `member-threads:${slug}`
