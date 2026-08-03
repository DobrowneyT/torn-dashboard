// member_stat_samples retention (#227). The intraday sample series (six writes
// a day per member) would grow without bound, so this once-daily job prunes
// samples older than the retention window — EXCEPT any sample still needed to
// resolve a competition. A sample is protected while it falls within the window
// of a competition that hasn't been resolved yet (no competition_results row);
// once a competition is resolved its frozen standings live in
// competition_results and the underlying samples are free to age out.
import type { JobDeps } from './itemsSync.js'
import type { RunResult } from '../runLog.js'

const RETENTION_DAYS = 90

export async function statsSamplesPruneJob({ db }: JobDeps): Promise<RunResult> {
  const res = await db.query(
    `DELETE FROM member_stat_samples s
     WHERE s.captured_at < now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM competitions c
         WHERE c.window_start IS NOT NULL AND c.window_end IS NOT NULL
           AND s.captured_at::date BETWEEN c.window_start::date AND c.window_end::date
           AND NOT EXISTS (SELECT 1 FROM competition_results r WHERE r.competition_id = c.id)
       )`,
    [String(RETENTION_DAYS)]
  )
  const pruned = res.rowCount ?? 0
  return { rows: pruned, details: { pruned, retention_days: RETENTION_DAYS } }
}
