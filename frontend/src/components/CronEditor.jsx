import { useMemo, useState } from 'react'
import {
  parseCron, buildCron, describeCron, nextRuns, DAY_NAMES,
} from '../utils/cronSentence'

/**
 * The schedule editor for Global Admin's Scraper Jobs (#756).
 *
 * A sentence — "every day, at minutes 30, at hours 05 and 17" — rather than a
 * cron box. Two reasons it is hand-built rather than `react-js-cron`:
 *
 *  1. ⚠️ **That library is hard-wired to five fields**, so it cannot express
 *     `crime-occupancy` (`30 * * * * *` — every minute at the :30 mark). That
 *     offset is deliberate (#389): every other job fires on :00, and a
 *     per-minute job landing there queues behind the half-hourly sweeps once
 *     every 30 runs. Owning the component makes seconds one more chip row, so
 *     nothing has to move to :00 to fit a widget.
 *  2. It needs Ant Design as a peer dependency, which would be the only Ant
 *     component in a Tailwind app.
 *
 * ⚠️ **It never rewrites a schedule it cannot say.** Anything the sentence has
 * no control for — a day-of-month, a range — drops straight to a text box with
 * the expression untouched. Rounding a cadence off to the nearest thing the UI
 * can express would be worse than the box it replaces, because it would look
 * like it worked.
 */

const MINUTE_CHIPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
const HOUR_CHIPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 17, 19, 20, 21, 22, 23]

const PERIOD_LABELS = [
  ['minute', 'Every minute'],
  ['nminutes', 'Every N minutes'],
  ['hour', 'Every hour'],
  ['nhours', 'Every N hours'],
  ['day', 'Every day'],
  ['week', 'Every week'],
]

const pad = (n) => String(n).padStart(2, '0')

function Chips({ label, values, selected, onToggle, format = pad }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1">
        {values.map((v) => {
          const on = selected.includes(v)
          return (
            <button
              key={v}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(v)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                on
                  ? 'bg-blue-600 border-blue-600 text-white font-bold'
                  : 'bg-white dark:bg-slate-800 border-gray-300 dark:border-slate-600 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              {format(v)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Torn calls a day, when the cadence is fast enough for the number to matter.
 *
 * ⚠️ Two clicks on the seconds row doubles a job's traffic on every tenant at
 * once, against a shared key pool. That is a decision, and it should be made
 * with the figure on screen rather than discovered in the pool later.
 */
function callVolume(state) {
  if (!state) return null
  if (state.period === 'minute') return 1440 * state.secs.length
  if (state.period === 'nminutes') return Math.floor(1440 / Math.max(1, state.n)) * state.secs.length
  return null
}

export default function CronEditor({ value, defaultValue, onSave, onCancel, busy = false }) {
  const parsed = useMemo(() => parseCron(value), [value])
  // A schedule the sentence cannot say opens straight in the text box — see the
  // component note above.
  const [raw, setRaw] = useState(parsed ? null : (value ?? ''))
  const [state, setState] = useState(
    () => parsed ?? { period: 'hour', mins: [0], hours: [0], dows: [1], secs: [0], n: 5 },
  )

  const expr = raw !== null ? raw : buildCron(state)
  const runs = useMemo(() => nextRuns(expr, 4), [expr])
  const volume = raw !== null ? null : callVolume(state)

  // A chip row can never be emptied: cron would reject the expression, the
  // scheduler would silently fall back to the code default, and the page would
  // show a cadence nobody chose.
  const toggle = (key, v) => setState((s) => {
    const cur = s[key]
    const next = cur.includes(v)
      ? (cur.length > 1 ? cur.filter((x) => x !== v) : cur)
      : [...cur, v].sort((a, b) => a - b)
    return { ...s, [key]: next }
  })

  const needMins = ['hour', 'nhours', 'day', 'week'].includes(state.period)
  const needHours = ['day', 'week'].includes(state.period)
  const needN = ['nminutes', 'nhours'].includes(state.period)

  const field = 'px-2 py-1 text-[13px] rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-white'

  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 p-4 space-y-3">
      {raw !== null ? (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Cron expression
            </span>
            <input
              type="text"
              value={raw}
              spellCheck={false}
              onChange={(e) => setRaw(e.target.value)}
              aria-label="Cron expression"
              className={`${field} font-mono w-full max-w-xs`}
            />
          </label>
          {!parsed && (
            <p data-testid="fallback-note" className="text-xs text-amber-700 dark:text-amber-400">
              This schedule is too specific for the picker — it uses a field the
              sentence has no control for. Edited as cron so nothing is lost.
            </p>
          )}
          {parsed && (
            <button
              type="button"
              onClick={() => setRaw(null)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Back to the picker
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm text-gray-500 dark:text-gray-400" htmlFor="cron-period">
              How often
            </label>
            <select
              id="cron-period"
              value={state.period}
              onChange={(e) => setState((s) => ({ ...s, period: e.target.value }))}
              className={field}
            >
              {PERIOD_LABELS.map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
            {needN && (
              <input
                type="number"
                min={1}
                max={state.period === 'nhours' ? 23 : 59}
                value={state.n}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  if (Number.isInteger(n) && n > 0) setState((s) => ({ ...s, n }))
                }}
                aria-label={state.period === 'nhours' ? 'Hours between runs' : 'Minutes between runs'}
                className={`${field} font-mono w-16`}
              />
            )}
          </div>

          {needMins && (
            <Chips label="At minute(s)" values={MINUTE_CHIPS} selected={state.mins}
              onToggle={(v) => toggle('mins', v)} />
          )}
          {needHours && (
            <Chips label="At hour(s)" values={HOUR_CHIPS} selected={state.hours}
              onToggle={(v) => toggle('hours', v)} />
          )}
          {state.period === 'week' && (
            <Chips label="On day(s)" values={[0, 1, 2, 3, 4, 5, 6]} selected={state.dows}
              onToggle={(v) => toggle('dows', v)} format={(d) => DAY_NAMES[d]} />
          )}
          <Chips label="At second(s)" values={MINUTE_CHIPS} selected={state.secs}
            onToggle={(v) => toggle('secs', v)} />
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Leave seconds on 00 unless you are deliberately keeping a job clear
            of the :00 rush.
          </p>
        </>
      )}

      {volume !== null && volume > 1440 && (
        <p data-testid="volume-warning"
          className="text-xs rounded px-2 py-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300">
          ≈ {volume.toLocaleString()} Torn calls a day, per tenant — that is{' '}
          {state.secs.length === 2 ? 'twice a minute' : `${state.secs.length} times a minute`},
          on a shared key pool.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t border-gray-200 dark:border-slate-700 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-mono px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300">
          {expr}
        </span>
        <span>{describeCron(expr)}</span>
        {runs.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {runs.map((r) => (
              <span key={r.toISOString()} data-testid="next-run"
                className="font-mono px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300">
                {pad(r.getUTCHours())}:{pad(r.getUTCMinutes())}
                {r.getUTCSeconds() ? `:${pad(r.getUTCSeconds())}` : ''}
              </span>
            ))}
            <span className="text-gray-400 dark:text-gray-600">TCT</span>
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => onSave(expr)}
          className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium">
          Save
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 text-xs font-medium hover:bg-gray-100 dark:hover:bg-slate-700">
          Cancel
        </button>
        {/* ⚠️ null, not the default's text. Null means "follow the fleet
            default" — a live instruction that keeps tracking it. Writing the
            value back would pin this faction to whatever the default happened
            to be today (scheduleResolution.ts). */}
        {defaultValue != null && (
          <button type="button" disabled={busy} onClick={() => onSave(null)}
            className="px-2.5 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 text-xs font-medium hover:bg-gray-100 dark:hover:bg-slate-700">
            Use default
          </button>
        )}
        {raw === null && (
          <button type="button" onClick={() => setRaw(buildCron(state))}
            className="ml-auto text-xs text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:underline">
            Edit as cron
          </button>
        )}
      </div>
    </div>
  )
}
