// A Discord forum thread per member, and the queue that fills it (#942).
//
// ⚠️ **Everything planned here becomes a permanent message in a thread with one
// member's name on it**, in a channel leadership reads. That shapes every rule
// below: a duplicate says somebody joined twice, a backfilled note invents a
// date nobody recorded, and a note for a member with no thread is simply lost.
//
// ⚠️ **The bot POLLS this queue; the dashboard never calls the bot.** Chain
// Watch already works that way across five factions, and the bot is a Discord
// gateway client with no inbound HTTP server. MonChoon: *"basically a mailbox
// from the dashboard that there are updates waiting to be posted."*

/**
 * What a queued row is.
 *
 * ⚠️ Free text in the column with no CHECK, like `release_reason` (#530): the
 * vocabulary lives here so #943's war report needs no migration to join it.
 */
export const OUTBOX_KINDS = {
  /** A member appeared on the roster. Creates the thread if there is none. */
  joined: 'joined',
  /** A member left. Appended to their existing thread. */
  left: 'left',
  /**
   * One member's performance in one finished war (#943).
   *
   * ⚠️ **Appended, never replacing.** One running log per member: a new war
   * adds a post, and a re-run of the SAME war edits the one already there.
   * That is why the subject is the war — see `warSubject`.
   */
  war_report: 'war_report',
} as const

export type OutboxKind = typeof OUTBOX_KINDS[keyof typeof OUTBOX_KINDS]

/**
 * The `subject` that makes a row unique.
 *
 * ⚠️ The STINT, not the member. A rejoin is a second stint for the same person
 * and must produce a second note in the same thread — keying on the member
 * would silently swallow it as a duplicate, and the log would never show they
 * came back.
 */
export const stintSubject = (stintId: number | string) => `stint:${stintId}`

/**
 * The `subject` for a war report.
 *
 * ⚠️ The WAR, so the unique index on `(member_id, kind, subject)` makes a
 * re-run of the same war idempotent — which is what turns "post again" into
 * "edit the existing post". MonChoon: *"on a re-run for the same war I would
 * edit the post. on a new war I would append."*
 */
export const warSubject = (warId: number | string) => `war:${warId}`

export interface StintRow {
  id: number
  member_id: string | null
  member_name?: string | null
  /** epoch ms */
  joined_at: number
  /** epoch ms, or null while they are still here */
  left_at: number | null
}

export interface PlannedRow {
  member_id: string
  kind: OutboxKind
  subject: string
  payload: Record<string, unknown>
}

const key = (r: { member_id: string; kind: string; subject: string }) =>
  `${r.member_id}|${r.kind}|${r.subject}`

/**
 * What to queue, given every stint and what is already queued.
 *
 * `installedAt` is when this faction started being watched, in epoch ms, and it
 * never moves.
 *
 * ⚠️ **A fixed watermark rather than one that advances.** An advancing
 * watermark has a race — a stint written between the read and the advance is
 * skipped forever — and the unique index on `(member_id, kind, subject)` already
 * gives idempotency, so there is nothing for the advance to buy.
 *
 * ⚠️ **Strictly after, so a collision reads as pre-existing.** Timestamps are
 * compared at millisecond resolution, and an event landing in the SAME
 * millisecond as the watermark is treated as having happened before it. That
 * under-reports by at most one event in a window nothing real occupies —
 * installation and a join are minutes apart, not microseconds — and the
 * alternative rounds the other way, which would queue a member of the
 * pre-existing roster and invent a join date. Under-report, never invent.
 *
 * ⚠️ **No backfill.** MonChoon: *"dont worry about backfilling we can start
 * posting membership status starting now."* The roster at install is ~94 people
 * whose real join dates nobody has — stints are only observed from #284 — so
 * queuing them would write invented dates into permanent records AND create 94
 * threads in a single burst.
 */
export function planThreadWork({
  stints = [], installedAt, queued = new Set<string>(),
}: {
  stints?: StintRow[]
  installedAt: number
  queued?: Set<string>
}): PlannedRow[] {
  const rows: Array<PlannedRow & { at: number }> = []

  for (const s of stints) {
    const memberId = s?.member_id == null ? '' : String(s.member_id)
    if (!memberId) continue
    const subject = stintSubject(s.id)
    // ⚠️ Resolved NOW, not at post time. A rename between queueing and draining
    // would otherwise put today's name on a note about an old membership.
    const payload = { member_name: s.member_name ?? null, stint_id: s.id }

    // ⚠️ **The note carries WHEN it happened**, not just that it did. Without
    // it the bot can only date a note by when it was queued, which is the
    // sweep's cadence rather than the event's — and a restart can make that
    // hours wrong in a permanent log.

    if (Number(s.joined_at) > Number(installedAt)) {
      const row: PlannedRow = {
        member_id: memberId, kind: OUTBOX_KINDS.joined, subject,
        payload: { ...payload, at: Number(s.joined_at) },
      }
      if (!queued.has(key(row))) rows.push({ ...row, at: Number(s.joined_at) })
    }

    // ⚠️ A leave is queued even when the join was not — somebody who was here
    // before we started watching still really left, and that is worth logging.
    // It is the one place the no-backfill rule and "log what happens" disagree,
    // and "log what happens" wins because the event itself is observed.
    if (s.left_at != null && Number(s.left_at) > Number(installedAt)) {
      const row: PlannedRow = {
        member_id: memberId, kind: OUTBOX_KINDS.left, subject,
        payload: { ...payload, at: Number(s.left_at) },
      }
      if (!queued.has(key(row))) rows.push({ ...row, at: Number(s.left_at) })
    }
  }

  // ⚠️ **CHRONOLOGICAL, by when each event actually happened.**
  //
  // The first version of this put every join before every leave, which is wrong
  // the moment one batch contains a leave from an old stint and a join from a
  // new one — i.e. exactly a rejoin. That ordering wrote
  // "joined · joined · left" into the member's log when what happened was
  // join → leave → join. The unit test enshrined the wrong rule and an
  // integration test against real rows is what caught it.
  //
  // The drain posts in the order it receives, and this is a permanent log, so
  // the order IS part of what it says.
  return rows
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...row }) => row)
}
