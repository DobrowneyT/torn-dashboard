import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarPlus, CalendarMinus, LoaderCircle, RefreshCw } from 'lucide-react'
import { apiGet, apiPatch, apiPost, apiPut, apiDelete } from '../../utils/apiClient'
import { useAuth } from '../../contexts/AuthContext'
import {
  hourRows, gapsAhead, gapSentence, coverage, viewerZone, GAP_HORIZON_HOURS,
} from '../../utils/chainWatch'
import { parseDbTime } from '../../utils/time'
import SignUpGrid from './SignUpGrid'
import MemberPicker from './MemberPicker'
import NewEventForm from './NewEventForm'
import PayoutPanel from './PayoutPanel'

/**
 * Members → Chain Watch (#772).
 *
 * Two tabs, and the split is the design rather than a layout preference:
 * **History is a different job for a different person.** Leadership
 * adjudicating flags and paying out wants a table and a queue; a member opening
 * a Discord link at 04:00 wants a grid they can claim into and nothing else.
 * The one-grid alternative was prototyped and had nowhere to put the payout
 * except bolted above the roster.
 *
 * ⚠️ Elapsed hours are hidden from the SIGN-UP view, never dropped from the
 * data — they are what gets paid, and #773 needs exactly the rows a member does
 * not.
 *
 * ⚠️ "Elapsed" is decided by the SERVER's clock, which travels with the
 * payload. A viewer with a skewed system time would otherwise be shown
 * still-claimable hours as gone — and that viewer is the half-asleep person at
 * 3am this page exists for.
 */
export default function ChainWatchSection({ isLeadership }) {
  const { user, isVisitor } = useAuth()
  // The `isLeadership` prop deliberately includes visitors so they can SEE
  // leadership surfaces read-only (App.jsx). Writing is a different question:
  // the server refuses a visitor on every one of these routes (#771), so
  // offering the controls only produces a 403 they cannot act on.
  const canEdit = isLeadership && !isVisitor

  const [tab, setTab] = useState('signup')
  const [payload, setPayload] = useState(null)
  const [roster, setRoster] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busyKey, setBusyKey] = useState(null)
  const [picking, setPicking] = useState(null)
  const [creating, setCreating] = useState(false)
  const zone = useMemo(() => viewerZone(), [])

  const load = useCallback(async (opts = {}) => {
    if (!opts.quiet) setLoading(true)
    try {
      const list = await apiGet('/api/chain-events')
      const live = list.events?.[0] ?? null
      if (!live) { setPayload(null); setError(null); return }
      const full = await apiGet(`/api/chain-events/${live.id}`)
      setPayload(full)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!canEdit) return
    apiGet('/api/members').then((r) => setRoster(r.members ?? [])).catch(() => setRoster([]))
  }, [canEdit])

  // ⚠️ The server's now, not the browser's.
  const nowMs = useMemo(() => {
    const d = parseDbTime(payload?.server_now)
    return d ? d.getTime() : Date.now()
  }, [payload])

  const rows = useMemo(
    () => hourRows(payload?.event ?? null, payload?.signups ?? [], nowMs),
    [payload, nowMs])
  const upcoming = useMemo(() => rows.filter((r) => !r.isPast), [rows])
  const elapsed = useMemo(() => rows.filter((r) => r.isPast).reverse(), [rows])
  const gaps = useMemo(() => gapsAhead(rows, nowMs), [rows, nowMs])
  const cover = useMemo(() => coverage(rows, nowMs), [rows, nowMs])
  const sentence = gapSentence(gaps)

  /** Every write goes through here so one 409 story is told in one place. */
  const run = useCallback(async (key, fn) => {
    setBusyKey(key); setNotice(null)
    try {
      await fn()
      await load({ quiet: true })
    } catch (e) {
      // ⚠️ Two people racing for the last graveyard slot is the NORMAL case,
      // not an error state: say what happened and refresh the row rather than
      // showing a failure the reader cannot act on.
      if (e.status === 409) {
        setNotice(e.message)
        await load({ quiet: true })
      } else {
        setNotice(e.message ?? 'That did not work.')
      }
    } finally {
      setBusyKey(null)
    }
  }, [load])

  const eventId = payload?.event?.id
  const claim = (row, i) => run(`${row.hourIso}:${i}`, () =>
    apiPost(`/api/chain-events/${eventId}/signups`, { hour_start: row.hourIso, slot_index: i }))

  const release = (row, i) => run(`${row.hourIso}:${i}`, () =>
    apiDelete(`/api/chain-events/${eventId}/signups/${encodeURIComponent(row.hourIso)}/${i}`))

  const assign = (row, i) => setPicking({ row, slotIndex: i })

  // ⚠️ A leader's answer to a flag. The app records; it never adjudicates.
  const decide = (signup, decision) =>
    run(`${signup.hour_start}:${signup.slot_index}:decide`, () =>
      apiPatch(
        `/api/chain-events/${eventId}/signups/${encodeURIComponent(signup.hour_start)}/${signup.slot_index}/decision`,
        { decision }))

  // ⚠️ The same PATCH the event form uses. It is LEAD-gated and validates
  // every field on the server; the settings panel adds no new authority.
  //
  // ⚠️ Reloads afterwards rather than patching state locally: every figure on
  // the payout sheet is DERIVED from these values, so a stale copy would show
  // numbers that disagree with what was just saved.
  // ⚠️ Goes through `run` like every other write, so it shares the busy key,
  // the 409 handling and the quiet reload. A bespoke path here would be the one
  // that forgets to refresh.
  //
  // ⚠️ The reload matters more than usual: every figure on the payout sheet is
  // DERIVED from these settings, so a stale copy would show numbers that
  // disagree with what was just saved.
  const updateEvent = (patch) =>
    run('event:settings', () => apiPatch(`/api/chain-events/${eventId}`, patch))

  // ⚠️ Blanket pay switch for one member across the whole event. Goes through
  // `run` like every other write, so it shares the busy key and the reload —
  // the payout figures are all derived, so a stale copy would show numbers that
  // disagree with what was just saved.
  const setEligible = (row, eligible) =>
    run(`eligible:${row.member_id}`, () =>
      apiPatch(`/api/chain-events/${eventId}/members/${row.member_id}/eligibility`, { eligible }))

  const pick = (memberId) => {
    const { row, slotIndex } = picking
    setPicking(null)
    const path = `/api/chain-events/${eventId}/signups`
    return run(`${row.hourIso}:${slotIndex}`, () =>
      row.slots[slotIndex]
        ? apiPut(`${path}/${encodeURIComponent(row.hourIso)}/${slotIndex}`, { member_id: memberId })
        : apiPost(path, { hour_start: row.hourIso, slot_index: slotIndex, member_id: memberId }))
  }

  // ⚠️ No confirmation on Add: it is harmless, reversible, and the most
  // frequent action on the page. The reload is quiet, so the reader keeps their
  // scroll position — adding day 4 while reading day 2 must not throw them back
  // to the top.
  const addDay = () => run('add-day', () => apiPost(`/api/chain-events/${eventId}/days`, {}))

  const removeDay = () => {
    if (!window.confirm('Remove the last day from the window?')) return
    // ⚠️ The server refuses when the trailing day still holds watchers, and
    // names them. Surface that by name rather than as a generic failure.
    return run('remove-day', async () => {
      try {
        await apiDelete(`/api/chain-events/${eventId}/days/last`)
      } catch (e) {
        const held = e.body?.held
        if (held?.length) {
          const who = [...new Set(held.map((h) => h.member_name ?? h.member_id))].join(', ')
          const err = new Error(`${held.length} slot${held.length === 1 ? '' : 's'} still claimed on the last day — ${who}.`)
          err.status = e.status
          throw err
        }
        throw e
      }
    })
  }

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
      <LoaderCircle className="h-4 w-4 animate-spin" /> Loading the chain watch…
    </div>
  }
  if (error) return <p className="card text-sm text-red-600 dark:text-red-400">{error}</p>
  const createEvent = (body) => {
    setCreating(false)
    return run('create-event', () => apiPost('/api/chain-events', body))
  }

  if (!payload?.event) {
    return (
      <div className="card space-y-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No chain watch is open yet.
          {canEdit ? ' Open one and members can start claiming hours.' : ''}
        </p>
        {notice && <p className="text-sm text-amber-700 dark:text-amber-300">{notice}</p>}
        {canEdit && (
          <button type="button" className="btn-primary text-sm" data-testid="open-new-event"
            onClick={() => setCreating(true)}>
            Open a chain watch
          </button>
        )}
        {creating && (
          <NewEventForm onCreate={createEvent} onClose={() => setCreating(false)}
            busy={busyKey === 'create-event'} />
        )}
      </div>
    )
  }

  const event = payload.event
  const jump = (iso) => document.getElementById(`hour-${iso}`)?.scrollIntoView({ block: 'center' })

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">{event.title}</h2>
          <div className="flex items-center gap-2">
            {canEdit && (
              <>
                <button type="button" onClick={addDay} disabled={busyKey === 'add-day'}
                  className="btn-secondary flex items-center gap-1 text-xs" data-testid="add-day">
                  <CalendarPlus className="h-3.5 w-3.5" /> Add a day
                </button>
                <button type="button" onClick={removeDay} disabled={busyKey === 'remove-day'}
                  className="btn-secondary flex items-center gap-1 text-xs" data-testid="remove-day">
                  <CalendarMinus className="h-3.5 w-3.5" /> Remove last day
                </button>
              </>
            )}
            <button type="button" onClick={() => load()} aria-label="Refresh"
              className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-400">Next gap</dt>
            <dd className="font-mono tabular-nums" data-testid="next-gap">
              {cover.nextGap
                ? <button type="button" className="hover:underline" onClick={() => jump(cover.nextGap.hourIso)}>
                    {cover.nextGap.tct} TCT
                  </button>
                : 'none'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-400">
              Open slots (next {cover.horizonHours}h)
            </dt>
            <dd className="font-mono tabular-nums" data-testid="open-ahead">{cover.openInHorizon}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-gray-400">Projected 100k</dt>
            {/* #774 derives this from how fast the chain is actually climbing.
                Until it lands, say so plainly rather than showing a number
                nobody should trust. */}
            <dd className="text-gray-400" data-testid="projection">not enough chain yet</dd>
          </div>
        </dl>
      </div>

      {notice && (
        <p className="card border-amber-300 text-sm text-amber-700 dark:text-amber-300" role="status">{notice}</p>
      )}

      <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700">
        {[
          ['signup', 'Sign up', `${cover.openInHorizon} open`],
          ['history', 'History', `${cover.elapsedHours} hours`],
        ].map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex items-baseline gap-2 border-b-2 px-4 py-2 text-sm font-medium ${
              tab === id
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400'
            }`}>
            {label}
            <span className="rounded bg-gray-100 px-1.5 text-[11px] tabular-nums text-gray-500 dark:bg-slate-700 dark:text-gray-400">
              {count}
            </span>
          </button>
        ))}
      </div>

      {tab === 'signup' ? (
        <>
          {sentence && (
            <div className="card flex items-start gap-3 border-amber-300 bg-amber-50 dark:bg-amber-900/20"
              data-testid="gap-alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm">
                {sentence}{' '}
                <button type="button" className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => jump(gaps[0].hourIso)}>
                  Go to the first gap
                </button>
              </p>
            </div>
          )}
          <div className="card overflow-hidden p-0">
            <SignUpGrid
              rows={upcoming} event={event} meId={user?.id} canEdit={canEdit} zone={zone}
              onClaim={claim} onRelease={release} onAssign={assign} busyKey={busyKey}
              emptyNote="Every hour of this event has already run."
            />
          </div>
        </>
      ) : (
        <div className="space-y-4">
          {canEdit && (
            <PayoutPanel
              event={event} signups={payload.signups ?? []} removed={payload.removed ?? []}
              outcome={payload.outcome} canEdit={canEdit} onDecide={decide} busyKey={busyKey}
              onUpdateEvent={updateEvent} onSetEligible={setEligible}
            />
          )}
          <div className="card overflow-hidden p-0">
            <SignUpGrid
              rows={elapsed} event={event} meId={user?.id} canEdit={canEdit} zone={zone}
              onClaim={claim} onRelease={release} onAssign={assign} busyKey={busyKey}
              emptyNote="Nothing has run yet."
            />
          </div>
        </div>
      )}

      {picking && (
        <MemberPicker
          roster={roster} row={picking.row} slotIndex={picking.slotIndex}
          onPick={pick} onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}
