import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost, apiDelete } from '../../utils/apiClient'
import SortableTh, { useTableSort } from '../SortableTh'
import { formatTct } from '../../utils/factionEvent'
import { PlayerLink, FactionLink, AttackLink } from './TornLink'

/**
 * The event's live chain report (#971).
 *
 * ⚠️ Totals and Members are TORN'S OWN chain report (polled by #970) — the
 * numbers members check us against. Daily and Targets come from attacks-sync,
 * which backfills after an outage; the chain report cannot say which day a hit
 * landed on.
 *
 * ⚠️ Respect is always shown both ways: raw, and capped at 10 per bonus hit
 * with the deduction named — the war report's rule.
 */
/**
 * How often an open page asks "has anything changed?" (#972). Cheap — the
 * server answers from a few-second cache — and the full report is fetched only
 * when the answer moves.
 */
export const VERSION_POLL_MS = 5_000
// Members first: it is the board members open the page for — where they
// stand on the live chain report (MonChoon, 2026-10-17).
const VIEWS = [
  // "Report" (MonChoon, 2026-10-18): it IS the live chain report.
  { id: 'members', label: 'Report' },
  { id: 'totals', label: 'Totals' },
  // Daily + Highlights, merged (MonChoon, 2026-10-18): one view, any range —
  // a day, the whole event, or a custom span.
  { id: 'stats', label: 'Stats' },
  { id: 'targets', label: 'Targets' },
]

const fmt = (n, dp = 0) => (n == null ? '—' : Number(n).toLocaleString(undefined, {
  minimumFractionDigits: dp, maximumFractionDigits: dp,
}))
const TH = 'text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400'
const TD = 'px-3 py-1.5 tabular-nums whitespace-nowrap'
// ⚠️ The name column stays put while the figures scroll — on a phone the
// Members table shows three of fifteen columns at once, and a row you have
// scrolled right on is otherwise anonymous. The repo's frozen-column idiom
// (WarPayoutManagement, WarHistoryView): sticky, z above the cells, and an
// OPAQUE background so the scrolling figures pass behind it.
const FROZEN_TH = 'sticky left-0 z-[6] bg-white dark:bg-slate-800'
/**
 * Members: a POSITION column frozen beside the name, so a member scrolled to
 * any column can see where they stand under whatever it is sorted by. ⚠️ The
 * position is the row's place in the CURRENT sort, not a fixed rank by hits —
 * sort by respect and it reads as a respect ranking.
 * The name sticks just right of it: `left-10` matches the position column's
 * `w-10` (2.5rem), so the two never overlap.
 */
const POS_TH = 'sticky left-0 z-[6] bg-white dark:bg-slate-800'
const POS_TD = 'sticky left-0 z-[5] bg-white dark:bg-slate-800'
const NAME_AFTER_POS_TH = 'sticky left-10 z-[6] bg-white dark:bg-slate-800'
const NAME_AFTER_POS_TD = 'sticky left-10 z-[5] bg-white dark:bg-slate-800'
// ⚠️ Table cards drop the card's padding (`p-0 sm:p-0`): a sticky cell sticks
// INSIDE the padding, and the figures scrolling past showed through the
// padding strip to the left of the frozen names (seen at phone width).

export default function EventReport({ event, isLeadership = false }) {
  const [view, setView] = useState('members')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const seen = useRef(null)

  const load = useCallback(async () => {
    try {
      setData(await apiGet(`/api/events/${event.id}/report`))
      setError(null)
    } catch (err) {
      // Keep the last report on screen; say it is stale.
      setError(err.message || 'Could not load the report.')
    }
  }, [event.id])

  // #972 — live updates. Refetch the report only when what it is built from
  // has changed: a new attack id or a different chain report. ⚠️ Skipped while
  // the tab is hidden, and caught up the moment it is shown again.
  useEffect(() => {
    let alive = true
    seen.current = null
    const check = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const { version } = await apiGet(`/api/events/${event.id}/report/version`)
        if (!alive || version === seen.current) return
        seen.current = version
        await load()
      } catch {
        // The next check retries; the report on screen stays.
      }
    }
    check()
    const t = setInterval(check, VERSION_POLL_MS)
    const onShow = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onShow)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
  }, [event.id, load])

  const color = event.theme_color
  return (
    <div className="space-y-4">
      {/* One row that scrolls sideways on a phone, rather than wrapping the
          fifth view onto a line of its own. */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            style={view === v.id
              ? { backgroundColor: color, color: '#fff' }
              : { boxShadow: `inset 0 0 0 1px ${color}`, color }}
          >
            {v.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data ? (
        !error && <p className="text-sm text-gray-500 dark:text-gray-400">Loading the report…</p>
      ) : (
        <>
          {view === 'totals' && <Totals chain={data.chain} event={event} />}
          {view === 'members' && <Members chain={data.chain} />}
          {view === 'stats' && <Stats event={event} days={data.daily} stamp={data.server_now} />}
          {view === 'targets' && <Targets targets={data.targets} event={event} isLeadership={isLeadership} stamp={data.server_now} />}
        </>
      )}
    </div>
  )
}

function NoChain({ event }) {
  return (
    <div className="card p-6 text-sm text-gray-600 dark:text-gray-300">
      {event.phase === 'upcoming'
        ? `The chain report starts collecting when the event opens, ${formatTct(event.starts_at)}.`
        : 'No chain report yet — it appears within seconds of our event chain starting.'}
    </div>
  )
}

/** Raw respect, with the capped figure and the deduction named beneath. */
export function Respect({ raw, capped, deduction, dp = 2 }) {
  return (
    <span>
      <span className="font-semibold">{fmt(raw, dp)}</span>
      {deduction > 0 && (
        <span className="block text-xs text-gray-500 dark:text-gray-400">
          {fmt(capped, dp)} capped (−{fmt(deduction, dp)} bonus)
        </span>
      )}
    </span>
  )
}

function Stat({ label, children }) {
  return (
    <div className="card p-3 sm:p-4 min-w-0">
      <div className="text-[11px] sm:text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 truncate">{label}</div>
      <div className="mt-1 text-base sm:text-xl text-gray-900 dark:text-white tabular-nums">{children}</div>
    </div>
  )
}

function Totals({ chain, event }) {
  if (!chain) return <NoChain event={event} />
  const t = chain.totals
  const counters = [
    // ⚠️ "Attacks", never "hits": a HIT is one turn inside a fight (it has
    // damage); an ATTACK is the whole fight, up to 25 turns (MonChoon,
    // 2026-10-18). Every count on this page is of attacks.
    ['Attacks', t.hits], ['Leave', t.leave], ['Mugs', t.mug], ['Hosps', t.hospitalize],
    ['Assists', t.assists], ['Retaliations', t.retaliations], ['Overseas', t.overseas],
    // "Stalemates", as Torn calls them in game (the API says `draws`). No
    // "Bonuses" card: the bonus hits are listed in full just below.
    ['Losses', t.losses], ['Escapes', t.escapes], ['Stalemates', t.draws],
    ['Attackers', t.members],
  ]
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-3">
        {/* Phone: Respect across the top, Chain and Best side by side under
            it. Wider: the three in a row, Respect in the middle. */}
        <div className="col-span-2 sm:col-span-1 sm:order-2">
          <Stat label="Respect">
            <Respect raw={t.respect.raw} capped={t.respect.capped} deduction={t.respect.deduction} />
          </Stat>
        </div>
        <div className="sm:order-1"><Stat label="Chain">{fmt(t.chain)}</Stat></div>
        {/* ⚠️ The best ORDINARY attack: Torn's own "best" counts chain bonuses. */}
        <div className="sm:order-3"><Stat label="Highest respect attack">{fmt(t.best, 2)} <span className="text-sm text-gray-500 dark:text-gray-400">respect</span></Stat></div>
      </div>
      <div className="grid gap-2 sm:gap-3 grid-cols-3 sm:grid-cols-4">
        {counters.map(([k, v]) => <Stat key={k} label={k}>{fmt(v)}</Stat>)}
      </div>
      {chain.bonuses.length > 0 && (
        <div className="card p-4 overflow-x-auto">
          <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Bonus attacks</h4>
          <table className="min-w-full text-sm">
            <thead><tr className={TH}><th className="px-3 py-1.5">Chain</th><th className="px-3 py-1.5">Member</th><th className="px-3 py-1.5">Respect</th><th className="px-3 py-1.5">Capped at 10</th></tr></thead>
            <tbody>
              {chain.bonuses.map((b) => (
                <tr key={b.chain} className="border-t border-gray-100 dark:border-slate-700">
                  <td className={TD}>{fmt(b.chain)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap"><PlayerLink id={b.attacker_id} name={b.attacker} /></td>
                  <td className={TD}>{fmt(b.respect, 2)}</td>
                  <td className={TD}>{b.respect > 10 ? `−${fmt(b.respect - 10, 2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Torn&apos;s chain report as of {formatTct(chain.as_of)}.
      </p>
    </div>
  )
}

const MEMBER_COLS = [
  { key: 'name', label: 'Member', kind: 'string', accessor: (m) => m.name },
  { key: 'hits', label: 'Attacks', kind: 'number', accessor: (m) => m.attacks.total },
  { key: 'respect', label: 'Respect', kind: 'number', accessor: (m) => m.respect.total },
  { key: 'capped', label: 'Capped', kind: 'number', accessor: (m) => m.respect.capped },
  { key: 'average', label: 'Avg', kind: 'number', accessor: (m) => m.respect.average },
  { key: 'best', label: 'Best', kind: 'number', accessor: (m) => m.respect.best },
  { key: 'mug', label: 'Mugs', kind: 'number', accessor: (m) => m.attacks.mug },
  { key: 'hospitalize', label: 'Hosp', kind: 'number', accessor: (m) => m.attacks.hospitalize },
  { key: 'leave', label: 'Leave', kind: 'number', accessor: (m) => m.attacks.leave },
  { key: 'assists', label: 'Assists', kind: 'number', accessor: (m) => m.attacks.assists },
  { key: 'retaliations', label: 'Retals', kind: 'number', accessor: (m) => m.attacks.retaliations },
  { key: 'overseas', label: 'Overseas', kind: 'number', accessor: (m) => m.attacks.overseas },
  { key: 'losses', label: 'Losses', kind: 'number', accessor: (m) => m.attacks.losses },
  { key: 'escapes', label: 'Escapes', kind: 'number', accessor: (m) => m.attacks.escapes },
  { key: 'bonus_hits', label: 'Bonus attacks', kind: 'number', accessor: (m) => m.bonus_hits },
]

function Members({ chain }) {
  const rows = useMemo(() => chain?.members ?? [], [chain])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, MEMBER_COLS, { initialCol: 'hits', initialDir: 'desc', tieBreak: 'name' })
  if (!chain) return <NoChain event={{ phase: 'live' }} />
  return (
    <div className="space-y-4">
      <div className="card p-0 sm:p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={TH}>
              <th className={`px-2 py-1.5 font-medium text-right w-10 ${POS_TH}`} aria-label="Position">#</th>
              {MEMBER_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
                  className={c.key === 'name' ? NAME_AFTER_POS_TH : ''}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => (
              <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                <td className={`px-2 py-1.5 text-right tabular-nums text-gray-500 dark:text-gray-400 w-10 ${POS_TD}`}>{i + 1}</td>
                <td className={`px-3 py-1.5 whitespace-nowrap max-w-[12rem] truncate ${NAME_AFTER_POS_TD}`}><PlayerLink id={m.id} name={m.name} /></td>
                <td className={TD}>{fmt(m.attacks.total)}</td>
                <td className={TD}>{fmt(m.respect.total, 2)}</td>
                <td className={TD} title={m.respect.deduction > 0 ? `−${fmt(m.respect.deduction, 2)} bonus` : undefined}>
                  {fmt(m.respect.capped, 2)}
                  {m.respect.deduction > 0 && <span className="text-xs text-gray-500 dark:text-gray-400"> (−{fmt(m.respect.deduction, 2)})</span>}
                </td>
                <td className={TD}>{fmt(m.respect.average, 2)}</td>
                <td className={TD}>{fmt(m.respect.best, 2)}</td>
                <td className={TD}>{fmt(m.attacks.mug)}</td>
                <td className={TD}>{fmt(m.attacks.hospitalize)}</td>
                <td className={TD}>{fmt(m.attacks.leave)}</td>
                <td className={TD}>{fmt(m.attacks.assists)}</td>
                <td className={TD}>{fmt(m.attacks.retaliations)}</td>
                <td className={TD}>{fmt(m.attacks.overseas)}</td>
                <td className={TD}>{fmt(m.attacks.losses)}</td>
                <td className={TD}>{fmt(m.attacks.escapes)}</td>
                <td className={TD}>{fmt(m.bonus_hits)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card p-4">
        <h4 className="font-semibold text-gray-900 dark:text-white">
          No attacks yet ({chain.non_attackers.length})
        </h4>
        {chain.non_attackers.length === 0
          ? <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">Everyone has attacked.</p>
          : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {chain.non_attackers.map((m) => (
                <li key={m.id} className="text-sm px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700"><PlayerLink id={m.id} name={m.name} /></li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

const DAY_COLS = [
  { key: 'name', label: 'Member', kind: 'string' },
  // `hits` here is attacks WON (a win result), so it says so.
  { key: 'hits', label: 'Attacks won', kind: 'number' },
  { key: 'respect', label: 'Respect', kind: 'number' },
  { key: 'mug', label: 'Mugs', kind: 'number' },
  { key: 'hospitalize', label: 'Hosp', kind: 'number' },
  { key: 'leave', label: 'Leave', kind: 'number' },
  { key: 'assists', label: 'Assists', kind: 'number' },
  { key: 'losses', label: 'Losses', kind: 'number' },
  { key: 'retaliations', label: 'Retals', kind: 'number' },
  { key: 'incoming', label: 'Hit by others', kind: 'number' },
  { key: 'defended', label: 'Defended', kind: 'number' },
]

/**
 * A short ranked list. `who` renders the left side (a player link by default);
 * `render` the figure. ⚠️ Rows can repeat a member (their two biggest hits),
 * so the key is the position, not the id.
 */
function Ranked({ title, rows, unit = '', render, who = (r) => <PlayerLink id={r.id} name={r.name} />, empty = 'Nothing yet.' }) {
  return (
    // ⚠️ `min-w-0` on the card, and rows that WRAP: on a phone a long name and
    // a long figure ("$5,500,969 on Fivesevenseven [123]") do not fit one line,
    // and without these the card grew past the screen edge and cut the figure
    // off (seen at 390 px). The figure drops under the name, right-aligned.
    <div className="card p-4 min-w-0">
      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">{title}</h4>
      {rows.length === 0
        ? <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>
        : (
          <ol className="space-y-1 text-sm max-h-[19rem] overflow-y-auto pr-1">
            {rows.map((r, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="truncate min-w-0 max-w-full"><span className="text-gray-400 tabular-nums mr-2">{i + 1}.</span>{who(r)}</span>
                <span className="ml-auto tabular-nums text-right text-gray-700 dark:text-gray-200 min-w-0 max-w-full truncate">{render(r)}{unit ? ` ${unit}` : ''}</span>
              </li>
            ))}
          </ol>
        )}
    </div>
  )
}

/**
 * A per-member board: EVERY member, sortable, in a window about ten rows tall
 * that scrolls (MonChoon, 2026-10-18: "show the entire faction ... scrollable
 * ... possibly making them sortable"). `#` is the place in the CURRENT sort.
 * `expand(row)`, when given, makes the figure in the first column clickable to
 * open the row's detail underneath.
 */
export function MemberBoard({ title, rows, columns, initialCol, empty = 'Nothing yet.', expand, showCount = true }) {
  const cols = useMemo(() => [{ key: 'name', label: 'Member', kind: 'string' }, ...columns], [columns])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, cols, {
    initialCol: initialCol ?? columns[0]?.key, initialDir: 'desc', tieBreak: 'name',
  })
  const [open, setOpen] = useState(null)
  return (
    <div className="card p-4 min-w-0">
      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">
        {title} {showCount && rows.length > 0 && <span className="text-sm font-normal text-gray-500 dark:text-gray-400">({fmt(rows.length)})</span>}
      </h4>
      {rows.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p> : (
        <div className="max-h-[20rem] overflow-y-auto -mx-1 px-1">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-[6] bg-white dark:bg-slate-800">
              <tr className={TH}>
                <th className="px-1 py-1 w-8 text-right font-medium" aria-label="Position">#</th>
                {cols.map((c) => (
                  <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
                    className={c.key === 'name' ? '' : 'text-right'}>{c.label}</SortableTh>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const isOpen = expand && open === r.id
                return (
                  <Fragment key={r.id}>
                    <tr className="border-t border-gray-100 dark:border-slate-700">
                      <td className="px-1 py-1 text-right tabular-nums text-gray-400">{i + 1}</td>
                      <td className="px-3 py-1 max-w-[12rem] truncate"><PlayerLink id={r.id} name={r.name} /></td>
                      {columns.map((c, ci) => {
                        const v = c.render ? c.render(r) : fmt(c.accessor ? c.accessor(r) : r[c.key])
                        return (
                          <td key={c.key} className="px-3 py-1 text-right tabular-nums whitespace-nowrap">
                            {expand && ci === 0 ? (
                              <button type="button" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={!!isOpen}
                                className="text-blue-600 dark:text-blue-400 hover:underline">
                                {v} {isOpen ? '▴' : '▾'}
                              </button>
                            ) : v}
                          </td>
                        )
                      })}
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={cols.length} className="px-3 pb-2">{expand(r)}</td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** One member's loot, drop by drop, with the source linked. */
function LootDetail({ row }) {
  return (
    <ul className="space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
      {row.detail.map((d, i) => (
        <li key={i}>
          {d.qty > 1 ? `${fmt(d.qty)}× ` : ''}{d.item} from <PlayerLink id={d.from_id} name={d.from} />
          <span className="text-gray-400"> · {formatTct(d.at)}</span>
        </li>
      ))}
    </ul>
  )
}

const BOARD_COUNT = [{ key: 'count', label: 'Procs', kind: 'number' }]
const BOARD_LOOT = [
  { key: 'drops', label: 'Drops', kind: 'number' },
  { key: 'items', label: 'Items', kind: 'number', accessor: (r) => Object.values(r.items).reduce((a, b) => a + b, 0) },
]
const BOARD_BOUNTY = [
  { key: 'total', label: 'Earned', kind: 'number', render: (r) => `$${fmt(r.total)}` },
  { key: 'claims', label: 'Claims', kind: 'number' },
]
const BOARD_TARGETED = [
  { key: 'incoming', label: 'Attacked', kind: 'number' },
  { key: 'beaten', label: 'Beaten', kind: 'number' },
]
const BOARD_BUSY = [
  { key: 'outgoing', label: 'Attacks', kind: 'number' },
  { key: 'distinct_targets', label: 'Targets', kind: 'number' },
]

const TARGET_COLS = [
  { key: 'name', label: 'Member', kind: 'string' },
  { key: 'outgoing', label: 'Attacks made', kind: 'number' },
  { key: 'distinct_targets', label: 'Different targets', kind: 'number' },
  { key: 'incoming', label: 'Attacked', kind: 'number' },
  { key: 'beaten', label: 'Beaten', kind: 'number' },
  { key: 'defended', label: 'Defended', kind: 'number' },
  { key: 'distinct_attackers', label: 'Different attackers', kind: 'number' },
]

/**
 * #987 — one faction per row: name and attacks on the first line, the detail
 * under it, so it reads at phone width without a table. EVERY faction is
 * listed; the box shows about ten and scrolls (MonChoon, 2026-10-18).
 */
function FactionList({ title, rows, detail }) {
  return (
    <div className="card p-4 min-w-0">
      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">
        {title} <span className="text-sm font-normal text-gray-500 dark:text-gray-400">({fmt(rows.length)})</span>
      </h4>
      {rows.length === 0
        ? <p className="text-sm text-gray-500 dark:text-gray-400">Nothing yet.</p>
        : (
          <ol className="space-y-2 text-sm max-h-[30rem] overflow-y-auto pr-1">
            {rows.map((r, i) => (
              <li key={r.id ?? i}>
                <div className="flex justify-between gap-3">
                  <span className="truncate min-w-0">
                    <span className="text-gray-400 tabular-nums mr-2">{i + 1}.</span>
                    <FactionLink id={r.id} name={r.name} />
                  </span>
                  <span className="tabular-nums text-gray-700 dark:text-gray-200 whitespace-nowrap">{fmt(r.attacks)} attacks</span>
                </div>
                <div className="pl-6 text-xs text-gray-500 dark:text-gray-400 tabular-nums">{detail(r)}</div>
              </li>
            ))}
          </ol>
        )}
    </div>
  )
}

function Targets({ targets, event, isLeadership, stamp }) {
  const rows = useMemo(() => targets?.members ?? [], [targets])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, TARGET_COLS, { initialCol: 'incoming', initialDir: 'desc', tieBreak: 'name' })
  if (!targets) return null
  return (
    <div className="space-y-4">
      <WantedBoard event={event} isLeadership={isLeadership} stamp={stamp} />
      {(targets.factions_we_hit || targets.factions_hit_us) && (
        <div className="grid gap-3 md:grid-cols-2">
          <FactionList title="Factions we attacked most" rows={targets.factions_we_hit ?? []}
            detail={(r) => [`${fmt(r.wins)} won`, `${fmt(r.members)} of ours`,
              r.respect_gained > 0 && `+${fmt(r.respect_gained, 2)} respect`].filter(Boolean).join(' · ')} />
          <FactionList title="Factions that attacked us most" rows={targets.factions_hit_us ?? []}
            detail={(r) => [`${fmt(r.beaten)} beat us`, `${fmt(r.defended)} defended`, `${fmt(r.members)} of ours attacked`,
              // A zero is left out: "−0.00 respect" reads as a loss that was not one.
              r.respect_lost > 0 && `−${fmt(r.respect_lost, 2)} respect`].filter(Boolean).join(' · ')} />
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <MemberBoard title="Most targeted members" rows={targets.most_targeted} columns={BOARD_TARGETED}
          expand={(r) => <WhoAttacked eventId={event.id} memberId={r.id} />} />
        <Ranked title="Who attacked us most" rows={targets.top_attackers_on_us} unit="attacks" render={(r) => fmt(r.hits)}
          who={(r) => <AttackLink id={r.id} name={r.name} />} />
        <MemberBoard title="Busiest members" rows={targets.most_active} columns={BOARD_BUSY} />
        <Ranked title="Who we attacked most" rows={targets.our_top_targets} unit="attacks" render={(r) => fmt(r.hits)} />
      </div>
      <div className="card p-0 sm:p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={TH}>
              {TARGET_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
                  className={c.key === 'name' ? FROZEN_TH : ''}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800 max-w-[12rem] truncate"><PlayerLink id={m.id} name={m.name} /></td>
                <td className={TD}>{fmt(m.outgoing)}</td>
                <td className={TD}>{fmt(m.distinct_targets)}</td>
                <td className={TD}>{fmt(m.incoming)}</td>
                <td className={TD}>{fmt(m.beaten)}</td>
                <td className={TD}>{fmt(m.defended)}</td>
                <td className={TD}>{fmt(m.distinct_attackers)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        A stealthed attack still counts against the member it was on, but Torn does not say who made it,
        so it is missing from &quot;Who attacked us most&quot;.
      </p>
    </div>
  )
}

const DAY_MS = 86_400_000

/**
 * "2026-10-26T14:30:05" (TCT, from a datetime-local input with seconds) →
 * epoch ms. ⚠️ Read as UTC — TCT is UTC, and the input carries no zone.
 * Seconds are optional: browsers drop ":00" from the value.
 */
export function tctDateTimeMs(v) {
  // ⚠️ Seconds AND a fraction are optional: an input normalises "14:30:05" to
  // "14:30:05.000" (seen in jsdom; browsers may too) and drops ":00" entirely.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(v ?? '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) : null
}
/** epoch ms → "2026-10-26T14:30:05", as TCT, for a datetime-local input. */
const msToTctSeconds = (ms) => new Date(ms).toISOString().slice(0, 19) // db-time-safe: epoch ms
const dayLabel = (ms) => formatTct(ms).replace(/ \d\d:\d\d TCT$/, '')

/**
 * The query for a range, or '' for the whole event.
 * ⚠️ Only a range with both ends ever reaches the server — an unfinished one
 * once sent `from=undefined` and surfaced the server's 400 to the member.
 */
export function rangeQuery(range) {
  if (!range || range.kind === 'overall') return ''
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return ''
  return `?from=${range.from}&to=${range.to}`
}

/** "stricken" → "Stricken"; "eviscareted" is Torn's own spelling, kept. */
const effectLabel = (e) => e.charAt(0).toUpperCase() + e.slice(1).replace(/-/g, ' ')

const TRACKED_EMPTY = {
  revitalize: 'No Revitalize proc in a log yet. The first one shows up here, under whatever name Torn gives it.',
  treats: 'No treat seen in a log yet. Treats show up here once the first one is read.',
}

/**
 * Stats (Daily + Highlights, merged): every figure for ONE range — the whole
 * event, a single TCT day, or a custom span of days. Fetched per range, and
 * again whenever the report itself reloads (`stamp`), so it stays live.
 */
function Stats({ event, days, stamp }) {
  const [range, setRange] = useState({ kind: 'overall' })
  const [picking, setPicking] = useState(false)
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [customError, setCustomError] = useState(null)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const q = rangeQuery(range)

  useEffect(() => {
    let alive = true
    apiGet(`/api/events/${event.id}/stats${q}`)
      .then((d) => { if (alive) { setData(d); setError(null) } })
      .catch((err) => { if (alive) setError(err.message || 'Could not load the stats.') })
    return () => { alive = false }
  }, [event.id, q, stamp])

  const rows = useMemo(() => data?.members ?? [], [data])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, DAY_COLS, { initialCol: 'hits', initialDir: 'desc', tieBreak: 'name' })

  const chip = (active) => `px-3 py-1 rounded-lg text-sm whitespace-nowrap shrink-0 tabular-nums ${active
    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
    : 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-200'}`
  const openCustom = () => {
    // Start from the range on screen, so a small adjustment is a small edit.
    if (!picking && data) setCustom({ from: msToTctSeconds(data.from), to: msToTctSeconds(data.to) })
    setCustomError(null)
    setPicking(true)
  }
  const applyCustom = () => {
    const from = tctDateTimeMs(custom.from)
    const to = tctDateTimeMs(custom.to)
    if (from == null || to == null) { setCustomError('Pick a date and a time for both ends.'); return }
    if (to <= from) { setCustomError('The end has to be after the start.'); return }
    setCustomError(null)
    setRange({ kind: 'custom', from, to })
  }

  const t = data?.totals
  const h = data?.highlights
  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Range">
        <button type="button" className={chip(range.kind === 'overall')} aria-pressed={range.kind === 'overall'}
          onClick={() => { setRange({ kind: 'overall' }); setPicking(false) }}>Overall</button>
        {days.map((d) => {
          const active = range.kind === 'day' && range.from === d.starts_at
          return (
            <button key={d.day} type="button" className={chip(active)} aria-pressed={active}
              onClick={() => { setRange({ kind: 'day', from: d.starts_at, to: d.starts_at + DAY_MS }); setPicking(false) }}>
              {dayLabel(d.starts_at)}
            </button>
          )
        })}
        <button type="button" className={chip(range.kind === 'custom' || picking)}
          aria-pressed={range.kind === 'custom'} onClick={openCustom}>
          Custom
        </button>
      </div>
      {(picking || range.kind === 'custom') && (
        <div className="card p-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-300">From (TCT)</span>
            <input type="datetime-local" step="1" className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1"
              value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-600 dark:text-gray-300">To (TCT)</span>
            <input type="datetime-local" step="1" className="rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1"
              value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </label>
          <button type="button" onClick={applyCustom} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium">Show</button>
          {customError && <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">{customError}</p>}
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data ? (!error && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>) : (
        <>
          <p className="text-xs text-gray-500 dark:text-gray-400">{formatTct(data.from)} → {formatTct(data.to)}</p>
          <div className="grid gap-2 sm:gap-3 grid-cols-3 sm:grid-cols-6">
            <Stat label="Attacks won">{fmt(t?.hits ?? 0)}</Stat>
            <Stat label="Respect">{fmt(t?.respect ?? 0, 2)}</Stat>
            <Stat label="Mugs">{fmt(t?.mug ?? 0)}</Stat>
            <Stat label="Assists">{fmt(t?.assists ?? 0)}</Stat>
            <Stat label="Retaliations">{fmt(t?.retaliations ?? 0)}</Stat>
            <Stat label="Hit by others">{fmt(t?.incoming ?? 0)}</Stat>
          </div>

          {/* The two that matter most: Revitalize and treats (#975). */}
          <div className="grid gap-3 md:grid-cols-2">
            {(h?.tracked ?? [{ key: 'revitalize', label: 'Revitalize', total: 0, by_member: [] }, { key: 'treats', label: 'Treats', total: 0, by_member: [] }])
              .map((tr) => (
                <MemberBoard key={tr.key} title={`${tr.label}${tr.total ? ` · ${fmt(tr.total)} ${tr.total === 1 ? 'proc' : 'procs'}` : ''}`} rows={tr.by_member}
                  columns={BOARD_COUNT} empty={TRACKED_EMPTY[tr.key] ?? 'None yet.'} showCount={false} />
              ))}
          </div>

          {!h ? (
            <div className="card p-6 text-sm text-gray-600 dark:text-gray-300">
              Highlights appear once attack logs for this range have been archived and read, usually within a minute or two of an attack.
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-4">
                <Stat label="Money mugged">${fmt(h.total_mugged)}</Stat>
                <Stat label="Damage dealt">{fmt(h.total_damage)}</Stat>
                <Stat label="Bounties claimed">
                  {fmt(h.bounties.claimed)}
                  {h.bounties.claimed > 0 && <span className="block text-xs text-gray-500 dark:text-gray-400">${fmt(h.bounties.total)}</span>}
                </Stat>
                <Stat label="Loot drops">{fmt(h.loot.drops)}</Stat>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <MemberBoard title="Loot drops" rows={h.loot.by_member} columns={BOARD_LOOT}
                  empty="No loot dropped in this range." expand={(r) => <LootDetail row={r} />} />
                <div className="card p-4 space-y-3 text-sm min-w-0">
                  <h4 className="font-semibold text-gray-900 dark:text-white">Loot by item</h4>
                  {h.loot.by_item.length === 0 ? <p className="text-gray-500 dark:text-gray-400">None yet.</p> : (
                    <ul className="flex flex-wrap gap-2">
                      {h.loot.by_item.map((x) => (
                        <li key={x.item} className="px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-800 dark:text-gray-200">
                          {x.item} <span className="tabular-nums text-gray-500 dark:text-gray-400">×{fmt(x.qty)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {h.loot.by_source.length > 0 && (
                    <p className="text-gray-600 dark:text-gray-300">
                      From:{' '}
                      {h.loot.by_source.map((x, i) => (
                        <span key={x.from_id ?? x.from}>{i > 0 && ', '}<PlayerLink id={x.from_id} name={x.from} /> ({fmt(x.drops)})</span>
                      ))}
                    </p>
                  )}
                </div>
                <MemberBoard title="Most earned from bounties" rows={h.bounties.by_member} columns={BOARD_BOUNTY}
                  empty="No bounties claimed." />
                <Ranked title="Highest bounties claimed" rows={h.bounties.top}
                  render={(r) => <>${fmt(r.amount)} on <PlayerLink id={r.target_id} name={r.target} /></>} empty="No bounties claimed." />
                <Ranked title="Highest mugs" rows={h.highest_mugs}
                  render={(r) => <>${fmt(r.amount)} from <PlayerLink id={r.target_id} name={r.target} /></>} />
                <Ranked title="Biggest single hits" rows={h.biggest_hits}
                  render={(r) => <>{fmt(r.damage)} on <PlayerLink id={r.opponent_id} name={r.opponent} /></>} />
              </div>
            </>
          )}

          <div className="card p-0 sm:p-0 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className={TH}>
                  {DAY_COLS.map((c) => (
                    <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}
                      className={c.key === 'name' ? FROZEN_TH : ''}>{c.label}</SortableTh>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((m) => (
                  <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                    <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 z-[5] bg-white dark:bg-slate-800 max-w-[12rem] truncate"><PlayerLink id={m.id} name={m.name} /></td>
                    <td className={TD}>{fmt(m.hits)}</td>
                    <td className={TD}>{fmt(m.respect, 2)}</td>
                    <td className={TD}>{fmt(m.mug)}</td>
                    <td className={TD}>{fmt(m.hospitalize)}</td>
                    <td className={TD}>{fmt(m.leave)}</td>
                    <td className={TD}>{fmt(m.assists)}</td>
                    <td className={TD}>{fmt(m.losses)}</td>
                    <td className={TD}>{fmt(m.retaliations)}</td>
                    <td className={TD}>{fmt(m.incoming)}</td>
                    <td className={TD}>{fmt(m.defended)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {h && Object.keys(h.effect_totals).length > 0 && (
            <details className="card p-4 text-sm">
              <summary className="cursor-pointer font-semibold text-gray-900 dark:text-white">
                All effects seen ({fmt(Object.keys(h.effect_totals).length)})
              </summary>
              <ul className="mt-3 flex flex-wrap gap-2">
                {Object.entries(h.effect_totals).sort((a, b) => b[1] - a[1]).map(([e, n]) => (
                  <li key={e} className="px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-800 dark:text-gray-200">
                    {effectLabel(e)} <span className="tabular-nums text-gray-500 dark:text-gray-400">{fmt(n)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            From our synced attacks and their archived logs, so a stretch interrupted by an outage fills in once Torn is back.
            Respect here is raw, per attack.
          </p>
        </>
      )}
    </div>
  )
}

const shortTct = (ms) => formatTct(ms).replace(/ TCT$/, '')

/**
 * Everyone who attacked one member — the row expansion on "Most targeted".
 * ⚠️ Stealthed is a row of its own, so the rows add up to the member's total.
 * Attackers link to the ATTACK page.
 */
function WhoAttacked({ eventId, memberId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => apiGet(`/api/events/${eventId}/targeted/${memberId}`))
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load who attacked them.') })
    return () => { alive = false }
  }, [eventId, memberId])
  if (error) return <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
  if (!data) return <p className="text-xs text-gray-500 dark:text-gray-400">Loading…</p>
  return (
    <ul className="space-y-0.5 text-xs text-gray-600 dark:text-gray-300">
      {data.attackers.map((a) => (
        <li key={a.id ?? 'stealthed'}>
          {a.id == null ? <span className="italic">Stealthed</span> : <AttackLink id={a.id} name={a.name} />}
          {' · '}{fmt(a.attacks)} {a.attacks === 1 ? 'attack' : 'attacks'}
          {a.won > 0 && ` · ${fmt(a.won)} beat them`}
          {a.failed > 0 && ` · ${fmt(a.failed)} failed`}
          {a.respect_taken > 0 && ` · −${fmt(a.respect_taken, 2)} respect`}
        </li>
      ))}
    </ul>
  )
}

/**
 * The wanted board (MonChoon, 2026-10-18): outsiders who attacked ONE of our
 * members the event's threshold times or more, win or lose.
 *
 * ⚠️ One click puts someone in the Book of Grudges. ⚠️ Leadership can take
 * someone off — a member paying for defends or losses gets attacked on
 * purpose, and that attacker must not become a target. Removed entries stay
 * listed, folded, with a way back.
 */
function WantedBoard({ event, isLeadership, stamp }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [done, setDone] = useState({})
  const load = useCallback(() => Promise.resolve().then(() => apiGet(`/api/events/${event.id}/wanted`))
    .then((d) => { setData(d); setError(null) })
    .catch((e) => setError(e?.message || 'Could not load the wanted board.')), [event.id])
  useEffect(() => { load() }, [load, stamp])

  const grudge = async (w) => {
    setBusy(w.id)
    try {
      const victims = w.victims.slice(0, 3).map((v) => `${v.name} ×${v.attacks}`).join(', ')
      const res = await apiPost('/api/grudges', {
        target: String(w.id),
        reason: `Wanted during ${event.name}: ${w.attacks} attacks on us (${victims})`,
      })
      setDone((d) => ({ ...d, [w.id]: res?.state === 'pending_approval' ? 'Added, held for approval' : 'Added to grudges' }))
    } catch (e) {
      setDone((d) => ({ ...d, [w.id]: e?.message || 'Could not add' }))
    } finally {
      setBusy(null)
    }
  }
  const dismiss = async (w) => {
    const note = window.prompt(`Take ${w.name} off the wanted board? Add a note (e.g. "paid defends"):`, '')
    if (note === null) return
    setBusy(w.id)
    try { await apiPost(`/api/events/${event.id}/wanted/${w.id}/dismiss`, { note }); await load() } finally { setBusy(null) }
  }
  const restore = async (w) => {
    setBusy(w.id)
    try { await apiDelete(`/api/events/${event.id}/wanted/${w.id}/dismiss`); await load() } finally { setBusy(null) }
  }

  const row = (w, removed) => (
    <li key={w.id} className="py-2 border-t border-gray-100 dark:border-slate-700 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 truncate font-medium">
          <AttackLink id={w.id} name={w.name} />
          {w.faction_id != null && (
            <span className="text-xs text-gray-500 dark:text-gray-400"> · <FactionLink id={w.faction_id} name={w.faction_name} /></span>
          )}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {!removed && (
            <button type="button" disabled={busy === w.id || !!done[w.id]} onClick={() => grudge(w)}
              className="px-2 py-0.5 rounded text-xs font-medium bg-blue-600 text-white disabled:opacity-50">
              {done[w.id] ?? 'Add to grudges'}
            </button>
          )}
          {isLeadership && (removed ? (
            <button type="button" disabled={busy === w.id} onClick={() => restore(w)}
              className="px-2 py-0.5 rounded text-xs border border-gray-300 dark:border-slate-600 disabled:opacity-50">Restore</button>
          ) : (
            <button type="button" disabled={busy === w.id} onClick={() => dismiss(w)}
              className="px-2 py-0.5 rounded text-xs border border-gray-300 dark:border-slate-600 disabled:opacity-50">Remove</button>
          ))}
        </span>
      </div>
      <div className="text-xs text-gray-600 dark:text-gray-300 tabular-nums mt-0.5">
        {fmt(w.attacks)} attacks · {fmt(w.won)} beat us · {fmt(w.failed)} failed
        {w.respect_taken > 0 && ` · −${fmt(w.respect_taken, 2)} respect`}
        {' · '}{shortTct(w.first_ms)} → {shortTct(w.last_ms)}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
        On:{' '}
        {w.victims.map((v, i) => (
          <span key={v.id}>{i > 0 && ', '}<PlayerLink id={v.id} name={v.name} /> ×{fmt(v.attacks)}</span>
        ))}
      </div>
      {removed && w.note && <div className="text-xs italic text-gray-500 dark:text-gray-400 mt-0.5">Removed: {w.note}</div>}
    </li>
  )

  return (
    <div className="card p-4 min-w-0">
      <h4 className="font-semibold text-gray-900 dark:text-white">
        Wanted {data && <span className="text-sm font-normal text-gray-500 dark:text-gray-400">({fmt(data.wanted.length)})</span>}
      </h4>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        Anyone who attacked one of our members {data?.threshold ?? event.wanted_min_attacks ?? 3}+ times during {event.name}, win or lose.
        Names open the attack page.
      </p>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data ? (!error && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>) : (
        <>
          {data.wanted.length === 0
            ? <p className="text-sm text-gray-500 dark:text-gray-400">Nobody yet.</p>
            : <ol className="max-h-[30rem] overflow-y-auto pr-1">{data.wanted.map((w) => row(w, false))}</ol>}
          {data.dismissed.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-gray-600 dark:text-gray-300">Removed by leadership ({fmt(data.dismissed.length)})</summary>
              <ol className="mt-1">{data.dismissed.map((w) => row(w, true))}</ol>
            </details>
          )}
        </>
      )}
    </div>
  )
}
