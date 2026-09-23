import { Fragment } from 'react'
import { UserPlus, X, Repeat } from 'lucide-react'
import { groupByTctDay, localLabel, zoneLabel, bonusLabel } from '../../utils/chainWatch'
import InfoTooltip from '../InfoTooltip'

/**
 * The hour grid (#772).
 *
 * ⚠️ Its own file, per the v3.97.0 crash — see MemberPicker.
 *
 * Two time columns, and the second one is the point. TCT is canonical: it is
 * what Torn shows and what leadership says out loud. Beside it sits the
 * VIEWER'S OWN clock, formatted per row from that row's instant.
 *
 * ⚠️ Never by adding a fixed offset. The spreadsheet typed three zone rows by
 * hand, the 2025 event crossed the US DST change, and rows 100-101 of the
 * workbook still list "2:00-3:00" twice where somebody patched the fold. A
 * member in Europe or Australia got no row at all and did the arithmetic
 * themselves — which is the arithmetic people get wrong at 3am, which is when
 * the chain drops. Two rows showing the same local time across a fold is
 * correct and must not be "fixed".
 */

const dayHeading = (key) =>
  // db-time-safe: `key` is our own YYYY-MM-DD, built from an epoch in hourRows.
  new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  })

export default function SignUpGrid({
  rows, event, meId, canEdit, zone,
  onClaim, onRelease, onAssign, busyKey, emptyNote,
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{emptyNote}</p>
  }

  return (
    <div className="divide-y divide-gray-100 dark:divide-slate-700">
      {groupByTctDay(rows).map((day) => (
        <Fragment key={day.dayKey}>
          <div className="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-gray-50 px-3 py-1.5 text-xs dark:bg-slate-800">
            <span className="font-semibold uppercase tracking-wide">{dayHeading(day.dayKey)}</span>
            <span className="tabular-nums text-gray-400 dark:text-gray-500">
              {day.rows.reduce((n, r) => n + r.slots.filter(Boolean).length, 0)}
              /{day.rows.length * (event.slots_per_hour ?? 2)} slots
            </span>
          </div>

          {day.rows.map((row) => (
            <div
              key={row.hourIso}
              id={`hour-${row.hourIso}`}
              data-testid={`hour-${row.hourIso}`}
              className={`grid grid-cols-[5.5rem_1fr] items-center gap-3 px-3 py-1.5 ${
                row.isNow ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              } ${row.isPast ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-col leading-tight">
                <span className="flex items-baseline gap-1 font-mono text-sm tabular-nums">
                  {row.tct}
                  {/* ⚠️ `label` is the visible TRIGGER and `children` is the
                      panel — the other way round renders the explanation as
                      permanent body text and drops the badge entirely.
                      ⚠️ And the reason rides on the marker rather than sitting
                      in a legend in a corner: an unexplained colour key is what
                      let 28 slots draw a bonus nobody noticed. */}
                  {row.isBonus && (
                    <InfoTooltip
                      decoration="no-underline"
                      label={
                        <span className="rounded bg-purple-100 px-1 text-[10px] font-semibold uppercase text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                          ×{event.bonus_multiplier ?? 2}
                        </span>
                      }
                    >{bonusLabel(event)}</InfoTooltip>
                  )}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-gray-400 dark:text-gray-500">
                  {localLabel(row.ms, zone)} {zoneLabel(zone)}
                </span>
              </div>

              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${row.slots.length}, minmax(0, 1fr))` }}>
                {row.slots.map((slot, i) => {
                  const key = `${row.hourIso}:${i}`
                  const busy = busyKey === key
                  if (!slot) {
                    return (
                      <div key={i} className="flex gap-1">
                        <button
                          type="button" disabled={busy}
                          onClick={() => onClaim(row, i)}
                          data-testid={`claim-${row.hourIso}-${i}`}
                          className="flex-1 rounded border border-dashed border-gray-300 px-2 py-1 text-xs font-medium text-blue-600 hover:border-blue-500 hover:bg-blue-50 disabled:opacity-50 dark:border-slate-600 dark:text-blue-400 dark:hover:bg-blue-900/20"
                        >
                          Sign up
                        </button>
                        {canEdit && (
                          <button
                            type="button" disabled={busy}
                            onClick={() => onAssign(row, i)}
                            aria-label={`Assign someone to ${row.tct} TCT slot ${i + 1}`}
                            className="rounded border border-gray-200 px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-50 dark:border-slate-600 dark:text-gray-400"
                          >
                            <UserPlus className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )
                  }
                  const mine = String(slot.member_id) === String(meId)
                  return (
                    <div key={i}
                      className="flex items-center justify-between gap-1 rounded bg-gray-100 px-2 py-1 text-xs dark:bg-slate-700">
                      <a
                        href={`https://www.torn.com/profiles.php?XID=${slot.member_id}`}
                        target="_blank" rel="noreferrer"
                        className="truncate font-medium hover:underline"
                      >
                        {slot.member_name ?? slot.member_id}
                      </a>
                      <span className="flex shrink-0 gap-0.5">
                        {canEdit && (
                          <button
                            type="button" disabled={busy}
                            onClick={() => onAssign(row, i)}
                            aria-label={`Replace ${slot.member_name ?? slot.member_id} at ${row.tct} TCT`}
                            className="text-gray-400 hover:text-gray-700 disabled:opacity-50 dark:hover:text-gray-200"
                          >
                            <Repeat className="h-3 w-3" />
                          </button>
                        )}
                        {/* ⚠️ Dropping your OWN slot stays available right up to
                            the hour starting, and is not buried. Someone who
                            knows at 22:00 they will not make 04:00 must be able
                            to say so while there is still time to refill it —
                            make the silent no-show the harder path. After the
                            hour begins the server refuses it (#771), so the
                            control goes. */}
                        {(canEdit || (mine && !row.isPast && !row.isNow)) && (
                          <button
                            type="button" disabled={busy}
                            onClick={() => onRelease(row, i, slot)}
                            aria-label={mine && !canEdit
                              ? `Drop your slot at ${row.tct} TCT`
                              : `Remove ${slot.member_name ?? slot.member_id} from ${row.tct} TCT`}
                            className="text-gray-400 hover:text-red-600 disabled:opacity-50"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}
