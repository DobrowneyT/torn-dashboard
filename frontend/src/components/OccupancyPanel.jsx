/**
 * The #389 observation panel: what the poller actually watched, versus what the
 * legacy calculation inferred.
 *
 * This exists to be READ, not acted on. MonChoon, 2026-08-12: "I will observe
 * the data for a few weeks until I can verify its working and then we can push
 * it." Nothing here moves money — `ticketTimeSpent` is still the legacy figure
 * and stays that way until that call is made deliberately.
 *
 * So the panel's job is to make the comparison honest enough to decide on, and
 * its most important behaviour is staying quiet when it has nothing to say:
 * a window the poller never covered renders as "not watched", never as zeroes.
 */
import { useState } from 'react'
import { ChevronRight, Eye, EyeOff, AlertTriangle, CheckCircle2 } from 'lucide-react'
import {
  coverageVerdict,
  driftVerdict,
  memberDivergences,
  occupancySummary,
  formatDuration,
  formatDelta,
} from '../utils/occupancyReport'
import { formatTimeHours } from '../utils/payoutCalculations'

/** Epoch seconds → "Mon 4 Aug, 14:32". Torn timestamps, so local is fine. */
function stamp(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, {  // db-time-safe: epoch seconds, not a DB string
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

const STATES = {
  unwatched: {
    Icon: EyeOff,
    tone: 'text-gray-500 dark:text-gray-400',
    chip: 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300',
    label: 'Not watched',
  },
  degraded: {
    Icon: AlertTriangle,
    tone: 'text-amber-600 dark:text-amber-400',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    label: 'Gaps in coverage',
  },
  watched: {
    Icon: CheckCircle2,
    tone: 'text-green-600 dark:text-green-400',
    chip: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    label: 'Watched',
  },
}

export default function OccupancyPanel({ results }) {
  const [open, setOpen] = useState(false)

  const coverage = coverageVerdict(results?.occupancyCoverage, results?.windowStart, results?.windowEnd)
  // No coverage object at all: a payout saved before this existed. It makes no
  // claim about occupancy, so the panel makes none either.
  if (coverage.state === 'unavailable') return null

  const drift = driftVerdict(results?.occupancyDrift)
  const summary = occupancySummary(results?.members)
  const divergences = memberDivergences(results?.members)
  const { Icon, tone, chip, label } = STATES[coverage.state]

  return (
    <div className="card">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 text-left"
        aria-expanded={open}
      >
        <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Eye className="w-4 h-4 text-gray-400" />
        <h3 className="text-lg font-semibold">Observed occupancy</h3>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${chip}`}>{label}</span>
        {summary && (
          <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto tabular-nums">
            {formatTimeHours(summary.observed)} observed vs {formatTimeHours(summary.inferred)} counted
          </span>
        )}
      </button>

      {open && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Diagnostic only — payouts on this page are still calculated from the existing time
            figures. These numbers are here to be checked against them over a few weeks before
            observation is trusted with money.
          </p>

          {/* Coverage */}
          <div>
            <div className={`flex items-center gap-2 font-medium ${tone}`}>
              <Icon className="w-4 h-4" />
              {coverage.state === 'unwatched' && 'The poller did not run during this window'}
              {coverage.state === 'degraded' && `${formatDuration(coverage.missingSeconds)} of this window went unwatched`}
              {coverage.state === 'watched' && `Polled continuously — ${coverage.pollCount.toLocaleString()} of ~${coverage.expectedPolls.toLocaleString()} expected checks`}
            </div>

            {coverage.state === 'unwatched' && (
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                No observations exist for these dates, which is not the same as observing that
                nobody was in a crime. The comparison below is unavailable rather than zero.
              </p>
            )}

            {coverage.state === 'watched' && coverage.minorGaps > 0 && (
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {coverage.minorGaps} short {coverage.minorGaps === 1 ? 'gap' : 'gaps'} totalling{' '}
                {formatDuration(coverage.missingSeconds)} — within the tolerance for a late tick.
              </p>
            )}

            {coverage.state === 'degraded' && (
              <>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  During a gap, anyone who left a crime keeps accruing time until the poller
                  resumes. Observed figures for this window are upper bounds.
                </p>
                <div className="mt-2 space-y-1">
                  {coverage.gaps.slice(0, 8).map(([from, to]) => (
                    <div key={`${from}-${to}`} className="flex justify-between gap-3 text-xs text-amber-700 dark:text-amber-400">
                      <span className="truncate">{stamp(from)} → {stamp(to)}</span>
                      <span className="whitespace-nowrap tabular-nums">{formatDuration(to - from)}</span>
                    </div>
                  ))}
                  {coverage.gaps.length > 8 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      + {coverage.gaps.length - 8} more
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Poller health against Torn's own joined_at */}
          <div className="pt-3 border-t border-gray-100 dark:border-slate-700">
            <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
              Poller accuracy
            </div>
            {drift.state === 'no-evidence' && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                No joins witnessed in this window yet, so there is nothing to check the poller
                against. Not a pass.
              </p>
            )}
            {drift.state !== 'no-evidence' && (
              <p className={`text-xs ${drift.state === 'ok' ? 'text-gray-600 dark:text-gray-400' : 'text-amber-600 dark:text-amber-400'}`}>
                Across {drift.count.toLocaleString()} witnessed joins, our first sighting sat a
                median of {formatDuration(drift.median)} after Torn&apos;s own join time
                (95th percentile {formatDuration(drift.p95)}, worst {formatDuration(drift.max)}).{' '}
                {drift.state === 'ok'
                  ? 'Within the two minutes expected.'
                  : 'Beyond the two minutes expected — the poller is missing ticks, which makes stints end later than they should.'}
              </p>
            )}
          </div>

          {/* The comparison itself */}
          {summary && (
            <div className="pt-3 border-t border-gray-100 dark:border-slate-700">
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
                Observed vs counted, across {summary.memberCount} members
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <Figure label="Counted" value={formatTimeHours(summary.inferred)} />
                <Figure label="Observed" value={formatTimeHours(summary.observed)} />
                <Figure
                  label="Difference"
                  value={formatDelta(summary.delta)}
                  tone={Math.abs(summary.delta) > summary.inferred * 0.05 ? 'text-amber-600 dark:text-amber-400' : undefined}
                />
              </div>

              {divergences.length > 0 && (
                <div className="mt-3">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-1">
                    Largest disagreements
                  </div>
                  <div className="space-y-1">
                    {divergences.slice(0, 10).map((row) => (
                      <div key={row.userId} className="flex items-center justify-between gap-3 text-xs">
                        <span className="truncate">{row.name || row.userId}</span>
                        <span className="flex items-center gap-2 whitespace-nowrap tabular-nums text-gray-500 dark:text-gray-400">
                          <span>{formatTimeHours(row.inferred)} counted</span>
                          <span>→</span>
                          <span>{formatTimeHours(row.observed)} seen</span>
                          <span className={row.direction === 'over-inferred'
                            ? 'text-red-600 dark:text-red-400 font-medium'
                            : 'text-gray-500 dark:text-gray-400'}>
                            {formatDelta(row.delta)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                  {divergences.length > 10 && (
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      + {divergences.length - 10} more
                    </div>
                  )}
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Red means the existing calculation credited more time than we ever saw — the
                    shape of the bug this is here to catch. Grey means the poller saw less because
                    it was not running for part of the stint.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Figure({ label, value, tone }) {
  return (
    <div className="rounded bg-gray-50 dark:bg-slate-700/40 py-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone || ''}`}>{value}</div>
    </div>
  )
}
