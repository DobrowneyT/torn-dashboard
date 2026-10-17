// Pure rules for the live chain report (#970). No database, no Torn — the
// poller (chainReportPoller.ts) does the I/O and asks these the questions.
import { createHash } from 'node:crypto'

/** The respect a bonus hit counts for once capped (#967, the war-report rule). */
export const BONUS_RESPECT_CAP = 10

/**
 * How far past a report's `end` a poll must be before the chain counts as over.
 *
 * ⚠️ What a RUNNING chain's `end` holds has not been observed — the report for
 * an ongoing chain is visible only to that faction's own keys, and none of ours
 * was chaining when this was built. Every plausible reading is handled by
 * requiring the end to be fixed AND in the past by a margin:
 *   - `0` while running          → never ended until it is set
 *   - a projected `now + timeout` → always in the future, never ended
 *   - `now`, like `/faction/chain` on an idle faction → never a minute behind
 * A finished chain's end is fixed, so polls soon run a minute past it.
 */
export const CHAIN_END_MARGIN_MS = 60_000

/** After this many failures in a row the poller waits at most this long. */
export const MAX_BACKOFF_MS = 60_000

export interface ChainReport {
  chainId: number
  factionId: number
  startMs: number
  /** Null when Torn sends 0 or nothing. */
  endMs: number | null
  details: Record<string, unknown>
  attackers: any[]
  bonuses: any[]
  nonAttackers: any[]
}

/** Torn's `/faction/chainreport` body → our shape. Throws on anything else. */
export function normaliseReport(body: any): ChainReport {
  const r = body?.chainreport
  if (!r || typeof r !== 'object') throw new Error('chain report missing from response')
  const chainId = Number(r.id)
  const factionId = Number(r.faction_id)
  const start = Number(r.start)
  if (!Number.isFinite(chainId) || chainId <= 0) throw new Error('chain report has no chain id')
  if (!Number.isFinite(factionId) || factionId <= 0) throw new Error('chain report has no faction id')
  if (!Number.isFinite(start) || start <= 0) throw new Error('chain report has no start')
  const end = Number(r.end)
  return {
    chainId,
    factionId,
    startMs: start * 1000,
    endMs: Number.isFinite(end) && end > 0 ? end * 1000 : null,
    details: r.details ?? {},
    attackers: Array.isArray(r.attackers) ? r.attackers : [],
    bonuses: Array.isArray(r.bonuses) ? r.bonuses : [],
    nonAttackers: Array.isArray(r.non_attackers) ? r.non_attackers : [],
  }
}

/** Changes whenever anything a member could see in the report changes. */
export function reportHash(r: ChainReport): string {
  return createHash('sha1')
    .update(JSON.stringify([r.chainId, r.endMs, r.details, r.attackers, r.bonuses, r.nonAttackers]))
    .digest('hex')
}

/**
 * Is this report about the event's chain?
 *
 * ⚠️ With no chain running, Torn returns the faction's LAST chain — which
 * before 10:00 TCT on day one is some ordinary chain from last week. A chain
 * counts if it was still going when the event opened (members may start
 * anywhere from 10:00 to 16:00 TCT, and a chain started a minute early must not
 * leave the whole report empty).
 */
export function belongsToEvent(r: ChainReport, eventStartMs: number): boolean {
  return r.endMs == null || r.endMs >= eventStartMs
}

/** Has the chain finished, judged at a poll made at `polledAtMs`? */
export function chainReportEnded(endMs: number | null, polledAtMs: number): boolean {
  return endMs != null && endMs <= polledAtMs - CHAIN_END_MARGIN_MS
}

export interface CappedRespect { raw: number; capped: number; deduction: number }

/**
 * Raw and capped respect per member: raw minus Σ(bonus respect − 10) over
 * their bonus hits (#967). Keyed by member id as a string.
 */
export function cappedRespectByMember(attackers: any[], bonuses: any[]): Map<string, CappedRespect> {
  const deduction = new Map<string, number>()
  for (const b of bonuses) {
    const id = String(b?.attacker_id)
    const over = Math.max(0, Number(b?.respect ?? 0) - BONUS_RESPECT_CAP)
    deduction.set(id, (deduction.get(id) ?? 0) + over)
  }
  const out = new Map<string, CappedRespect>()
  for (const a of attackers) {
    const id = String(a?.id)
    const raw = Number(a?.respect?.total ?? 0)
    const d = deduction.get(id) ?? 0
    out.set(id, { raw, capped: round2(raw - d), deduction: round2(d) })
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Wait before the next poll: the configured cadence, doubling per failure in a
 * row up to a minute. ⚠️ Backs off during an outage so a Torn that is down for
 * hours is asked once a minute rather than twelve times; resumes at full speed
 * on the first success.
 */
export function nextDelayMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(consecutiveFailures, 16))
}

/**
 * Should this changed report also be kept as a full snapshot?
 *
 * Every `intervalMs`, plus ALWAYS on a new chain and on the chain ending — the
 * two moments the report will be read back for.
 */
export function shouldSnapshot(args: {
  lastSnapshotAtMs: number | null
  lastChainId: number | null
  chainId: number
  ended: boolean
  nowMs: number
  intervalMs: number
}): boolean {
  if (args.lastSnapshotAtMs == null || args.lastChainId !== args.chainId) return true
  if (args.ended) return true
  return args.nowMs - args.lastSnapshotAtMs >= args.intervalMs
}
