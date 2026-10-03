/**
 * Members → Upgrades (#458).
 *
 * What the faction has bought, and — the whole reason this page exists — which
 * half of it is actually doing something right now.
 *
 * ⚠️ **Torn splits the perk tree into `war` and `peace` branches and only one
 * side is in effect at a time.** A flat list of everything purchased is worse
 * than no page at all: it tells people they have bonuses they are not getting,
 * and someone plans a five-day training book around a Steadfast percentage
 * that is only live in war state. So the active set is visually primary and the
 * inactive set is present, collapsed, and labelled as not in effect.
 *
 * ⚠️ **Every effect string is Torn's own `ability` text, rendered verbatim.**
 * Nothing here re-derives a bonus from a level. Torn states the effect; we
 * repeat it. A wrong percentage on a gym-gain display looks exactly like a
 * right one.
 *
 * ⚠️ `unlockedMs` is epoch MILLIseconds, converted on the server from Torn's
 * epoch SECONDS. It is not a Postgres timestamp, so `parseDbTime` is the wrong
 * tool — see the note in `server/src/factionUpgrades.ts`.
 */
import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Swords, Handshake, ChevronDown, Lock } from 'lucide-react'
import { apiGet } from '../../utils/apiClient'
import InfoTooltip from '../InfoTooltip'

const STATE_LABEL = { war: 'At war', peace: 'At peace' }

/** Torn's own words, or the level alone when it said nothing. Never invented. */
function effectText(u) {
  if (u.ability) return u.ability
  return u.level != null ? `Level ${u.level}` : '—'
}

const fmtCost = (n) =>
  n == null ? null : `${n.toLocaleString()} respect`

const fmtUnlocked = (ms) => {
  if (!ms) return null
  // db-time-safe: `ms` is an epoch NUMBER, not a DB timestamp string. It starts
  // as Torn's `unlocked_at` in epoch SECONDS and the server multiplies it to
  // milliseconds (`unlockedMs`), so the bare "+00" offset of #140 cannot appear
  // here and `parseDbTime` would be the wrong tool — it parses strings.
  //
  // UTC, because Torn speaks TCT and a faction spans timezones — two people
  // reading this cell must not disagree about which day it was.
  // db-time-safe: epoch ms number, per the note above.
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

function UpgradeRow({ u, dimmed }) {
  return (
    <li className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 ${dimmed ? 'opacity-60' : ''}`}>
      <span className="font-medium">{u.name || `Upgrade ${u.id ?? ''}`}</span>
      {u.level != null && (
        <span className="rounded bg-gray-100 px-1.5 text-[11px] font-semibold tabular-nums text-gray-600 dark:bg-slate-700 dark:text-gray-300">
          Lv{u.level}
        </span>
      )}
      <span className="text-gray-600 dark:text-gray-400">{effectText(u)}</span>
      <span className="ml-auto flex shrink-0 items-baseline gap-2 text-[11px] text-gray-400 dark:text-gray-500">
        {fmtCost(u.cost) && <span className="tabular-nums">{fmtCost(u.cost)}</span>}
        {fmtUnlocked(u.unlockedMs) && <span className="tabular-nums">{fmtUnlocked(u.unlockedMs)}</span>}
      </span>
    </li>
  )
}

function Branch({ branch, dimmed }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-slate-700">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold">{branch.name || 'Unnamed branch'}</h4>
        {branch.multiplier != null && (
          <InfoTooltip
            label={<span className="text-[11px] tabular-nums text-gray-400 dark:text-gray-500">×{branch.multiplier}</span>}
          >
            Torn's respect cost multiplier for the next level in this branch — the
            higher it is, the more each further upgrade here costs.
          </InfoTooltip>
        )}
      </div>
      {branch.upgrades.length === 0 ? (
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Nothing bought in this branch.</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-100 text-sm dark:divide-slate-700/60">
          {branch.upgrades.map((u, i) => <UpgradeRow key={u.id ?? i} u={u} dimmed={dimmed} />)}
        </ul>
      )}
    </div>
  )
}

export default function UpgradesSection() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [showInactive, setShowInactive] = useState(false)

  useEffect(() => {
    let on = true
    apiGet('/api/faction/upgrades')
      .then(d => { if (on) setData(d) })
      .catch(e => { if (on) setError(e?.message || 'Could not load upgrades') })
    return () => { on = false }
  }, [])

  const counts = useMemo(() => {
    if (!data) return { active: 0, inactive: 0, core: 0 }
    const n = (bs) => bs.reduce((s, b) => s + b.upgrades.length, 0)
    return { active: n(data.active), inactive: n(data.inactive), core: data.core.length }
  }, [data])

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <LoaderCircle className="h-4 w-4 animate-spin" /> Loading upgrades…
      </p>
    )
  }

  // ⚠️ No snapshot yet is a normal state, not a failure. The scraper runs daily
  // at 02:10, so a tenant that joined today genuinely has nothing to show.
  if (!data.snapshotDate) {
    return (
      <div className="card">
        <h3 className="font-semibold">Faction upgrades</h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          No snapshot yet. Upgrades are read from Torn once a day, so this fills in
          after the next run.
        </p>
      </div>
    )
  }

  const atWar = data.state === 'war'
  const StateIcon = atWar ? Swords : Handshake

  return (
    <div className="space-y-4">
      {/* ── What is in effect, stated before anything is listed ─────────────── */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StateIcon className={`h-5 w-5 ${atWar ? 'text-red-500' : 'text-emerald-500'}`} />
            <div>
              <h3 className="font-semibold">
                {data.state ? STATE_LABEL[data.state] : 'Faction state unknown'}
              </h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {data.state
                  ? <>Your <strong>{data.state}</strong> branches are the ones giving you bonuses right now.</>
                  // ⚠️ We do not pick a side when Torn did not say. Guessing
                  // would render an authoritative-looking "active" list that
                  // could be the wrong half of the tree.
                  : 'Torn did not report whether the faction is at war or at peace, so neither branch set is shown as active below.'}
              </p>
            </div>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            As of {data.snapshotDate}
          </p>
        </div>
      </div>

      {/* ── Active ──────────────────────────────────────────────────────────── */}
      {data.active.length > 0 && (
        <section className="space-y-3">
          <h3 className="flex items-baseline gap-2 font-semibold">
            In effect now
            <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
              {counts.active} upgrade{counts.active === 1 ? '' : 's'}
            </span>
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            {data.active.map((b, i) => <Branch key={`${b.name}-${i}`} branch={b} />)}
          </div>
        </section>
      )}

      {/* ── Inactive — present, obviously not in effect ──────────────────────── */}
      {data.inactive.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowInactive(v => !v)}
            aria-expanded={showInactive}
            className="flex w-full items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:border-slate-600 dark:hover:bg-slate-800/50"
          >
            <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${showInactive ? '' : '-rotate-90'}`} />
            <span className="font-semibold">
              {data.inactiveState
                ? `${data.inactiveState === 'war' ? 'War' : 'Peace'} branches — not in effect`
                : 'All branches — none confirmed active'}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {counts.inactive} upgrade{counts.inactive === 1 ? '' : 's'}
            </span>
          </button>
          {showInactive && (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Bought and paid for, but giving nothing while the faction is
                {data.state ? ` ${data.state}` : ' in its current state'}. Do not plan around these.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {data.inactive.map((b, i) => <Branch key={`${b.name}-${i}`} branch={b} dimmed />)}
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Core: always on, so it sits apart from the war/peace question ───── */}
      {data.core.length > 0 && (
        <section className="space-y-3">
          <h3 className="flex items-baseline gap-2 font-semibold">
            <Lock className="h-4 w-4 text-gray-400" />
            Core unlocks
            <span className="text-xs font-normal text-gray-400 dark:text-gray-500">
              always on · {counts.core}
            </span>
          </h3>
          <div className="rounded-lg border border-gray-200 p-3 dark:border-slate-700">
            <ul className="divide-y divide-gray-100 text-sm dark:divide-slate-700/60">
              {data.core.map((u, i) => <UpgradeRow key={u.id ?? i} u={u} />)}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}
