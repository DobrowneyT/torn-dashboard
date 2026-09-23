import { useMemo } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { payoutRows, payLink, raffleRuns, unpayableNote } from '../../utils/chainPayout'
import { tctLabel } from '../../utils/chainWatch'

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

export default function PayoutPanel({ event, signups, removed, outcome, canEdit, onDecide, busyKey }) {
  const { rows, totals } = useMemo(() => payoutRows(event, signups), [event, signups])
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

      {awaiting.length > 0 && (
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

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-400 dark:border-slate-600">
                <th className="px-3 py-2 text-left font-medium">Watcher</th>
                <th className="px-3 py-2 text-right font-medium">Slots</th>
                <th className="px-3 py-2 text-right font-medium">Bonus</th>
                {raffle && <th className="px-3 py-2 text-right font-medium">Tickets</th>}
                {raffle && <th className="px-3 py-2 text-right font-medium">Ticket range</th>}
                <th className="px-3 py-2 text-right font-medium">Payout</th>
                <th className="px-3 py-2" />
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

      {removed?.length > 0 && (
        // ⚠️ Removed is NOT the same as never signed up. A member who worked an
        // hour and was later taken off it sees a smaller number with no
        // explanation otherwise, and this panel is the only place anyone looks.
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
