/**
 * Login lockout for the admin control plane (#609 slice 2).
 *
 * Rate limiting caps how FAST an attacker can guess; lockout caps how MANY
 * times they may. Both are needed: `@fastify/rate-limit` alone would still let
 * a patient attacker grind indefinitely at just under the limit, which against
 * a six-digit TOTP and a human-chosen password is a real threat over days.
 *
 * ⚠️ In-memory on purpose, and the trade is worth stating: restarting the
 * container clears the counters. That is acceptable because the attacker cannot
 * cause a restart, and the alternative — lockout state in the shared `global`
 * database — would put a write on the login path and make the control plane's
 * own database an availability dependency of logging in to fix it.
 */
export const MAX_FAILURES = 5
export const LOCKOUT_MS = 15 * 60 * 1000

interface Entry { failures: number; lockedUntil: number }

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly maxFailures = MAX_FAILURES,
    private readonly lockoutMs = LOCKOUT_MS
  ) {}

  /** Milliseconds remaining, or 0 when not locked. */
  lockedFor(key: string, now = Date.now()): number {
    const e = this.entries.get(key)
    if (!e || e.lockedUntil <= now) return 0
    return e.lockedUntil - now
  }

  /**
   * Record a failure. Returns true if this one triggered a lockout.
   *
   * ⚠️ Keyed by USERNAME, not by IP. An attacker trivially rotates source
   * addresses, and this box sits behind nginx where every request would
   * otherwise share one proxy address — locking on that would let one attacker
   * lock the real operator out, turning a defence into the attack.
   */
  fail(key: string, now = Date.now()): boolean {
    const e = this.entries.get(key) ?? { failures: 0, lockedUntil: 0 }
    // A lockout that has already expired starts a fresh count rather than
    // resuming at the old total, or one bad day would leave an account
    // permanently one mistake from locking.
    if (e.lockedUntil !== 0 && e.lockedUntil <= now) e.failures = 0
    e.failures += 1
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = now + this.lockoutMs
      e.failures = 0
      this.entries.set(key, e)
      return true
    }
    e.lockedUntil = 0
    this.entries.set(key, e)
    return false
  }

  /** A successful login clears the record entirely. */
  succeed(key: string): void {
    this.entries.delete(key)
  }
}
