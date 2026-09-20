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
import { AlertTriangle, LoaderCircle, ArrowUpDown, Link2 } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import { rankCrimes, sortRanking } from '../../utils/ocRanking'
import { formatCurrency } from '../../utils/payoutCalculations'
import InfoTooltip from '../InfoTooltip'

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

export default function CrimeRankingTable({ scenarios, chains = [] }) {
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

  // ⚠️ Chain children are dropped from the table, not hidden behind a toggle.
  // Ace in the Hole has 0 standalone runs against 124 spawned — it is not a
  // choice anyone can make, so listing it offers a decision that does not
  // exist, and counting it beside its own parent double-counts the pipeline.
  // It keeps its own card in the Simulator, where its crew and success chance
  // are still real and still worth optimising.
  const rows = useMemo(
    () => sortRanking(
      rankCrimes(scenarios, success, { chains }).filter((r) => r.spawnable !== false),
      sort.key, sort.dir,
    ),
    [scenarios, success, sort, chains]
  )

  const chained = rows.filter((r) => r.chainLinks)

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

      {/* #585 — the correction that changes decisions, so it is stated up
          front rather than left to a badge someone has to notice. */}
      {chained.length > 0 && (
        <div className="mb-3 flex items-start gap-2 text-xs text-blue-700 dark:text-blue-300">
          <Link2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {chained.length} crime{chained.length === 1 ? ' is a chain' : 's are chains'} — the
            payout sits one or two crimes downstream, and their value here is the{' '}
            <strong>whole chain&apos;s</strong>. Scope is spent once at the start and only repaid if{' '}
            <strong>every</strong> link succeeds, so the break-even climbs with length: 83.3% for a
            standalone Elaborate, 91.3% per link over two, 94.1% over three. The crimes they spawn
            are not listed — you cannot choose them.
          </span>
        </div>
      )}

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
                  {r.chainLinks && (
                    <InfoTooltip
                      label={`chain ×${r.chainLinks.length}${!r.chainConfident ? '?' : ''}`}
                      className={`ml-1.5 text-[10px] ${r.chainConfident ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400'}`}
                    >
                      <div className="font-medium">{r.chainLinks.join(' → ')}</div>
                      <div className="mt-1.5">
                        Value and scope are for the whole chain.{' '}
                        {r.chainConfident
                          ? 'Confirmed from our own spawn history.'
                          : 'Not yet observed in this faction — taken from known Torn chains, so treat the link as unverified here.'}
                      </div>
                    </InfoTooltip>
                  )}
                  {r.paysInItems && (
                    <InfoTooltip label="items" className="ml-1.5 text-[10px] text-blue-600 dark:text-blue-400">
                      Pays in items rather than cash — valued from our own completed
                      runs at current prices.
                    </InfoTooltip>
                  )}
                  {/* ⚠️ An item we cannot price contributes nothing, so this
                      crime's value is an understatement, not an estimate. */}
                  {r.unpricedItemRows > 0 && (
                    <InfoTooltip label="under" className="ml-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                      {r.unpricedItemRows} item drop(s) have no market or sell price,
                      so they count as zero — this crime is worth more than shown.
                    </InfoTooltip>
                  )}
                </td>
                <td className="py-2 px-2 text-xs text-gray-500 dark:text-gray-400">{r.categoryLabel ?? '—'}</td>
                <td className="py-2 px-2 text-right tabular-nums">
                  {r.successChance == null ? '—' : (
                    <span className={r.sustainable === false ? 'text-red-600 dark:text-red-400' : ''}>
                      {/* ⚠️ For a chain, the figure compared against the
                          break-even is the per-link geometric mean, not the
                          chained probability — comparing 30% against a 94.1%
                          per-link bar is the natural mistake and it makes every
                          chain look far worse than it is. */}
                      {((r.equivalentSuccess ?? r.successChance) * 100).toFixed(1)}%
                      {r.breakEven != null && (
                        <span className="text-gray-400 text-xs"> /{(r.breakEven * 100).toFixed(0)}</span>
                      )}
                      {r.chainedSuccess != null && (
                        <InfoTooltip
                          label={`${(r.chainedSuccess * 100).toFixed(0)}% end-to-end`}
                          className="block text-[10px] text-gray-400"
                        >
                          Chance the whole chain completes — every link has to succeed
                          for the scope to come back.
                        </InfoTooltip>
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
                    <InfoTooltip
                      label={`${r.spawnsPerWeek.toFixed(1)}${r.spawnConfident ? '' : '?'}`}
                      decoration={r.spawnConfident ? 'no-underline' : undefined}
                      className={r.spawnConfident ? '' : 'text-amber-600 dark:text-amber-400'}
                    >
                      {r.spawnConfident
                        ? null
                        : `Only ${r.spawnRuns} run${r.spawnRuns === 1 ? '' : 's'} on record — not a reliable rate.`}
                    </InfoTooltip>
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
  return <InfoTooltip label="—" className="text-gray-400">{label}</InfoTooltip>
}
