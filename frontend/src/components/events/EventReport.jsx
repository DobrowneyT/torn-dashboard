import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet } from '../../utils/apiClient'
import SortableTh, { useTableSort } from '../SortableTh'
import { formatTct } from '../../utils/factionEvent'

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
const REFRESH_MS = 30_000
const VIEWS = [
  { id: 'totals', label: 'Totals' },
  { id: 'members', label: 'Members' },
  { id: 'daily', label: 'Daily' },
  { id: 'targets', label: 'Targets' },
]

const fmt = (n, dp = 0) => (n == null ? '—' : Number(n).toLocaleString(undefined, {
  minimumFractionDigits: dp, maximumFractionDigits: dp,
}))
const TH = 'text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400'
const TD = 'px-3 py-1.5 tabular-nums'

export default function EventReport({ event }) {
  const [view, setView] = useState('totals')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setData(await apiGet(`/api/events/${event.id}/report`))
      setError(null)
    } catch (err) {
      // Keep the last report on screen; say it is stale.
      setError(err.message || 'Could not load the report.')
    }
  }, [event.id])

  useEffect(() => {
    load()
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const color = event.theme_color
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
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
          {view === 'daily' && <Daily daily={data.daily} event={event} />}
          {view === 'targets' && <Targets targets={data.targets} />}
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
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl text-gray-900 dark:text-white tabular-nums">{children}</div>
    </div>
  )
}

function Totals({ chain, event }) {
  if (!chain) return <NoChain event={event} />
  const t = chain.totals
  const counters = [
    ['Hits', t.hits], ['Leave', t.leave], ['Mugs', t.mug], ['Hospitalizations', t.hospitalize],
    ['Assists', t.assists], ['Retaliations', t.retaliations], ['Overseas', t.overseas],
    ['Losses', t.losses], ['Escapes', t.escapes], ['Draws', t.draws], ['Bonuses', t.bonuses],
    ['Members hitting', t.members],
  ]
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Chain">{fmt(t.chain)}</Stat>
        <Stat label="Respect">
          <Respect raw={t.respect.raw} capped={t.respect.capped} deduction={t.respect.deduction} />
        </Stat>
        <Stat label="Best hit">{fmt(t.best, 2)}</Stat>
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {counters.map(([k, v]) => <Stat key={k} label={k}>{fmt(v)}</Stat>)}
      </div>
      {chain.bonuses.length > 0 && (
        <div className="card p-4 overflow-x-auto">
          <h4 className="font-semibold text-gray-900 dark:text-white mb-2">Bonus hits</h4>
          <table className="min-w-full text-sm">
            <thead><tr className={TH}><th className="px-3 py-1.5">Hit</th><th className="px-3 py-1.5">Member</th><th className="px-3 py-1.5">Respect</th><th className="px-3 py-1.5">Capped at 10</th></tr></thead>
            <tbody>
              {chain.bonuses.map((b) => (
                <tr key={b.chain} className="border-t border-gray-100 dark:border-slate-700">
                  <td className={TD}>{fmt(b.chain)}</td>
                  <td className="px-3 py-1.5">{b.attacker}</td>
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
  { key: 'hits', label: 'Hits', kind: 'number', accessor: (m) => m.attacks.total },
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
  { key: 'bonus_hits', label: 'Bonuses', kind: 'number', accessor: (m) => m.bonus_hits },
]

function Members({ chain }) {
  const rows = useMemo(() => chain?.members ?? [], [chain])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, MEMBER_COLS, { initialCol: 'hits', initialDir: 'desc', tieBreak: 'name' })
  if (!chain) return <NoChain event={{ phase: 'live' }} />
  return (
    <div className="space-y-4">
      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={TH}>
              {MEMBER_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                <td className="px-3 py-1.5 whitespace-nowrap">{m.name}</td>
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
          Not hit yet ({chain.non_attackers.length})
        </h4>
        {chain.non_attackers.length === 0
          ? <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">Everyone has hit.</p>
          : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {chain.non_attackers.map((m) => (
                <li key={m.id} className="text-sm px-2 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-800 dark:text-gray-200">{m.name}</li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

const DAY_COLS = [
  { key: 'name', label: 'Member', kind: 'string' },
  { key: 'hits', label: 'Hits', kind: 'number' },
  { key: 'respect', label: 'Respect', kind: 'number' },
  { key: 'mug', label: 'Mugs', kind: 'number' },
  { key: 'hospitalize', label: 'Hosp', kind: 'number' },
  { key: 'leave', label: 'Leave', kind: 'number' },
  { key: 'assists', label: 'Assists', kind: 'number' },
  { key: 'losses', label: 'Losses', kind: 'number' },
  { key: 'incoming', label: 'Hit by others', kind: 'number' },
  { key: 'defended', label: 'Defended', kind: 'number' },
]

function Daily({ daily, event }) {
  const [pick, setPick] = useState(null)
  const day = daily.find((d) => d.day === pick) ?? daily[daily.length - 1] ?? null
  const rows = useMemo(() => day?.members ?? [], [day])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, DAY_COLS, { initialCol: 'hits', initialDir: 'desc', tieBreak: 'name' })
  if (!day) {
    return (
      <div className="card p-6 text-sm text-gray-600 dark:text-gray-300">
        Daily figures start {formatTct(event.daily_from)}.
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {daily.map((d) => (
          <button
            key={d.day}
            type="button"
            onClick={() => setPick(d.day)}
            aria-pressed={d.day === day.day}
            className={`px-3 py-1 rounded-lg text-sm tabular-nums ${d.day === day.day
              ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
              : 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-200'}`}
          >
            {formatTct(d.starts_at).replace(/ \d\d:\d\d TCT$/, '')}
          </button>
        ))}
      </div>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
        <Stat label="Hits">{fmt(day.totals.hits)}</Stat>
        <Stat label="Respect">{fmt(day.totals.respect, 2)}</Stat>
        <Stat label="Mugs">{fmt(day.totals.mug)}</Stat>
        <Stat label="Assists">{fmt(day.totals.assists)}</Stat>
        <Stat label="Hit by others">{fmt(day.totals.incoming)}</Stat>
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={TH}>
              {DAY_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                <td className="px-3 py-1.5 whitespace-nowrap">{m.name}</td>
                <td className={TD}>{fmt(m.hits)}</td>
                <td className={TD}>{fmt(m.respect, 2)}</td>
                <td className={TD}>{fmt(m.mug)}</td>
                <td className={TD}>{fmt(m.hospitalize)}</td>
                <td className={TD}>{fmt(m.leave)}</td>
                <td className={TD}>{fmt(m.assists)}</td>
                <td className={TD}>{fmt(m.losses)}</td>
                <td className={TD}>{fmt(m.incoming)}</td>
                <td className={TD}>{fmt(m.defended)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        From our synced attacks, so a day interrupted by an outage fills in once Torn is back.
        Respect here is raw, per attack.
      </p>
    </div>
  )
}

function Ranked({ title, rows, unit, render }) {
  return (
    <div className="card p-4">
      <h4 className="font-semibold text-gray-900 dark:text-white mb-2">{title}</h4>
      {rows.length === 0
        ? <p className="text-sm text-gray-500 dark:text-gray-400">Nothing yet.</p>
        : (
          <ol className="space-y-1 text-sm">
            {rows.map((r, i) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span className="truncate"><span className="text-gray-400 tabular-nums mr-2">{i + 1}.</span>{r.name}</span>
                <span className="tabular-nums text-gray-700 dark:text-gray-200 whitespace-nowrap">{render(r)} {unit}</span>
              </li>
            ))}
          </ol>
        )}
    </div>
  )
}

const TARGET_COLS = [
  { key: 'name', label: 'Member', kind: 'string' },
  { key: 'outgoing', label: 'Attacks made', kind: 'number' },
  { key: 'distinct_targets', label: 'Different targets', kind: 'number' },
  { key: 'incoming', label: 'Attacked', kind: 'number' },
  { key: 'beaten', label: 'Beaten', kind: 'number' },
  { key: 'defended', label: 'Defended', kind: 'number' },
  { key: 'distinct_attackers', label: 'Different attackers', kind: 'number' },
]

function Targets({ targets }) {
  const rows = useMemo(() => targets?.members ?? [], [targets])
  const { sorted, sortCol, sortDir, onSort } = useTableSort(rows, TARGET_COLS, { initialCol: 'incoming', initialDir: 'desc', tieBreak: 'name' })
  if (!targets) return null
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Ranked title="Most targeted members" rows={targets.most_targeted} unit="attacks" render={(r) => fmt(r.incoming)} />
        <Ranked title="Who hit us most" rows={targets.top_attackers_on_us} unit="attacks" render={(r) => fmt(r.hits)} />
        <Ranked title="Busiest members" rows={targets.most_active} unit="attacks" render={(r) => fmt(r.outgoing)} />
        <Ranked title="Who we hit most" rows={targets.our_top_targets} unit="hits" render={(r) => fmt(r.hits)} />
      </div>
      <div className="card overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className={TH}>
              {TARGET_COLS.map((c) => (
                <SortableTh key={c.key} col={c} sortCol={sortCol} sortDir={sortDir} onSort={onSort}>{c.label}</SortableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m) => (
              <tr key={m.id} className="border-t border-gray-100 dark:border-slate-700">
                <td className="px-3 py-1.5 whitespace-nowrap">{m.name}</td>
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
        A stealthed attack still counts against the member it hit, but Torn does not say who made it,
        so it is missing from &quot;Who hit us most&quot;.
      </p>
    </div>
  )
}
