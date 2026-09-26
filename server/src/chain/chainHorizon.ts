/**
 * How far ahead an unfilled slot is worth shouting about (#772, #775).
 *
 * ⚠️ **Defined once, on the server, because two definitions will drift and the
 * one that drifts is the one nobody is looking at.** The page warns on this
 * horizon and the Discord bot pings on it; if they disagree, leadership sees a
 * gap announced in a channel that the page calls covered, and stops believing
 * both. The bot is explicitly forbidden from carrying its own copy (#785) — it
 * reads `gap_horizon_hours` out of the payload.
 *
 * Six hours is a stated tunable, not a law: long enough that somebody asleep
 * now can still be asked when they wake, short enough that the warning is about
 * this shift rather than the whole event.
 */
export const GAP_HORIZON_HOURS = 6
