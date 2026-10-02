import { useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, Settings } from 'lucide-react'
import { payoutRows, payLink, batchPayLink, raffleRuns, unpayableNote } from '../../utils/chainPayout'
import { tctLabel } from '../../utils/chainWatch'
import SortableTh, { useTableSort } from '../SortableTh.jsx'
import PayoutSettings from './PayoutSettings'

/**
 * Chain Watch payouts.
 *
 * ⚠️ `ticketRange` renders a span (first–last) and sorts on `first`, the
 * number that actually orders the ranges. Sorting the rendered string would
 * order "10–19" before "9" lexically.
 *
 * ⚠️ `tickets` and `ticketRange` only exist when the event ran a raffle, so
 * their headers are conditional — the column config carries them regardless,
 * because a column nobody can click is harmless where a missing one is a
 * silent no-op.
 */
export const CHAIN_PAYOUT_COLUMNS = [
  { key: 'watcher',     kind: 'text',   accessor: (r) => r.member_name },
  { key: 'slots',       kind: 'number', accessor: (r) => r.slots },
  // ⚠️ `bonusSlots`, not `bonus`. Reading the wrong field made every value
  // blank, so the column returned an identical order in BOTH directions — the
  // tie-break alone — and looked like sorting was broken rather than reading
  // nothing. Nothing caught it: an accessor for a field that does not exist is
  // not an error, it is `undefined`.
  { key: 'bonus',       kind: 'number', accessor: (r) => r.bonusSlots },
  { key: 'tickets',     kind: 'number', accessor: (r) => r.tickets },
  { key: 'ticketRange', kind: 'number', accessor: (r) => r.firstTicket },
  { key: 'payout',      kind: 'number', accessor: (r) => r.payout },
  // ⚠️ Not rendered. It exists to reproduce `chainPayout.ORDER`'s tie-break
  // exactly — "slots descending, then member id ascending", which that file
  // states has to be stable.
  { key: 'memberId',    kind: 'text',   accessor: (r) => String(r.member_id) },
]

/**
 * Who gets paid what, and which rows a leader still has to look at (#773).
 *
 * ⚠️ Its own file, per the v3.97.0 crash — a panel declared inside the view it
 * serves and referenced from that view's callbacks is a temporal-dead-zone
 * throw that builds cleanly and dies on render. (The compiler caught the same
 * shape in this slice's server code, which is the only reason it was cheap.)
 *
 * ⚠️ **Nothing here decides anything.** #774 records what it saw — absent,
 * absent while the chain was at risk, abroad — and a leader marks each flagged
 * slot paid or unpaid. An undecided flag is still counted as payable, because
 * the flag asks a question rather than withholding money on its own.
 */

const money = (n) => n.toLocaleString()

const FLAG_TONE = {
  absent: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  'absent-at-risk': 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  abroad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
}

export default function PayoutPanel({
  event, signups, removed, outcome, canEdit, onDecide, busyKey, onUpdateEvent, onSetEligible,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { rows: unsortedRows, totals } = useMemo(() => payoutRows(event, signups), [event, signups])
  // ⚠️ Opens in `chainPayout.ORDER` — slots descending, member id ascending.
  // That order is documented there as having to be stable, so the default here
  // reproduces it rather than inventing a new one. My first version opened on
  // payout and would have silently changed what a leader sees.
  const { sorted: rows, sortCol, sortDir, onSort } =
    useTableSort(unsortedRows, CHAIN_PAYOUT_COLUMNS, {
      initialCol: 'slots', initialDir: 'desc', tieBreak: 'memberId',
    })

  // ⚠️ Built from the SORTED rows, so the link pays exactly the people the
  // reader can see, in the order they are looking at them.
  const batchUrl = useMemo(() => batchPayLink(rows), [rows])
  const payableCount = rows.filter((r) => r.payout > 0).length
  const note = useMemo(() => unpayableNote(event, signups, outcome), [event, signups, outcome])
  const raffle = raffleRuns(outcome)

  // ⚠️ Severity is visible and sortable. *Absent* is usually paid without much
  // thought; *absent while the chain was at risk* is the row worth a minute. If
  // both look identical, leadership treats them identically.
  const awaiting = useMemo(
    () => signups.filter((s) => s.flag && !s.pay_decision)
      .sort((a, b) => (b.flag === 'absent-at-risk') - (a.flag === 'absent-at-risk')
        || a.hour_start.localeCompare(b.hour_start)),
    [signups])

  if (rows.length === 0) {
    return <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Nothing has been served yet.</p>
  }

  return (
    <div className="space-y-4">
      {/* ⚠️ A dropped chain gets a post-mortem, not just a smaller payout. Two
          watchers per hour exist precisely so this should not happen. */}
      {outcome?.state === 'ended' && outcome.dropped && (
        <div className="card border-red-300 bg-red-50 dark:bg-red-900/20" data-testid="drop-postmortem">
          <p className="text-sm">
            <strong>The chain dropped at {outcome.peak?.toLocaleString()} hits</strong>
            {outcome.endedAt != null && ` — ${tctLabel(outcome.endedAt)} TCT`}.
            {' '}Slots are still paid; <strong>the raffle does not run</strong>.
          </p>
          {outcome.finalHourWatchers?.length > 0 && (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300" data-testid="final-watchers">
              On watch that hour:{' '}
              {outcome.finalHourWatchers.map((w) => w.member_name ?? w.member_id).join(', ')}.
            </p>
          )}
        </div>
      )}

      {note && (
        <p className="card text-sm text-gray-600 dark:text-gray-300" data-testid="unpayable-note">{note}</p>
      )}

      {/* ⚠️ Leadership only (MonChoon, 2026-10-01). This is a queue of calls a
          leader has to make, and it names members beside a flag — "absent while
          the chain was at risk" is an accusation until somebody has ruled on
          it. A member reading their own name here would see a verdict that has
          not been reached. */}
      {canEdit && awaiting.length > 0 && (
        <div className="card space-y-2" data-testid="flag-queue">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            {awaiting.length} slot{awaiting.length === 1 ? '' : 's'} awaiting your call
          </h3>
          <ul className="divide-y divide-gray-100 text-sm dark:divide-slate-700">
            {awaiting.map((s) => {
              const key = `${s.hour_start}:${s.slot_index}:decide`
              return (
                <li key={key} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="font-mono text-xs tabular-nums text-gray-500">
                    {tctLabel(Number(s.hour_ms))} TCT
                  </span>
                  <span className="font-medium">{s.member_name ?? s.member_id}</span>
                  <span className={`rounded px-1.5 text-[11px] font-semibold uppercase ${FLAG_TONE[s.flag] ?? ''}`}>
                    {s.flag.replace(/-/g, ' ')}
                  </span>
                  <span className="text-xs text-gray-400">{s.flag_reason}</span>
                  {canEdit && (
                    <span className="ml-auto flex gap-1">
                      <button type="button" disabled={busyKey === key}
                        onClick={() => onDecide(s, 'paid')}
                        className="btn-secondary px-2 py-0.5 text-xs">Pay</button>
                      <button type="button" disabled={busyKey === key}
                        onClick={() => onDecide(s, 'unpaid')}
                        className="btn-secondary px-2 py-0.5 text-xs">Don’t pay</button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ⚠️ Above the table, not inside it: a batch link built from rows the
          reader can still see is one they can check before clicking. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {batchUrl && (
            <a href={batchUrl} target="_blank" rel="noreferrer" data-testid="batch-pay"
              className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
              Batch pay {payableCount} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {batchUrl && (
            <button type="button" data-testid="batch-pay-copy"
              onClick={() => navigator.clipboard?.writeText(batchUrl)}
              className="btn-secondary px-3 py-1.5 text-sm">
              {/* ⚠️ Copy as well as open: the OC and RW sheets both offer the
                  link as text, because Torn's controls tab does not always
                  survive being opened in a new tab from a different origin. */}
              Copy link
            </button>
          )}
        </div>
        {canEdit && onUpdateEvent && (
          <button type="button" data-testid="payout-settings"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
            <Settings className="h-4 w-4" /> Payout settings
          </button>
        )}
      </div>

      {settingsOpen && canEdit && onUpdateEvent && (
        <PayoutSettings event={event} onSave={onUpdateEvent} onClose={() => setSettingsOpen(false)} />
      )}

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-400 dark:border-slate-600">
                <SortableTh col="watcher" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Watcher" className="px-3 py-2 text-left font-medium">Watcher</SortableTh>
                <SortableTh col="slots"   sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Slots" className="px-3 py-2 text-right font-medium">Slots</SortableTh>
                <SortableTh col="bonus"   sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Bonus" className="px-3 py-2 text-right font-medium">Bonus</SortableTh>
                {raffle && <SortableTh col="tickets" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Tickets" className="px-3 py-2 text-right font-medium">Tickets</SortableTh>}
                {/* ⚠️ Ticket range is a RENDERED SPAN (first–last), so it sorts
                    on `first` — the number that orders the ranges. */}
                {raffle && <SortableTh col="ticketRange" sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Ticket range" className="px-3 py-2 text-right font-medium">Ticket range</SortableTh>}
                <SortableTh col="payout"  sortCol={sortCol} sortDir={sortDir} onSort={onSort} label="Payout" className="px-3 py-2 text-right font-medium">Payout</SortableTh>
                {/* ⚠️ The pay-link column. Not sortable — it is a link. */}
                <th className="px-3 py-2" />
                {/* ⚠️ Leadership only: a blanket switch over a member's whole
                    event. Not sortable — it is a control, and `slots` already
                    orders by the same fact. */}
                {canEdit && onSetEligible && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.member_id} data-testid={`payout-${r.member_id}`}
                  className="border-b border-gray-100 dark:border-slate-700">
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{r.member_name}</span>
                    {r.unpaidSlots > 0 && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 text-[11px] font-semibold text-red-800 dark:bg-red-900/40 dark:text-red-300">
                        {r.unpaidSlots} unpaid
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.slots}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-400">
                    {r.bonusSlots || '—'}
                  </td>
                  {raffle && <td className="px-3 py-1.5 text-right font-mono tabular-nums">{r.tickets}</td>}
                  {raffle && (
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-gray-500">
                      {r.firstTicket ? `${r.firstTicket}–${r.lastTicket}` : '—'}
                    </td>
                  )}
                  {/* ⚠️ ONE payout number, and the link below carries exactly
                      it. The sheet showed 35,000,000 beside a link paying
                      34,500,000. */}
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{money(r.payout)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {r.payout > 0 && (
                      <a href={payLink(r.member_id, r.payout)} target="_blank" rel="noreferrer"
                        data-testid={`pay-${r.member_id}`}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">
                        Pay <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                  {canEdit && onSetEligible && (
                    <td className="px-3 py-1.5 text-right">
                      {/* ⚠️ A blanket switch over the member's whole event. It
                          OVERWRITES per-slot calls, which is what "blanket"
                          means — the label says which way it will go, rather
                          than showing a state the reader has to interpret. */}
                      <button
                        type="button"
                        disabled={busyKey === `eligible:${r.member_id}`}
                        onClick={() => onSetEligible(r, r.slots === 0)}
                        data-testid={`eligible-${r.member_id}`}
                        className={`rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide disabled:opacity-50 ${
                          r.slots === 0
                            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-700 dark:text-gray-400'
                        }`}
                        title={r.slots === 0
                          ? 'Not being paid — click to restore every slot'
                          : 'Being paid — click to withhold the whole event'}
                      >
                        {r.slots === 0 ? 'Not paid' : 'Eligible'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {/* ⚠️ Computed from the rows above. The sheet's totals row read
                  189.5 bonus slots — half the slot count, a stray /2 — where
                  its own member rows summed to 59. */}
              <tr className="bg-gray-50 font-semibold dark:bg-slate-800" data-testid="payout-totals">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.slots}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.bonusSlots}</td>
                {raffle && <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.tickets}</td>}
                {raffle && <td />}
                <td className="px-3 py-2 text-right font-mono tabular-nums">{money(totals.payout)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ⚠️ Leadership only (MonChoon, 2026-10-01). It is a log of who took
          whom off which hour — a moderation record, not a payout figure. */}
      {canEdit && removed?.length > 0 && (
        // ⚠️ Removed is NOT the same as never signed up. A member who worked an
        // hour and was later taken off it sees a smaller number with no
        // explanation otherwise, and this panel is the only place a LEADER can
        // see why.
        <div className="card space-y-1" data-testid="removed-slots">
          <h3 className="text-sm font-semibold">Removed from hours that had already run</h3>
          <ul className="text-sm text-gray-500 dark:text-gray-400">
            {removed.map((r) => (
              <li key={`${r.hour_start}:${r.slot_index}`} className="flex flex-wrap gap-2 py-0.5">
                <span className="font-mono text-xs tabular-nums">{tctLabel(Number(r.hour_ms))} TCT</span>
                <span className="line-through">{r.member_name ?? r.member_id}</span>
                <span className="text-xs">
                  removed by {r.removed_by_name ?? r.removed_by ?? 'someone'}
                  {r.removed_reason ? ` — ${r.removed_reason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!raffle && (
        <p className="text-xs text-gray-400" data-testid="no-raffle">
          Raffle tickets are not shown: the chain dropped, so the raffle does not run.
        </p>
      )}
    </div>
  )
}
