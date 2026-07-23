// #186: scheduled auto-resolution of competitions. Reuses the scraper-cron
// machinery — registered like any other job, enabled by the admin — and drives
// the shared resolve engine: close a fixed competition once its end day has
// passed (and its final-day snapshot has landed), draw a rolling one every
// resolve_interval_days. All the due/gate logic lives in runAutoResolve.
import type { JobDeps } from './itemsSync.js'
import { runAutoResolve } from '../../competitions.js'

export async function competitionsResolveJob(deps: JobDeps) {
  const resolved = await runAutoResolve(deps.db)
  return { rows: resolved }
}
