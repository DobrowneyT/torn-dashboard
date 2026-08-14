/**
 * Which crimes are worth spawning (#444).
 *
 * ⚠️ Ranked on **money per scope**, not E(x). Scope is what runs out, so the
 * crime that turns each point of it into the most value wins even when a
 * pricier crime pays more per run.
 *
 * ⚠️ The CPR assumption is stated on the table, not buried. E(x) is a function
 * of the crew; a ranking computed at a CPR nobody has ranks crimes by a crew
 * that does not exist, and a ranking whose assumption is invisible is worse
 * than no ranking because it looks like a fact.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, LoaderCircle, ArrowUpDown } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import { rankCrimes, sortRanking } from '../../utils/ocRanking'
import { formatCurrency } from '../../utils/payoutCalculations'

const DEFAULT_CPR = 75

const COLUMNS = [
  { key: 'name', label: 'Crime', align: 'left' },
  { key: 'categoryLabel', label: 'Type', align: 'left' },
  { key: 'successChance', label: 'Success', align: 'right' },
  { key: 'scopeCost', label: 'Scope', align: 'right' },
  { key: 'totalPerRun', label: 'Value / run', align: 'right' },
  { key: 'moneyPerScope', label: 'Value / scope', align: 'right' },
  { key: 'spawnsPerWeek', label: 'Spawns / wk', align: 'right' },
  { key: 'incomePerWeek', label: 'Income / wk', align: 'right' },
]

export default function CrimeRankingTable({ scenarios }) {
  const [cpr, setCpr] = useState(DEFAULT_CPR)
  const [applied, setApplied] = useState(DEFAULT_CPR)
  const [success, setSuccess] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [sort, setSort] = useState({ key: 'moneyPerScope', dir: 'desc' })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    apiGet(`/api/oc-simulator/ranking?cpr=${applied}`)
      .then((res) => {
        if (cancelled) return
        const byName = {}
        for (const c of res.crimes ?? []) {
          if (typeof c.success === 'number') byName[c.name] = c.success
        }
        setSuccess(byName)
      })
      .catch((e) => { if (!cancelled) setError(e?.message || 'Could not rank crimes') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [applied])

  const rows = useMemo(
    () => sortRanking(rankCrimes(scenarios, success), sort.key, sort.dir),
    [scenarios, success, sort]
  )

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))

  const unsustainable = rows.filter((r) => r.sustainable === false).length

  return (
    <div className="card">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold">Which crimes are worth spawning</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Ranked by value per point of scope — scope is what runs out, not money.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-gray-500 dark:text-gray-400">
            Assumed CPR, every role
            <input
              type="number"
              min="0"
              max="100"
              value={cpr}
              onChange={(e) => setCpr(Number(e.target.value))}
              className="input ml-2 w-20 py-1"
            />
          </label>
          <button
            onClick={() => setApplied(cpr)}
            disabled={loading || cpr === applied}
            className="btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
          >
            {loading ? <LoaderCircle className="w-4 h-4 animate-spin" /> : 'Rank'}
          </button>
        </div>
      </div>

      {/* ⚠️ Never buried. The whole table is conditional on this number. */}
      <div className="mb-3 text-xs rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-amber-800 dark:text-amber-300">
        Every figure assumes <strong>every role at CPR {applied}</strong> — a crew we may not
        have. Use the per-crime cards for a real crew, and {' '}
        <span className="font-medium">Value / run is an approximation</span>: it weights the mean
        priced ending by success rather than using the full ending mix.
      </div>

      {error && <div className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</div>}

      {unsustainable > 0 && (
        <div className="mb-3 flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {unsustainable} crime{unsustainable === 1 ? '' : 's'} below the break-even success for
            their difficulty at this CPR. Those drain scope every run, however much they pay —
            shown struck through.
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-200 dark:border-slate-600">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`py-2 px-2 text-xs font-semibold cursor-pointer whitespace-nowrap hover:bg-gray-100 dark:hover:bg-slate-700 ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  {c.label}
                  <ArrowUpDown className={`inline w-3 h-3 ml-1 ${sort.key === c.key ? '' : 'opacity-25'}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.name}
                className="border-b border-gray-100 dark:border-slate-700/50 hover:bg-gray-50 dark:hover:bg-slate-700/30"
              >
                <td className={`py-2 px-2 font-medium ${r.sustainable === false ? 'line-through text-gray-400' : ''}`}>
                  {r.name}
                  {r.paysInItems && (
                    <span className="ml-1.5 text-[10px] text-blue-600 dark:text-blue-400"
                      title="Pays in items rather than cash — valued from our own completed runs at current prices">
                      items
                    </span>
                  )}
                  {/* ⚠️ An item we cannot price contributes nothing, so this
                      crime's value is an understatement, not an estimate. */}
                  {r.unpricedItemRows > 0 && (
                    <span className="ml-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                      title={`${r.unpricedItemRows} item drop(s) have no market or sell price, so they count as zero — this crime is worth more than shown`}>
                      under
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-xs text-gray-500 dark:text-gray-400">{r.categoryLabel ?? '—'}</td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {r.successChance == null ? '—' : (
                    <span className={r.sustainable === false ? 'text-red-600 dark:text-red-400' : ''}>
                      {(r.successChance * 100).toFixed(1)}%
                      {r.breakEven != null && (
                        <span className="text-gray-400 text-xs"> /{(r.breakEven * 100).toFixed(0)}</span>
                      )}
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular-nums">{r.scopeCost ?? '—'}</td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {r.totalPerRun == null ? <Unknown /> : formatCurrency(Math.round(r.totalPerRun))}
                </td>
                <td className="py-2 px-2 text-right tabular-nums font-medium">
                  {r.moneyPerScope == null ? <Unknown /> : formatCurrency(Math.round(r.moneyPerScope))}
                </td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {r.spawnsPerWeek == null ? <Unknown label="never run" /> : (
                    <span className={r.spawnConfident ? '' : 'text-amber-600 dark:text-amber-400'}
                      title={r.spawnConfident ? undefined : `Only ${r.spawnRuns} run${r.spawnRuns === 1 ? '' : 's'} on record — not a reliable rate`}>
                      {r.spawnsPerWeek.toFixed(1)}
                      {!r.spawnConfident && '?'}
                    </span>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular-nums font-semibold">
                  {r.incomePerWeek == null ? <Unknown /> : formatCurrency(Math.round(r.incomePerWeek))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        ⚠️ Spawn rates measure past <em>decisions</em> as much as capacity — a crime avoided because
        someone judged it not worth it reads as rare here. And crimes compete for the same members,
        so the top row is not a licence to run only that one.
      </p>
    </div>
  )
}

/** An em dash with a reason, never a zero. */
function Unknown({ label = 'no data' }) {
  return <span className="text-gray-400" title={label}>—</span>
}
