/**
 * Chain economics for one crime (#712).
 *
 * ⚠️ **The break-even is the whole reason this exists.** Scope is paid once at
 * the root and repaid only at the terminal link, only if every link succeeded,
 * so the reward stays flat while the probability of collecting it COMPOUNDS.
 * Elaborate breaks even at 83.3% standalone but **91.3% per link over two** and
 * **94.1% over three**. The standalone scope verdict shown elsewhere on this
 * page is the wrong number for a chain, and without this panel a reader has no
 * way to know that.
 *
 * ⚠️ Its own file, like the guidance panel — the Simulator view has taken this
 * page down once already (v3.97.0) and does not need more hooks.
 */
import { formatCurrency } from '../utils/payoutCalculations'

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)

export function ChainPanel({ chain, onCompute, computing, rootName }) {
  if (!chain && !onCompute) return null

  if (!chain) {
    return (
      <div className="mt-3">
        <button type="button" onClick={onCompute} disabled={computing}
          aria-busy={computing || undefined}
          className="text-xs text-indigo-600 dark:text-indigo-400 disabled:opacity-60 inline-flex items-center gap-1.5 underline">
          {computing && (
            <span aria-hidden="true"
              className="w-3 h-3 rounded-full border-2 border-current/30 border-t-current animate-spin" />
          )}
          {computing ? 'Working…' : 'Value this chain'}
        </button>
      </div>
    )
  }

  const { links, scope, value, confident, assumedCpr, missing } = chain

  return (
    <div className="mt-3 rounded border border-indigo-300 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
        Chain — {links.length} links
      </div>
      <div className="mt-0.5 text-sm font-medium">
        {links.map((l) => l.name).join(' → ')}
      </div>

      {missing.length > 0 && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {missing.join(', ')} could not be priced, so nothing below can be computed.
        </p>
      )}

      {value && (
        <p className="mt-1.5 text-sm">
          {/* ⚠️ The root's own E(x) is not the chain's value. Spawning the root
              buys the whole chain, and that is the figure a leader decides on. */}
          Spawning <strong>{rootName}</strong> is worth{' '}
          <strong className="tabular-nums">
            {value.complete ? '' : 'at least '}{formatCurrency(Math.round(value.expected))}
          </strong>{' '}
          across the chain, completing {pct(chain.chainedSuccess)} of the time.
        </p>
      )}

      {scope && (
        <div className="mt-1.5 text-xs">
          {/* ⚠️ equivalentSuccess against breakEvenPerLink, NOT the chained
              probability against a per-link bar. Comparing those makes every
              chain look doomed and is the natural mistake. */}
          <div className={scope.sustainable ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            <strong>
              {scope.sustainable ? 'Scope-positive' : 'Scope-negative'} — {scope.net >= 0 ? '+' : ''}
              {scope.net.toFixed(2)} scope per chain
            </strong>
          </div>
          <div className="text-gray-600 dark:text-gray-400 mt-0.5">
            Costs {scope.cost} at the root, pays {scope.reward} only if every link lands. Over{' '}
            {scope.links} links each must clear <strong>{pct(scope.breakEvenPerLink)}</strong> —
            not the {pct(scope.cost / scope.reward)} a standalone crime needs — and this crew
            averages {pct(scope.equivalentSuccess)} per link.
          </div>
        </div>
      )}

      <ul className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 list-disc pl-4 space-y-0.5">
        {/* ⚠️ The crew assumption, stated. Links have different role counts, so
            the sliders on screen cannot be carried downstream. */}
        <li>
          Downstream links priced at a flat {Math.round(assumedCpr)} CPR — they have different
          roles, so the crew on screen cannot carry across.
        </li>
        {!confident && (
          <li className="text-amber-600 dark:text-amber-400">
            This faction has not observed every link itself — taken from known Torn chains, so
            treat the links as unverified here.
          </li>
        )}
      </ul>
    </div>
  )
}
