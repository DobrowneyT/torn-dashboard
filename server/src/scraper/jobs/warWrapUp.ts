// #945 — when a war ends: collect everything, verify it, then queue the roster.
//
// ⚠️ **It DRIVES the existing jobs rather than re-implementing them.** attacks,
// revives, wars-sync (which already fetches `rankedwarreport` into
// `war_member_contributions`) and dibs-summary all already work and are already
// tested. A second implementation of any of them is a second definition of what
// counts as an attack, which this repo has paid for repeatedly.
//
// ⚠️ **SEQUENCED, not parallel.** `dibs-summary` classifies a claim by looking
// for the attack that explains it, so running it before the final attack scrape
// records real conversions as "no swing" — permanently, in threads with
// members' names on them.
//
// ⚠️ **Nothing is queued until every source is confirmed present.** See
// `warWrapUp.ts` for the verdict rules, including why `report_unavailable` fails
// immediately instead of waiting out the retry window.
import type pg from 'pg'
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'
import {
  assessWrapUp, retryWindowMinutes, WRAP_UP_SETTING, type WrapUpVerdict,
} from '../../warWrapUp.js'
import { OUTBOX_KINDS, warSubject } from '../../memberThreads.js'
import { DIBS_SUMMARY_JOB } from '../../memberWarReport.js'

/** How many wars one run will wrap up. More than one ends at once only after an outage. */
const MAX_WARS_PER_RUN = 3

export interface WrapUpDeps extends JobDeps {
  /**
   * Runs another registered job by name, as the admin "run now" does.
   *
   * ⚠️ Injected rather than imported so this job can be tested without a live
   * scheduler, and so the ONE place that decides what "run attacks-sync" means
   * stays the scheduler.
   */
  runJob?: (name: string) => Promise<unknown>
}

/**
 * Wars that have ended and are not finished being wrapped up.
 *
 * ⚠️ `end_at` is bigint epoch SECONDS, unlike almost every other timestamp
 * here. ⚠️ And `state = 'queued'` is excluded, which is what makes a re-run
 * safe: a war that already succeeded is never looked at again.
 */
async function warsNeedingWrapUp(db: pg.Pool) {
  const res = await db.query(
    `SELECT w.id, w.end_at, s.state, s.attempts,
            (extract(epoch from s.first_seen_at) * 1000)::bigint AS first_seen_ms
       FROM ranked_wars w
       LEFT JOIN war_wrap_up_state s ON s.war_id = w.id
      WHERE w.end_at IS NOT NULL AND w.end_at > 0
        AND (s.state IS NULL OR s.state = 'waiting')
      ORDER BY w.end_at DESC
      LIMIT $1`,
    [MAX_WARS_PER_RUN],
  )
  return res.rows
}

async function settingFor(db: pg.Pool): Promise<unknown> {
  const res = await db.query(
    `SELECT value FROM faction_settings WHERE key = $1`, [WRAP_UP_SETTING],
  )
  return res.rows[0]?.value ?? null
}

async function dibsEnabled(db: pg.Pool): Promise<boolean> {
  const res = await db.query(
    `SELECT enabled FROM scraper_jobs WHERE job_name = $1`, [DIBS_SUMMARY_JOB],
  )
  return res.rows[0]?.enabled === true
}

/** Everything the verdict depends on, read after the scrapes have run. */
async function gather(db: pg.Pool, warId: number, startAt: number, endAt: number) {
  const [contrib, attacks, dibsState] = await Promise.all([
    db.query('SELECT count(*)::int AS n FROM war_member_contributions WHERE war_id = $1', [warId]),
    db.query(
      'SELECT count(*)::int AS n FROM faction_attacks WHERE started >= $1 AND started <= $2',
      [startAt, endAt],
    ),
    db.query('SELECT war_id FROM war_dibs_summary_state WHERE war_id = $1', [warId]),
  ])
  return {
    contributionRows: contrib.rows[0].n as number,
    attackRows: attacks.rows[0].n as number,
    dibsSummarised: (dibsState.rowCount ?? 0) > 0,
  }
}

/**
 * Queue every current member.
 *
 * ⚠️ **Every member, participants and non-participants alike, termed wars
 * included.** MonChoon: *"on a termed war most people do participate… if no one
 * particiapted thats even more important, since it will determine whether we
 * keep them or kick them, so its not just noise."* A zero row is a keep/kick
 * input, not padding.
 *
 * ⚠️ **DO NOTHING on conflict, NOT the admin route's DO UPDATE.** The admin
 * endpoint re-opens an already-posted entry on purpose, because somebody asking
 * for one member's report again means "correct it". A wrap-up re-run means
 * "finish what you could not finish", and re-opening there would re-post the
 * whole roster — ~94 edits nobody asked for.
 */
async function queueRoster(db: pg.Pool, warId: number): Promise<number> {
  const res = await db.query(
    `INSERT INTO member_thread_outbox (member_id, kind, subject, payload)
     SELECT m.member_id, $2, $3,
            jsonb_build_object('war_id', $1::bigint, 'member_name', m.member_name)
       FROM members m
      WHERE m.is_current = true
     ON CONFLICT (member_id, kind, subject) DO NOTHING`,
    [warId, OUTBOX_KINDS.war_report, warSubject(warId)],
  )
  return res.rowCount ?? 0
}

async function record(
  db: pg.Pool, warId: number, verdict: WrapUpVerdict, queued: number | null,
): Promise<void> {
  const state = verdict.action === 'queue' ? 'queued'
    : verdict.action === 'fail' ? 'failed' : 'waiting'
  await db.query(
    `INSERT INTO war_wrap_up_state (war_id, state, last_attempt_at, attempts,
                                    last_error, queued_members, completed_at)
     VALUES ($1, $2, now(), 1, $3, $4, $5)
     ON CONFLICT (war_id) DO UPDATE
        SET state = EXCLUDED.state,
            last_attempt_at = now(),
            attempts = war_wrap_up_state.attempts + 1,
            last_error = EXCLUDED.last_error,
            queued_members = COALESCE(EXCLUDED.queued_members, war_wrap_up_state.queued_members),
            completed_at = EXCLUDED.completed_at`,
    [warId, state, verdict.action === 'queue' ? null : verdict.reason, queued,
     verdict.action === 'queue' ? new Date() : null],
  )
}

export async function warWrapUpJob(deps: WrapUpDeps): Promise<RunResult> {
  const { db, runJob } = deps
  const wars = await warsNeedingWrapUp(db)
  if (wars.length === 0) return { rows: 0, details: { wars: 0 } }

  const window = retryWindowMinutes(await settingFor(db))
  const dibs = await dibsEnabled(db)
  const outcomes: Array<Record<string, unknown>> = []
  let queuedTotal = 0

  for (const w of wars) {
    const warId = Number(w.id)

    // ⚠️ Stamp `first_seen_at` BEFORE the scrapes, so the retry window is
    // measured from when we first noticed the war ended rather than from a
    // successful pass. Without this a war with no state row yet would compute
    // `minutesWaiting = 0` on every run and never exhaust its window.
    await db.query(
      `INSERT INTO war_wrap_up_state (war_id) VALUES ($1) ON CONFLICT (war_id) DO NOTHING`,
      [warId],
    )
    const seen = await db.query(
      `SELECT (extract(epoch from first_seen_at) * 1000)::bigint AS ms
         FROM war_wrap_up_state WHERE war_id = $1`,
      [warId],
    )
    const firstSeenMs = Number(seen.rows[0]?.ms ?? Date.now())

    // ⚠️ IN ORDER. dibs-summary is last because it needs the attacks; see the
    // header. A failure in one scrape does not abort the wrap-up — the verdict
    // below is computed from what is actually in the tables, which is the only
    // thing that matters.
    if (runJob) {
      for (const name of ['attacks-sync', 'revives-sync', 'wars-sync']) {
        try {
          await runJob(name)
        } catch (err) {
          // ⚠️ Swallowed deliberately. The gate is "is the data there", not
          // "did every scrape report success" — a scrape that failed after
          // writing is still a success for our purposes, and one that failed
          // without writing shows up as a missing source.
          outcomes.push({ war_id: warId, scrape_failed: name, error: String(err) })
        }
      }
      if (dibs) {
        try {
          await runJob(DIBS_SUMMARY_JOB)
        } catch (err) {
          outcomes.push({ war_id: warId, scrape_failed: DIBS_SUMMARY_JOB, error: String(err) })
        }
      }
    }

    const warRow = await db.query(
      `SELECT start_at, end_at, report_unavailable FROM ranked_wars WHERE id = $1`, [warId],
    )
    const row = warRow.rows[0]
    if (!row) continue

    const facts = await gather(db, warId, Number(row.start_at), Number(row.end_at))
    const verdict = assessWrapUp({
      reportUnavailable: row.report_unavailable === true,
      ...facts,
      dibsEnabled: dibs,
      minutesWaiting: (Date.now() - firstSeenMs) / 60_000,
      retryWindowMinutes: window,
    })

    let queued: number | null = null
    if (verdict.action === 'queue') {
      queued = await queueRoster(db, warId)
      queuedTotal += queued
    }
    await record(db, warId, verdict, queued)

    // ⚠️ A failure is LOUD. This is the only signal a human gets that a war's
    // reports are not coming, and the alternative — a row in a table nobody
    // opens — is the silent failure the issue is about.
    if (verdict.action === 'fail') {
      console.error(`[war-wrap-up] war ${warId} FAILED: ${verdict.reason}`)
    }
    outcomes.push({ war_id: warId, action: verdict.action, reason: verdict.reason, queued })
  }

  return { rows: queuedTotal, details: { wars: wars.length, window_minutes: window, outcomes } }
}
