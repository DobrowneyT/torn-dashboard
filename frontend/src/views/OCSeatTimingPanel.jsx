import { Clock } from 'lucide-react'

/**
 * When our members actually take their seats, against when the seat is needed
 * (#744).
 *
 * ⚠️ This is the most actionable number in the whole person-day line of work,
 * and until now it lived in an endpoint nothing called. `slackPerSeat` (#687's
 * `g`) reconciles the formula with reality in one figure, which means a faction
 * whose members queue up at the front and one whose crimes simply run long
 * produce the same value — and only the first is a behaviour anyone can change
 * tomorrow.
 *
 * A crime completes `24h × n` after the first join and every slot is open from
 * the start, so seat `s` is not needed until hour `24 × (s − 1)`. A member
 * seated before that is capacity removed from every other crime for nothing,
 * because a member cannot be in two organized crimes at once.
 *
 * ⚠️ Its own file, per the v3.97.0 crash: a panel declared inside the view it
 * serves and referenced from that view's callbacks is a temporal-dead-zone
 * throw that builds cleanly and dies on render.
 */

const h = (v) => `${Math.round(v * 10) / 10}h`

/** Bar width as a share of the longest ideal hour, so seats share one scale. */
const pct = (v, max) => (max > 0 ? Math.max(1, Math.min(100, (v / max) * 100)) : 0)

export function SeatTimingPanel({ timing }) {
  if (!timing?.measured) return null

  // Worst first: the role count with the most to free is the one to read.
  const groups = Object.values(timing.byRoleCount ?? {})
    .filter((g) => (g.seats?.length ?? 0) > 0)
    .sort((a, b) => b.earlyHoursTotal - a.earlyHoursTotal)
  if (groups.length === 0) return null

  const lead = timing.headline

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-gray-400" />
        <h3 className="font-semibold text-sm">When we take our seats</h3>
        <span className="text-xs text-gray-400 dark:text-gray-500">
          median over {timing.window_days} days
        </span>
      </div>

      {lead ? (
        <p data-testid="seat-headline" className="text-sm text-gray-700 dark:text-gray-300">
          Our <strong>{ordinal(lead.seat)} seat</strong> in a {lead.roles}-role crime is taken{' '}
          <strong>{h(lead.earlyHours)} before it is needed</strong> — about{' '}
          <strong>{lead.earlyPersonDays.toFixed(1)} person-days</strong> per crime, freed with no
          training and no scope cost.
        </p>
      ) : (
        <p data-testid="seat-on-track" className="text-sm text-gray-700 dark:text-gray-300">
          Our seats are taken on schedule — nobody is sitting down before they are needed.
        </p>
      )}

      {groups.map((g) => {
        const scale = Math.max(...g.seats.map((s) => Math.max(s.idealHours, s.medianHours)), 1)
        return (
          <div key={g.roles} className="space-y-1">
            <div className="flex items-baseline justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{g.roles}-role crimes</span>
              {g.earlyPersonDays > 0 && (
                <span className="tabular-nums">{g.earlyPersonDays.toFixed(1)} person-days early</span>
              )}
            </div>

            {g.seats.map((s) => (
              <div key={s.seat} data-testid={`seat-row-${s.seat}`}
                className="flex items-center gap-2 text-[11px]">
                <span className="w-10 shrink-0 text-gray-500 dark:text-gray-400">
                  seat {s.seat}
                </span>
                {/* Two marks on one scale: where the seat is needed, and where
                    it is actually taken. The distance between them IS the
                    finding, so they share an axis rather than sitting in
                    separate columns. */}
                <span className="relative flex-1 h-3 rounded bg-gray-100 dark:bg-slate-700 min-w-[80px]">
                  <span
                    className="absolute top-0 bottom-0 w-px bg-gray-400 dark:bg-slate-400"
                    style={{ left: `${pct(s.idealHours, scale)}%` }}
                    aria-hidden="true"
                  />
                  <span
                    className={`absolute top-0.5 bottom-0.5 rounded-sm ${
                      s.earlyHours > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{
                      left: `${Math.min(pct(s.idealHours, scale), pct(s.medianHours, scale))}%`,
                      width: `${Math.max(1, Math.abs(pct(s.medianHours, scale) - pct(s.idealHours, scale)))}%`,
                    }}
                    aria-hidden="true"
                  />
                </span>
                <span className="w-24 shrink-0 text-right tabular-nums text-gray-400 dark:text-gray-500">
                  {h(s.medianHours)} <span className="text-gray-300 dark:text-gray-600">/ {h(s.idealHours)}</span>
                </span>
                {/* ⚠️ Late is shown, not hidden. capacityx's first two seats are
                    LATE, and a panel drawing only the early side would imply a
                    faction is uniformly early — making the advice wrong for
                    exactly the seats it is wrong about. */}
                <span className={`w-20 shrink-0 text-right tabular-nums ${
                  s.earlyHours > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-600'
                }`}>
                  {s.earlyHours > 0 ? `${h(s.earlyHours)} early` : s.lateHours > 0 ? `${h(s.lateHours)} late` : 'on time'}
                </span>
              </div>
            ))}

            {(g.thinSeats.length > 0 || g.implausibleSeats.length > 0) && (
              // ⚠️ A table missing a seat with no explanation reads as "nobody
              // ever sits there", which is a far more alarming claim than "we
              // could not look".
              <p data-testid="seat-gaps" className="text-[11px] text-gray-400 dark:text-gray-500">
                Not measured:{' '}
                {[...g.thinSeats, ...g.implausibleSeats]
                  .sort((a, b) => a - b)
                  .map((n) => `seat ${n}`)
                  .join(', ')}
                {g.thinSeats.length > 0 && ' — too few runs on record'}
                {g.implausibleSeats.length > 0 && g.thinSeats.length > 0 && ';'}
                {g.implausibleSeats.length > 0 && ' — held implausibly long, excluded'}
                .
              </p>
            )}
          </div>
        )
      })}

      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        A crime finishes <span className="font-mono">24h × roles</span> after the first join
        whatever happens, so a seat taken early buys nothing — it only removes that member from
        every other crime for longer.
      </p>
    </div>
  )
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export default SeatTimingPanel
