/**
 * Torn event start windows (#459): your own opt-in, and the faction's shape.
 *
 * ⚠️ The opt-in is the feature. Reading `/user/calendar` is not covered by the
 * consent members gave when they enrolled their key, so this scope is granted
 * separately, defaults to off, and withdrawing it **deletes** the stored value
 * rather than hiding it.
 *
 * ⚠️ Members who declined are simply absent from the list — never present with
 * a dash. A row that says "did not share" publishes a decision that is nobody
 * else's business, and it turns an opt-in into a public one.
 */
import { useCallback, useEffect, useState } from 'react'
import { Clock, LoaderCircle } from 'lucide-react'
import { apiGet, apiPut } from '../../utils/apiClient'
import { eventWindowRows, coverageByHour, windowCoverage } from '../../utils/eventWindows'
import { fmtAgo } from '../../utils/time'

export default function EventWindowPanel({ windows, onChanged }) {
  const [me, setMe] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const loadMe = useCallback(() => {
    apiGet('/api/calendar/event-window/me')
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  useEffect(() => { loadMe() }, [loadMe])

  async function setGranted(granted) {
    setBusy(true)
    setError(null)
    try {
      await apiPut('/api/calendar/event-window/me', { granted })
      loadMe()
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Could not update')
    } finally {
      setBusy(false)
    }
  }

  const rows = eventWindowRows(windows)
  const buckets = coverageByHour(windows)
  const coverage = windowCoverage(windows)

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="font-semibold flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-gray-400" /> Event start windows
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          During a Torn event everyone gets 48 hours, opening at their own chosen hour. This is
          where the faction&apos;s windows sit.
        </p>
      </div>

      {/* Your own switch. Three states, because "no key" needs different words
          from "key, no scope". */}
      {me && (
        <div className="rounded border border-gray-200 dark:border-slate-700 px-3 py-2 text-sm">
          {!me.has_key ? (
            <span className="text-gray-500 dark:text-gray-400">
              Enrol an API key to share your event start time.
            </span>
          ) : me.granted ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                You are sharing your start time
                {me.start_time
                  ? <> — <strong>{me.start_time}</strong>{me.fetched_at && <span className="text-xs text-gray-500"> (read {fmtAgo(me.fetched_at)})</span>}</>
                  : <span className="text-gray-500 dark:text-gray-400"> — not read yet; the daily job will pick it up</span>}
              </span>
              <button
                onClick={() => setGranted(false)}
                disabled={busy}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Stop sharing
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-gray-600 dark:text-gray-300">
                Share your event start time with the faction? Your key is used once a day for a
                single extra call, <span className="font-medium">GET /user/calendar</span>, which
                returns only that time.
              </span>
              <button onClick={() => setGranted(true)} disabled={busy} className="btn-primary text-xs px-3 py-1.5">
                {busy ? <LoaderCircle className="w-3 h-3 animate-spin" /> : 'Share'}
              </button>
            </div>
          )}
          {me.granted && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Stopping deletes the stored time — it is not just hidden.
            </p>
          )}
        </div>
      )}

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Nobody has shared a start time yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {buckets.map((b) => (
              <div
                key={b.hour}
                className="text-xs rounded px-2 py-1 bg-gray-100 dark:bg-slate-700"
                title={b.members.map((m) => m.memberName).join(', ')}
              >
                <span className="font-medium tabular-nums">{b.label}</span>
                <span className="text-gray-500 dark:text-gray-400"> · {b.members.length}</span>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.memberId} className="border-b border-gray-100 dark:border-slate-700/50 last:border-0">
                    <td className="py-1.5 pr-3">{r.memberName}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {/* A stored string we could not read shows a dash, not
                          the raw text — passing it through would present junk
                          as a time. */}
                      {r.label ?? <span className="text-gray-400" title={`unreadable value: ${r.raw}`}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {coverage.shared} member{coverage.shared === 1 ? '' : 's'} sharing
            {coverage.readable !== coverage.shared && `, ${coverage.shared - coverage.readable} unreadable`}.
            Only members who opted in appear here.
          </p>
        </>
      )}
    </div>
  )
}
