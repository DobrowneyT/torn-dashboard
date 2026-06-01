// War Room v2 — delta-polling architecture.
// JSX, filters, and layout are intentionally a duplicate of v1 so the two
// versions can run side-by-side during validation. The data layer is the
// only intentional difference; see useWarRoomPoll + warRoomApiV2.
//
// `resolveCountryFromDescription` is still imported from the v1 module —
// it's a pure function with no v1 coupling.
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useViewState } from '../contexts/ViewStateContext'
import { supabase } from '../utils/supabase'
import {
  fetchWarRoomMembersV2,
  fetchOurMembersV2,
  fetchBspStatsV2,
  setWarRoomConfigV2,
  clearWarRoomStateV2,
  claimDibsV2,
  releaseDibsV2,
  requestRevive,
} from '../utils/warRoomApiV2'
import { resolveCountryFromDescription } from '../utils/warRoomApi'
import { useWarRoomPoll } from '../hooks/useWarRoomPoll'
import { config as appConfig } from '../config'
import { FactionWarIcon, FactionMedicalIcon, ItemsIcon, RevivesIcon } from '../components/WarRoomIcons'
import ReviveServicesModal from '../components/ReviveServicesModal'
import MobileWarRoomView from './MobileWarRoomView'
import { Smartphone, Settings } from 'lucide-react'

// OUR_FACTION_ID and flattenMemberRow are owned by useWarRoomPoll in v2 —
// the hook flattens rows before exposing them. The view receives the flat
// shape and uses appConfig.faction.id (coerced to number inside the
// component) for the `us` filter.

const STATUS_FILTERS   = ['Okay', 'Hospital', 'Flying', 'Jail']
const ACTIVITY_FILTERS = ['Online', 'Idle', 'Offline']

function formatStats(n) {
  if (n === null || n === undefined) return '???'
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(2) + 'T'
  if (n >= 1_000_000_000)     return (n / 1_000_000_000).toFixed(2) + 'B'
  if (n >= 1_000_000)         return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000)             return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

function formatCountdown(secondsRemaining) {
  if (secondsRemaining <= 0) return '—'
  const d = Math.floor(secondsRemaining / 86_400)
  const h = Math.floor((secondsRemaining % 86_400) / 3_600)
  const m = Math.floor((secondsRemaining % 3_600) / 60)
  const s = secondsRemaining % 60
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, '0')}m`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatRelative(ts) {
  if (!ts) return '—'
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60)     return 'just now'
  if (diff < 3_600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
  return `${Math.floor(diff / 86_400)}d ago`
}

// Hover tooltip on a member's BSP total — shows the per-stat breakdown
// (str/dex/spd/def), total, and "{relative age} ({TS|BSP})" so leadership
// can see at a glance how trustworthy the number is. CSS-only show/hide via
// the `group-hover` Tailwind variant (no JS state, no portal).
//
// Behaviour by row state:
//   - `m.bsp_total == null` → render dim "???", no tooltip.
//   - TornStats source AND ts_spy_at present → age from ts_spy_at, "(TS)".
//   - BSP source (or unknown) → age from bsp_fetched_at, "(BSP)".
//   - Breakdown rows render only when the corresponding field is non-null
//     so BSP-only rows (often no per-stat) just show Total + source.
function BspCell({ member: m }) {
  if (m.bsp_total === null || m.bsp_total === undefined) {
    return (
      <span className="font-mono text-xs text-gray-400 dark:text-gray-600 italic">
        ???
      </span>
    )
  }

  const isTs = m.spy_source === 'tornstats'
  // ts_spy_at is the real spy capture time; bsp_fetched_at is when we polled.
  // BSP rows don't have a "real" spy timestamp so we use the fetch time.
  const ageSourceTs = isTs && m.ts_spy_at
    ? Math.floor(new Date(m.ts_spy_at).getTime() / 1000)
    : (m.bsp_fetched_at ? Math.floor(new Date(m.bsp_fetched_at).getTime() / 1000) : null)
  const sourceLabel = isTs ? 'TS' : 'BSP'
  const ageLabel = ageSourceTs ? formatRelative(ageSourceTs) : '—'

  const rows = [
    ['STR', m.bsp_str],
    ['DEF', m.bsp_def],
    ['SPD', m.bsp_spd],
    ['DEX', m.bsp_dex],
  ].filter(([, v]) => v !== null && v !== undefined)

  return (
    <span className="relative group inline-block">
      <span className="font-mono text-xs text-gray-800 dark:text-gray-200 font-semibold cursor-help underline decoration-dotted decoration-gray-400 dark:decoration-slate-600 underline-offset-2">
        {formatStats(m.bsp_total)}
      </span>
      <span
        role="tooltip"
        className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity absolute right-0 top-full mt-1 z-30 min-w-[150px] rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg text-left p-2.5 text-[11px]"
      >
        {rows.length > 0 ? (
          <table className="font-mono w-full">
            <tbody>
              {rows.map(([label, v]) => (
                <tr key={label}>
                  <td className="pr-3 text-gray-500 dark:text-gray-400">{label}</td>
                  <td className="text-right text-gray-900 dark:text-gray-100">{formatStats(v)}</td>
                </tr>
              ))}
              <tr className="border-t border-gray-200 dark:border-slate-700">
                <td className="pr-3 pt-1 text-gray-500 dark:text-gray-400 font-semibold">Total</td>
                <td className="text-right pt-1 text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp_total)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="font-mono flex justify-between gap-3">
            <span className="text-gray-500 dark:text-gray-400 font-semibold">Total</span>
            <span className="text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp_total)}</span>
          </div>
        )}
        <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 text-[10px] text-right whitespace-nowrap">
          {ageLabel} ({sourceLabel})
        </div>
      </span>
    </span>
  )
}

function parseHospitalInfo(description) {
  if (!description) return null
  const match = description.match(/^(In (?:a|an) .*? hospital)\b/i)
  if (!match) return null
  return { label: match[1].trim() }
}

function stateToFilterKey(state, description) {
  if (state === 'Traveling' || state === 'Abroad') return 'Flying'
  if (state === 'Hospital' && parseHospitalInfo(description)) return 'Flying'
  return state
}

function parseStatInput(str) {
  if (!str?.trim()) return null
  const s = str.trim().toLowerCase()
  // Accepts: "3", "3.5", "0.8", ".8" (leading-decimal shorthand) — each
  // optionally followed by k/m/b. Rejects "3." (trailing dot) and bare ".".
  const m = s.match(/^(\d*\.?\d+)\s*([kmb]?)$/)
  if (!m) return null
  const n = parseFloat(m[1])
  if (Number.isNaN(n)) return null
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }
  return n * (multipliers[m[2]] ?? 1)
}

function parseTravelInfo(state, description) {
  if (state === 'Traveling') {
    // Current API format: "Traveling from X to Y"
    const match = description?.match(/^Traveling from (.+) to (.+)$/)
    if (match) {
      const [, from, to] = match
      return to === 'Torn'
        ? { returning: true,  label: `from ${from}` }
        : { returning: false, label: `to ${to}` }
    }
    // Legacy fallback formats
    if (description?.startsWith('Returning from ')) {
      return { returning: true,  label: `from ${description.replace('Returning from ', '')}` }
    }
    const dest = description?.replace('Traveling to ', '') ?? ''
    return { returning: false, label: dest ? `to ${dest}` : '' }
  }
  if (state === 'Abroad') {
    const dest = description?.replace(/^In /, '') ?? ''
    return { returning: false, label: dest ? `in ${dest}` : '' }
  }
  return null
}

// ── Badges ────────────────────────────────────────────────────────────────────

function ActivityBadge({ status }) {
  const styles = {
    Online:  'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    Idle:    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    Offline: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  }
  const dotColor = {
    Online: 'bg-green-500 animate-pulse',
    Idle:   'bg-yellow-500',
    Offline:'bg-gray-400',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? styles.Offline}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor[status] ?? dotColor.Offline}`} />
      {status}
    </span>
  )
}

function StatusCell({ state, description }) {
  const badgeStyles = {
    Okay:      'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    Hospital:  'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    Traveling: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    Abroad:    'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    Fallen:    'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    Jail:      'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  }
  const travel = (state === 'Traveling' || state === 'Abroad') ? parseTravelInfo(state, description) : null
  const hospital = state === 'Hospital' ? parseHospitalInfo(description) : null
  const travelIcon = travel?.returning ? '🛬' : '🛫'
  const icons = { Okay: '✓', Hospital: '🏥', Traveling: travelIcon, Abroad: '🛫', Fallen: '💀', Jail: '⛓' }

  // An abroad-hospital row needs to read as "still can't be attacked" rather
  // than a normal Hospital that releases soon. Use amber styling + a plane
  // icon so it's distinguishable at a glance from a Torn-city hospital.
  const abroadHospitalStyles = 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
  const badgeClass = hospital ? abroadHospitalStyles : (badgeStyles[state] ?? badgeStyles.Okay)
  const iconChar   = hospital ? '✈' : (icons[state] ?? '?')

  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${badgeClass}`}>
        <span>{iconChar}</span>
        {state}
      </span>
      {travel?.label && (
        <span className="text-xs text-gray-500 dark:text-gray-400 pl-1 whitespace-nowrap">
          {travel.label}
        </span>
      )}
      {hospital?.label && (
        <span className="text-xs text-gray-500 dark:text-gray-400 pl-1 whitespace-nowrap">
          {hospital.label}
        </span>
      )}
    </div>
  )
}

// ── Countdown (ticks every 1s client-side) ────────────────────────────────────

function CountdownCell({ until }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  if (!until) return <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>
  const rem = until - now
  const urgent = rem > 0 && rem < 300
  if (rem <= 0) return <span className="text-orange-500 dark:text-orange-400 text-xs font-mono animate-pulse">Releasing…</span>
  return (
    <span className={`font-mono text-xs ${urgent ? 'text-orange-600 dark:text-orange-400 font-semibold' : 'text-gray-700 dark:text-gray-300'}`}>
      {formatCountdown(rem)}
    </span>
  )
}

// ── Combined faction status bar ───────────────────────────────────────────────

function ActivityCounts({ members }) {
  const online  = members.filter(m => m.last_action_status === 'Online').length
  const idle    = members.filter(m => m.last_action_status === 'Idle').length
  const offline = members.filter(m => m.last_action_status === 'Offline').length
  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="flex items-center gap-1.5 text-green-700 dark:text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
        <span className="font-semibold">{online}</span> Online
      </span>
      <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
        <span className="font-semibold">{idle}</span> Idle
      </span>
      <span className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
        <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 shrink-0" />
        <span className="font-semibold">{offline}</span> Offline
      </span>
    </div>
  )
}

function FactionStatusBar({ enemyMembers, ourMembers, factionLabel, reviveServiceName, reviveServiceUrl, reviveServiceSource, reviveServiceSourceKey, reviveServicePreset, userCountry, user, factionName }) {
  // On <md viewports stack into 3 rows so the bar can't overflow a phone
  // screen (which would inflate the layout viewport and break the mobile
  // overlay). On md+ keep the original single-row layout.
  return (
    <div className="card py-3 px-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4">
      <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-wrap">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">
          {factionLabel ?? 'Enemy'}
        </span>
        <ActivityCounts members={enemyMembers} />
      </div>
      <div className="flex items-center justify-center md:justify-center shrink-0 self-center md:self-auto">
        <QuickLinksBar
          reviveServiceName={reviveServiceName}
          reviveServiceUrl={reviveServiceUrl}
          reviveServiceSource={reviveServiceSource}
          reviveServiceSourceKey={reviveServiceSourceKey}
          reviveServicePreset={reviveServicePreset}
          userCountry={userCountry}
          user={user}
          factionName={factionName}
        />
      </div>
      {ourMembers.length > 0 ? (
        <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-wrap md:justify-end">
          <ActivityCounts members={ourMembers} />
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">
            Us
          </span>
        </div>
      ) : (
        // Keeps justify-between's spacing balanced when our counts are hidden
        <span aria-hidden className="shrink-0" />
      )}
    </div>
  )
}

// ── Quick links bar (visible to all) ──────────────────────────────────────────

function QuickLinkButton({ href, title, disabled, children }) {
  const base = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border transition-colors'
  if (disabled) {
    return (
      <span
        title={title}
        className={`${base} border-gray-200 dark:border-slate-700 text-gray-300 dark:text-slate-600 cursor-not-allowed`}
        aria-disabled="true"
      >
        {children}
      </span>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={`${base} border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20`}
    >
      {children}
    </a>
  )
}

/**
 * Revives button — fires a POST to the configured service URL via the Edge
 * Function proxy (CORS workaround). Disabled while in-flight + 2s cooldown.
 * Mirrors the payload shape from the UHC Tampermonkey script.
 */
function ReviveQuickLinkButton({ serviceName, serviceUrl, serviceSource, serviceSourceKey, servicePreset, userCountry, user, factionName }) {
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const base = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border transition-colors'
  const disabled = !serviceUrl || !user?.id || busy || cooldown

  async function handleClick() {
    if (disabled) return
    setBusy(true); setFeedback(null)
    const requestArgs = {
      url: serviceUrl,
      userID: Number(user.id),
      userName: user.name,
      factionName,
      // Per-service identifier — falls back to the service name, then a generic label
      source: serviceSource || serviceName || 'War Room',
      sourceKey: serviceSourceKey || 'source',
      // Selects the payload shape + transport on the requestRevive side:
      //   'json' (UHC/WTF) → Edge Function JSON POST
      //   'nuke'           → direct browser form POST (matches userscript's
      //                      residential-IP fingerprint to avoid Nuke's
      //                      datacenter-IP shadow-filter)
      preset: servicePreset || 'json',
      // Required by the Nuke direct-POST path — resolved by the parent from
      // our own war_room_state row. Ignored by the json path (Edge Function
      // resolves country server-side).
      country: userCountry || 'Torn',
    }
    try {
      const result = await requestRevive(requestArgs, user.apiKey)
      if (result.ok) {
        setFeedback({ ok: true, text: 'Sent' })
      } else {
        const reason = result.body?.reason ?? `HTTP ${result.status}`
        setFeedback({ ok: false, text: reason })
      }
    } catch (e) {
      setFeedback({ ok: false, text: e.message })
    } finally {
      setBusy(false)
      setCooldown(true)
      setTimeout(() => setCooldown(false), 2000)
      setTimeout(() => setFeedback(null), 5000)
    }
  }

  const baseLabel = serviceName ? `${serviceName} Revives` : 'Revives'
  const title = !serviceUrl
    ? 'Revives (leadership: add a service in settings)'
    : busy ? `${baseLabel} — sending…`
    : feedback ? `${baseLabel} — ${feedback.text}`
    : `${baseLabel} — click to request a revive`

  const stateClasses = feedback?.ok
    ? 'border-green-400 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
    : feedback && !feedback.ok
    ? 'border-red-400 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20'
    : disabled
    ? 'border-gray-200 dark:border-slate-700 text-gray-300 dark:text-slate-600 cursor-not-allowed'
    : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      title={title}
      aria-label={baseLabel}
      className={`${base} ${stateClasses}`}
    >
      {busy ? (
        <span className="block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        <RevivesIcon className="w-5 h-5" />
      )}
    </button>
  )
}

function QuickLinksBar({ reviveServiceName, reviveServiceUrl, reviveServiceSource, reviveServiceSourceKey, reviveServicePreset, userCountry, user, factionName }) {
  const iconCls = 'w-5 h-5'
  return (
    <div className="flex items-center gap-1.5">
      <QuickLinkButton href="https://www.torn.com/factions.php?step=your&type=1#/war/rank" title="Faction War Page">
        <FactionWarIcon className={iconCls} />
      </QuickLinkButton>
      <QuickLinkButton href="https://www.torn.com/factions.php?step=your#/tab=armoury&start=0&sub=medical" title="Faction Medical Items">
        <FactionMedicalIcon className={iconCls} />
      </QuickLinkButton>
      <QuickLinkButton href="https://www.torn.com/item.php" title="Items Page">
        <ItemsIcon className={iconCls} />
      </QuickLinkButton>
      <ReviveQuickLinkButton
        serviceName={reviveServiceName}
        serviceUrl={reviveServiceUrl}
        serviceSource={reviveServiceSource}
        serviceSourceKey={reviveServiceSourceKey}
        servicePreset={reviveServicePreset}
        userCountry={userCountry}
        user={user}
        factionName={factionName}
      />
    </div>
  )
}

// ── Sortable header ───────────────────────────────────────────────────────────
// Lifted out of the parent component so its function reference is stable across
// re-renders. Previously it was defined inside WarRoomView, which meant every
// poll (every 1-3s) produced a new component type and unmounted/remounted every
// <th> — causing visible flashing and dropped mouse clicks on the headers.

function SortTh({ col, sortCol, sortDir, onSort, children, className = '' }) {
  const active = sortCol === col
  return (
    <th
      onClick={() => onSort(col)}
      className={`py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors whitespace-nowrap ${className}`}
    >
      <span className="flex items-center gap-1">
        {children}
        <span className={`text-xs ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600'}`}>
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    </th>
  )
}

// ── Config panel (leadership only) ────────────────────────────────────────────

function ConfigPanel({
  config,
  isActive, toggling, onToggleEnabled,
  updatingSpies, onUpdateSpies,
  pollIntervalSec, onPollIntervalChange,
  onSaveAndFetch, onSaveReviveService, onSaveReviveList, onClearState,
}) {
  const [factionId, setFactionId] = useState(String(config?.faction_id ?? ''))
  const [saving, setSaving]       = useState(false)
  const [clearing, setClearing]   = useState(false)
  const [msg, setMsg]             = useState(null)
  const [showServicesModal, setShowServicesModal] = useState(false)

  const services = Array.isArray(config?.revive_services) ? config.revive_services : []
  const activeReviveName = config?.revive_service_name ?? ''

  // TornStats max-age — number of days a TornStats spy is "fresh enough" to
  // use before falling back to BSP. 0 disables TornStats entirely. Local
  // state mirrors the config and only commits on blur, so typing doesn't
  // hammer the DB.
  const [tsMaxAge, setTsMaxAge] = useState(String(config?.tornstats_max_age_days ?? 0))
  // Resync when external config updates land (initial load / realtime).
  useEffect(() => {
    setTsMaxAge(String(config?.tornstats_max_age_days ?? 0))
  }, [config?.tornstats_max_age_days])
  async function commitTsMaxAge() {
    const next = Math.max(0, Math.floor(Number(tsMaxAge) || 0))
    if (next === (config?.tornstats_max_age_days ?? 0)) return
    setMsg(null)
    try {
      await onSaveReviveService({ tornstats_max_age_days: next })
      setMsg({ ok: true, text: next === 0 ? 'TornStats age filter disabled — any spy age allowed.' : `TornStats spy age set to ${next} days.` })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    }
  }

  // Dropdown change → look up the preset and persist its name + url as the active selection.
  async function handlePickReviveService(e) {
    const picked = e.target.value
    const found = services.find(s => s.name === picked)
    setMsg(null)
    try {
      await onSaveReviveService({
        revive_service_name: found?.name ?? null,
        revive_service_url:  found?.url  ?? null,
      })
      setMsg({ ok: true, text: found ? `Revive service set to ${found.name}.` : 'Revive service cleared.' })
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
  }

  async function handleSaveServicesList(newList) {
    // If the currently-active service was removed or renamed, clear the active selection
    // so the QuickLinksBar doesn't keep pointing at a stale name.
    const stillExists = activeReviveName && newList.some(s => s.name === activeReviveName)
    await onSaveReviveList({
      revive_services: newList,
      ...(stillExists ? {} : { revive_service_name: null, revive_service_url: null }),
    })
    setMsg({ ok: true, text: 'Revive services list saved.' })
  }

  async function handleSave() {
    if (!factionId.trim()) return
    setSaving(true); setMsg(null)
    try {
      const wasEnabled = !!config?.enabled
      await onSaveAndFetch(Number(factionId))
      setMsg({
        ok: true,
        text: wasEnabled
          ? 'Saved & loaded. War room was disabled — re-enable to resume polling.'
          : 'Saved & loaded initial members.',
      })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally { setSaving(false) }
  }

  async function handleClear() {
    if (!confirm('Clear all war room member data? Do this when starting a new war.')) return
    setClearing(true)
    try {
      await onClearState()
      setMsg({ ok: true, text: 'War room state cleared.' })
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally { setClearing(false) }
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700 space-y-3">
      {/* Live controls — Enable/Stop, Update Spies, Poll rate.
          Grouped with the rest of the admin controls in this panel so
          leadership has a single command surface on narrow viewports. */}
      <div className="flex flex-wrap items-end gap-2">
        {isActive ? (
          <button
            onClick={onToggleEnabled}
            disabled={toggling}
            className="px-3 py-1.5 bg-red-100 hover:bg-red-200 dark:bg-red-900/30 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
          >
            {toggling ? 'Stopping…' : 'Stop War Room'}
          </button>
        ) : (
          <button
            onClick={onToggleEnabled}
            disabled={toggling || !config?.faction_id}
            title={!config?.faction_id ? 'Set an opponent faction ID first' : ''}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-white opacity-80" />
            {toggling ? 'Enabling…' : 'Enable War Room'}
          </button>
        )}
        <button
          onClick={onUpdateSpies}
          disabled={updatingSpies || !config?.faction_id}
          title={!config?.faction_id ? 'Set a faction ID first' : 'Fetch members + BSP battle stats'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 text-purple-700 dark:text-purple-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {updatingSpies ? '⏳ Fetching…' : '🔍 Update Spies'}
        </button>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Poll Rate</label>
          <div className="flex items-center gap-1.5" title="Polling interval in seconds (min 0.5s). With key rotation, lower values give fresher data.">
            <input
              type="number"
              min={0.5}
              max={60}
              step={0.5}
              value={pollIntervalSec}
              onChange={e => onPollIntervalChange(e.target.value)}
              className="w-16 px-2 py-1.5 text-sm text-center border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400 dark:text-gray-500">s</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Opponent Faction ID</label>
          <input
            type="text" value={factionId} onChange={e => setFactionId(e.target.value)} placeholder="e.g. 8317"
            className="w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button onClick={handleSave} disabled={saving || !factionId.trim()}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={handleClear} disabled={clearing}
          className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium transition-colors">
          {clearing ? 'Clearing…' : 'Clear State'}
        </button>
      </div>

      {/* TornStats integration — sets how old a TornStats spy can be before
          we fall back to BSP for that member. 0 disables the TornStats pass
          entirely (Update Spies just runs BSP, same as before). */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            TornStats max spy age <span className="text-gray-400 dark:text-gray-600">(days, 0 = any age)</span>
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={tsMaxAge}
            onChange={e => setTsMaxAge(e.target.value)}
            onBlur={commitTsMaxAge}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="0"
            title="Upper bound on TornStats spy age. 0 = no age filter (always use TornStats spy if one exists). BSP only fills members TornStats has no spy for, or whose spy is older than this value."
            className="w-24 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Revive service — preset dropdown + gear to manage the list */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Revive Service</label>
          <div className="flex items-center gap-1">
            <select
              value={activeReviveName}
              onChange={handlePickReviveService}
              className="w-48 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Permanent "None" option — selecting it clears the active service
                  and disables the Revives quick-link button. Not part of the
                  editable list in the gear-icon modal. */}
              <option value="">None</option>
              {services.map(s => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
            <button
              onClick={() => setShowServicesModal(true)}
              title="Manage revive services"
              className="w-9 h-9 inline-flex items-center justify-center rounded-lg border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
              aria-label="Manage revive services"
            >
              <span aria-hidden>⚙</span>
            </button>
          </div>
        </div>
      </div>

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{msg.text}</p>}

      {showServicesModal && (
        <ReviveServicesModal
          services={services}
          activeName={activeReviveName}
          onSave={handleSaveServicesList}
          onClose={() => setShowServicesModal(false)}
        />
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WarRoomViewV2({ isLeadership, isAdmin }) {
  const { user } = useAuth()

  // Reload-persisted prefs: filter chips, stats range, sort, poll rate.
  // Sets are stored as arrays so JSON.stringify can round-trip them.
  const [persistedState, setPersistedState] = useViewState('warroom_desktop_v2')

  const [pollIntervalSec, setPollIntervalSec] = useState(() => persistedState.pollIntervalSec ?? 3)

  // ── v2 data layer ──
  // useWarRoomPoll owns config/members/ourMembers/dibs and refreshes via
  // war_room_*_v2_delta RPCs. The consumer-facing shape (arrays/objects) is
  // identical to v1's local state so the rest of this file is unchanged.
  // appConfig.faction.id is a string from env; coerce to number to match the
  // bigint faction_id column the polling RPC returns.
  const OUR_FACTION_ID = Number(appConfig.faction.id)
  const {
    members,
    ourMembers,
    dibs,
    config,
    isInitialLoading: configLoading,
    lastTick: lastFetched,
    pollError,
    pollNow,
  } = useWarRoomPoll({
    intervalMs: Math.max(500, Math.round(pollIntervalSec * 1000)),
    enabled: !!user?.apiKey,
    ourFactionId: OUR_FACTION_ID,
  })

  const [toggling, setToggling]       = useState(false)
  const [toggleError, setToggleError] = useState(null)
  const [updatingSpies, setUpdatingSpies] = useState(false)
  const [spiesMsg, setSpiesMsg]       = useState(null)

  // Leadership controls collapse — default closed so the page reads clean.
  // Persisted so users who keep it open don't have to reopen on every load.
  const [leadershipPanelOpen, setLeadershipPanelOpen] = useState(() => persistedState.leadershipPanelOpen ?? false)
  const [factionName, setFactionName] = useState(null)

  // Stats filter
  const [statsFilterEnabled, setStatsFilterEnabled] = useState(() => persistedState.statsFilterEnabled ?? false)
  const [statsFilterMin, setStatsFilterMin] = useState(() => persistedState.statsFilterMin ?? '')
  const [statsFilterMax, setStatsFilterMax] = useState(() => persistedState.statsFilterMax ?? '')

  // Mobile War Room overlay (only visible on < md viewport — see launcher button)
  const [mobileOpen, setMobileOpen] = useState(false)

  // Lock body scroll AND width while the mobile overlay is up. The width
  // lock is critical: if the desktop page underneath overflows
  // horizontally on a phone (it does — desktop layout is wider than 375px),
  // the phone's layout viewport expands past the visual viewport and our
  // fixed inset-0 overlay covers the wider layout, appearing zoomed-out.
  // Forcing the body to 100vw + overflow:hidden collapses the layout back
  // to the visible viewport so the overlay sits at the correct size.
  useEffect(() => {
    if (!mobileOpen) return
    const body = document.body
    const prev = {
      overflow: body.style.overflow,
      width: body.style.width,
      position: body.style.position,
    }
    body.style.overflow = 'hidden'
    body.style.width = '100vw'
    return () => {
      body.style.overflow = prev.overflow
      body.style.width = prev.width
      body.style.position = prev.position
    }
  }, [mobileOpen])

  const pollRef          = useRef(null)
  const ourMembersPollRef = useRef(null)
  const bspFiredRef      = useRef(false)
  const opponentFidRef = useRef(null)
  const membersRef     = useRef([])
  const userRef        = useRef(user)
  const dibsAbortRef   = useRef(null)   // cancels in-flight claim when user clicks another
  const [dibsError, setDibsError] = useState(null)

  // No refreshDibs / scheduleDibsRefresh in v2 — useWarRoomPoll polls the
  // dibs delta RPC every tick. Write handlers below call pollNow() after
  // success for ~50ms feedback latency.

  useEffect(() => { opponentFidRef.current = config?.faction_id }, [config?.faction_id])

  // Look up faction name from the factions table whenever the faction_id changes
  useEffect(() => {
    if (!config?.faction_id) return
    supabase.from('factions').select('name').eq('id', config.faction_id).maybeSingle()
      .then(({ data }) => { if (data?.name) setFactionName(data.name) })
  }, [config?.faction_id])
  useEffect(() => { membersRef.current = members }, [members])
  useEffect(() => { userRef.current = user }, [user])

  // Filters — Sets; empty = show all. Seeded from persisted arrays.
  const [statusFilter, setStatusFilter]     = useState(() => new Set(persistedState.statusFilter ?? []))
  const [activityFilter, setActivityFilter] = useState(() => new Set(persistedState.activityFilter ?? []))

  // Sort state
  const [sortCol, setSortCol] = useState(() => persistedState.sortCol ?? 'timer')
  const [sortDir, setSortDir] = useState(() => persistedState.sortDir ?? 'asc')

  // Sync all reload-persisted prefs back to the context whenever they change.
  // Sets are flattened to arrays so they survive JSON.stringify.
  useEffect(() => {
    setPersistedState({
      statusFilter: [...statusFilter],
      activityFilter: [...activityFilter],
      statsFilterEnabled,
      statsFilterMin,
      statsFilterMax,
      sortCol,
      sortDir,
      pollIntervalSec,
      leadershipPanelOpen,
    })
  }, [statusFilter, activityFilter, statsFilterEnabled, statsFilterMin, statsFilterMax, sortCol, sortDir, pollIntervalSec, leadershipPanelOpen, setPersistedState])

  function handleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  function toggleStatusFilter(key) {
    setStatusFilter(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleActivityFilter(key) {
    setActivityFilter(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // ── Auto-release dibs when target leaves Okay state ──────────────────────
  // v1 did this inside the Realtime UPDATE handler by diffing prev vs new.
  // Here we watch the polled enemy `members` array directly: whenever a row
  // we hold dibs on transitions out of Okay, fire the release. The polled
  // truth supersedes any local optimism; no double-fire.
  const prevEnemyOkayRef = useRef(new Set())
  useEffect(() => {
    const nowOkay = new Set()
    for (const m of members) {
      if (m.status_state === 'Okay') nowOkay.add(m.member_id)
    }
    const prevOkay = prevEnemyOkayRef.current
    const myId = String(user?.id ?? '')
    for (const id of prevOkay) {
      if (nowOkay.has(id)) continue
      const dib = dibs[id]
      if (!dib || String(dib.claimed_by) !== myId) continue
      releaseDibsV2(id, user?.apiKey, { userId: user?.id })
        .then(() => pollNow())
        .catch(e => console.error('Auto-release dibs:', e))
    }
    prevEnemyOkayRef.current = nowOkay
  }, [members, dibs, user?.apiKey, user?.id, pollNow])

  // ── BSP fire once when members first appear ───────────────────────────────

  useEffect(() => {
    if (!config?.enabled || !members.length || bspFiredRef.current || !user?.apiKey) return
    bspFiredRef.current = true
    const missing = members.filter(m => m.bsp_total === null).map(m => m.member_id)
    if (!missing.length) return
    fetchBspStatsV2(missing, user.apiKey).catch(e => console.error('BSP auto-fetch error:', e))
  }, [members.length, config?.enabled, user?.apiKey])

  // ── Write-side polling loop ───────────────────────────────────────────────
  // This is the Torn-API → DB pump. It's separate from the DB → UI pump
  // (useWarRoomPoll) which polls the delta RPCs every tick. Setting the
  // interval here controls how fresh the DB is; setting intervalMs on
  // useWarRoomPoll controls how quickly the UI reflects the DB.

  const poll = useCallback(async () => {
    if (!user?.apiKey || !config?.faction_id) return
    try {
      await fetchWarRoomMembersV2(config.faction_id, user.apiKey)
    } catch (e) {
      console.error('War room poll error:', e)
    }
  }, [user?.apiKey, config?.faction_id])

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (config?.enabled && config?.faction_id) {
      poll()
      pollRef.current = setInterval(poll, pollIntervalSec * 1000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [config?.enabled, config?.faction_id, poll, pollIntervalSec])

  // Our members poll — uses Torn cache, runs every 30s
  useEffect(() => {
    if (ourMembersPollRef.current) clearInterval(ourMembersPollRef.current)
    if (config?.enabled && user?.apiKey) {
      fetchOurMembersV2(user.apiKey).catch(e => console.error('Our members poll error:', e))
      ourMembersPollRef.current = setInterval(
        () => fetchOurMembersV2(userRef.current?.apiKey).catch(e => console.error('Our members poll error:', e)),
        30_000
      )
    }
    return () => { if (ourMembersPollRef.current) clearInterval(ourMembersPollRef.current) }
  }, [config?.enabled, user?.apiKey])

  // ── Leadership actions ────────────────────────────────────────────────────

  async function toggleEnabled() {
    if (!user?.apiKey) return
    setToggling(true); setToggleError(null)
    try {
      const enabling = !config?.enabled
      if (enabling) bspFiredRef.current = false
      await setWarRoomConfigV2({ enabled: enabling }, user.apiKey)
      await pollNow()
    } catch (e) {
      setToggleError(e.message)
    } finally { setToggling(false) }
  }

  async function handleClearState() {
    await clearWarRoomStateV2(user.apiKey)
    bspFiredRef.current = false
    await pollNow()
  }

  async function handleSaveReviveService(updates) {
    await setWarRoomConfigV2(updates, user.apiKey)
    await pollNow()
  }

  // Same shape as handleSaveReviveService — the modal sends the full updated list
  // (plus optionally a cleared active selection if the active service was removed).
  async function handleSaveReviveList(updates) {
    await setWarRoomConfigV2(updates, user.apiKey)
    await pollNow()
  }

  // Save flow: switching factions is a full reset — disable polling, wipe
  // state, save the new ID, pull an initial baseline.
  async function handleSaveAndFetch(newFactionId) {
    // 1. Disable polling so an in-flight poll for the OLD faction can't
    //    re-add members between the clear and the new fetch.
    if (config?.enabled) {
      await setWarRoomConfigV2({ enabled: false }, user.apiKey)
      await new Promise(r => setTimeout(r, 500))
    }
    // 2. Clear state (soft-deletes all current rows; hook prunes via tombstones).
    await clearWarRoomStateV2(user.apiKey)
    bspFiredRef.current = false
    // 3. Persist the new faction_id (and reset cached name).
    await setWarRoomConfigV2({ faction_id: newFactionId, faction_name: null }, user.apiKey)
    setFactionName(null)
    // 4. Initial enemy + our fetch in parallel.
    const [enemyResp] = await Promise.all([
      fetchWarRoomMembersV2(newFactionId, user.apiKey),
      fetchOurMembersV2(user.apiKey),
    ])
    if (enemyResp?.faction_name) setFactionName(enemyResp.faction_name)
    // 5. Trigger an immediate poll so the new state appears within ~50ms.
    await pollNow()
  }

  // Update Spies works even when the war room is paused: if no members are loaded
  // yet (paused state), it does an enemy fetch first, then BSP enrichment.
  async function handleUpdateSpies() {
    if (!user?.apiKey || !config?.faction_id) return
    setUpdatingSpies(true); setSpiesMsg(null)
    try {
      let workingMembers = membersRef.current.length ? membersRef.current : members
      if (!workingMembers.length) {
        setSpiesMsg({ ok: true, text: 'Fetching members…' })
        await fetchWarRoomMembersV2(config.faction_id, user.apiKey)
        // Give the next poll tick a beat to surface the new members, then
        // fall back to a direct DB read of v2 if the hook hasn't caught up.
        await pollNow()
        await new Promise(r => setTimeout(r, 200))
        workingMembers = membersRef.current
        if (!workingMembers.length) {
          const { data } = await supabase
            .from('war_room_state_v2')
            .select('member_id')
            .eq('faction_id', config.faction_id)
            .is('deleted_at', null)
          workingMembers = data ?? []
        }
      }
      if (!workingMembers.length) throw new Error('No members loaded — check the faction ID')
      const ids = workingMembers.map(m => m.member_id)
      // Show progress BEFORE the await so it reflects in-flight state, not completion.
      setSpiesMsg({ ok: true, text: `Fetching spies for ${ids.length} members…` })
      const result = await fetchBspStatsV2(ids, user.apiKey)
      // Edge Function returns { fetched, tornstats, bsp, requested }. Older
      // deploys (pre-TornStats) only return { fetched } — fall back gracefully.
      const ts = Number(result?.tornstats ?? 0)
      const bsp = Number(result?.bsp ?? result?.fetched ?? 0)
      const total = ts + bsp
      setSpiesMsg({
        ok: true,
        text: ts > 0
          ? `✓ Fetched ${ts} spies from TS and ${bsp} spies from BSP (${total}/${ids.length})`
          : `✓ Fetched ${bsp} spies from BSP (${bsp}/${ids.length})`,
      })
      setTimeout(() => setSpiesMsg(null), 6000)
    } catch (e) {
      setSpiesMsg({ ok: false, text: e.message })
      setTimeout(() => setSpiesMsg(null), 5000)
    } finally { setUpdatingSpies(false) }
  }

  // ── Dibs ──────────────────────────────────────────────────────────────────

  // v2 dibs handlers: no optimistic state. After the server confirms, we call
  // pollNow() to fetch the new truth within ~50ms. AbortController is kept so
  // rapid double-clicks don't race themselves. The DB unique partial index
  // on active target_id still resolves concurrent claims server-side.
  async function handleClaimDibs(memberId) {
    if (!user?.id) return
    setDibsError(null)

    if (dibsAbortRef.current) dibsAbortRef.current.abort()
    const controller = new AbortController()
    dibsAbortRef.current = controller

    try {
      await claimDibsV2(memberId, user.name, null, user.apiKey, { signal: controller.signal, userId: user.id })
      await pollNow()
    } catch (e) {
      if (e.name === 'AbortError') return
      setDibsError(e.message)
      setTimeout(() => setDibsError(null), 4000)
    } finally {
      if (dibsAbortRef.current === controller) dibsAbortRef.current = null
    }
  }

  async function handleReleaseDibs(memberId) {
    if (!user?.id) return
    setDibsError(null)
    try {
      await releaseDibsV2(memberId, user.apiKey, { userId: user.id })
      await pollNow()
    } catch (e) {
      setDibsError(e.message)
      setTimeout(() => setDibsError(null), 4000)
    }
  }

  // ── Filtered + sorted member list ─────────────────────────────────────────

  // Farm-mode tracking: stamp each member with the moment they were observed
  // transitioning into Okay during this session, so fresh kills float to the
  // top of the Okay tier. People already Okay when polling begins get no
  // stamp (BSP-desc fallback below them), keeping the freshly-released pulse
  // distinct from the standing pool.
  const prevStatesRef = useRef(new Map())  // member_id → previous status_state
  const okayAtRef     = useRef(new Map())  // member_id → ms-since-epoch first observed as Okay

  const filtered = useMemo(() => {
    // Update farm-mode transition tracker as a side effect of recomputing.
    // Cheap and safe — the refs are only read by the sort below.
    const prev = prevStatesRef.current
    const okayAt = okayAtRef.current
    const now = Date.now()
    for (const m of members) {
      const wasState = prev.get(m.member_id)
      if (m.status_state === 'Okay' && wasState && wasState !== 'Okay') {
        okayAt.set(m.member_id, now)
      } else if (m.status_state !== 'Okay') {
        okayAt.delete(m.member_id)
      }
      prev.set(m.member_id, m.status_state)
    }

    let list = members

    if (statusFilter.size > 0) {
      list = list.filter(m => statusFilter.has(stateToFilterKey(m.status_state, m.status_description)))
    }
    if (activityFilter.size > 0) {
      list = list.filter(m => activityFilter.has(m.last_action_status))
    }
    if (statsFilterEnabled) {
      const minVal = parseStatInput(statsFilterMin)
      const maxVal = parseStatInput(statsFilterMax)
      if (minVal !== null) list = list.filter(m => m.bsp_total !== null && m.bsp_total >= minVal)
      if (maxVal !== null) list = list.filter(m => m.bsp_total !== null && m.bsp_total <= maxVal)
    }

    const d = sortDir === 'asc' ? 1 : -1
    return list.slice().sort((a, b) => {
      switch (sortCol) {
        case 'name':
          return d * a.member_name.localeCompare(b.member_name)
        case 'activity': {
          const order = { Online: 0, Idle: 1, Offline: 2 }
          return d * ((order[a.last_action_status] ?? 3) - (order[b.last_action_status] ?? 3))
        }
        case 'status':
          return d * (a.status_state ?? '').localeCompare(b.status_state ?? '')
        case 'farm': {
          // Tiered farm sort:
          //   tier 0 — Okay (recently transitioned first, then BSP desc)
          //   tier 1 — has timer + not Okay (until ascending = next out first)
          //   tier 2 — everything else (Flying / Abroad / Fallen) by BSP desc
          // sortDir is intentionally ignored — farm has fixed semantics.
          const tier = m => m.status_state === 'Okay'
            ? 0
            : (m.status_until && m.status_state !== 'Okay' ? 1 : 2)
          const tA = tier(a), tB = tier(b)
          if (tA !== tB) return tA - tB
          if (tA === 0) {
            const aAt = okayAt.get(a.member_id) ?? -1
            const bAt = okayAt.get(b.member_id) ?? -1
            if (aAt !== bAt) return bAt - aAt
            return (b.bsp_total ?? 0) - (a.bsp_total ?? 0)
          }
          if (tA === 1) return (a.status_until ?? Infinity) - (b.status_until ?? Infinity)
          return (b.bsp_total ?? 0) - (a.bsp_total ?? 0)
        }
        case 'timer': {
          // Members with an active timer (Hospital/Jail with status_until) sort by
          // timer in the chosen direction. Everyone else (Okay / Flying / Fallen
          // / no-timer) drops to the bottom and is grouped by status → activity →
          // name so the trailing rows are at least scannable.
          const hasTimerA = !!a.status_until && a.status_state !== 'Okay'
          const hasTimerB = !!b.status_until && b.status_state !== 'Okay'
          if (hasTimerA && hasTimerB) return d * (a.status_until - b.status_until)
          if (hasTimerA) return -1
          if (hasTimerB) return 1
          const statusCmp = (a.status_state ?? '').localeCompare(b.status_state ?? '')
          if (statusCmp !== 0) return statusCmp
          const activityOrder = { Online: 0, Idle: 1, Offline: 2 }
          const actCmp = (activityOrder[a.last_action_status] ?? 3) - (activityOrder[b.last_action_status] ?? 3)
          if (actCmp !== 0) return actCmp
          return a.member_name.localeCompare(b.member_name)
        }
        case 'stats':
          return d * ((a.bsp_total ?? -1) - (b.bsp_total ?? -1))
        default: return 0
      }
    })
  }, [members, statusFilter, activityFilter, statsFilterEnabled, statsFilterMin, statsFilterMax, sortCol, sortDir])

  // ── Mobile War Room adapters ──────────────────────────────────────────────
  // Project the desktop's flat enemy `members` rows onto the prop shape that
  // MobileWarRoomView expects. Pure renaming — no transformation. The mobile
  // component is presentational; all polling/realtime stays in this parent.
  const mobileMembers = useMemo(() => members.map(m => ({
    id:           m.member_id,
    name:         m.member_name,
    level:        m.level,
    activity:     m.last_action_status,
    lastActionTs: m.last_action_timestamp,
    state:        m.status_state,
    description:  m.status_description,
    until:        m.status_until,
    bsp:          m.bsp_total,
    // Stats breakdown + provenance so the mobile card can show the same
    // expand-on-tap breakdown the desktop shows on hover.
    bspStr:       m.bsp_str,
    bspDef:       m.bsp_def,
    bspSpd:       m.bsp_spd,
    bspDex:       m.bsp_dex,
    bspFetchedAt: m.bsp_fetched_at,
    spySource:    m.spy_source,
    tsSpyAt:      m.ts_spy_at,
    flags: {
      revivable:      !!m.is_revivable,
      earlyDischarge: !!m.has_early_discharge,
      inOc:           !!m.is_in_oc,
      onWall:         !!m.is_on_wall,
    },
  })), [members])

  // Activity-bucket counts for our faction. The mobile header strip wants
  // { Online, Idle, Offline } shaped the same way ActivityCounts computes.
  const mobileOurCounts = useMemo(() => {
    const c = { Online: 0, Idle: 0, Offline: 0 }
    for (const m of ourMembers) {
      const k = m.last_action_status
      if (k && c[k] !== undefined) c[k] += 1
    }
    return c
  }, [ourMembers])

  // The dibs store uses snake_case from the DB (claimed_by / claimed_name);
  // MobileWarRoomView's MemberCard expects camelCase (claimedBy / claimedName).
  // Without this adapter every dib would read as "claimed by someone else,"
  // which both greys out the user's own Attack button and hides the claimer's name.
  const mobileDibs = useMemo(() => {
    const out = {}
    for (const [targetId, d] of Object.entries(dibs)) {
      out[targetId] = {
        ...d,
        claimedBy: d.claimed_by,
        claimedName: d.claimed_name,
      }
    }
    return out
  }, [dibs])

  // ── Render helpers ─────────────────────────────────────────────────────────

  if (configLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-3 text-gray-600 dark:text-gray-400">Loading war room…</span>
      </div>
    )
  }

  const isActive   = !!config?.enabled
  const hasMembers = members.length > 0

  const resolvedName = factionName ?? config?.faction_name
  const factionLabel = resolvedName
    ? `${resolvedName} [${config?.faction_id}]`
    : config?.faction_id ? `Faction ${config.faction_id}` : null
  const factionLink = config?.faction_id
    ? `https://www.torn.com/factions.php?step=profile&ID=${config.faction_id}`
    : null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Header card */}
      <div className="card">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                War Room —
                {factionLabel && factionLink ? (
                  <a
                    href={factionLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 text-blue-600 dark:text-blue-400 hover:underline"
                  >
                   {factionLabel}
                  </a>
                ) : factionLabel ? (
                  `${factionLabel}`
                ) : ''}
              </h2>
              {isActive && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> LIVE
                </span>
              )}
              {/* Leadership controls collapse toggle — sits on the title row
                  so admins can hide all admin chrome by default and only show
                  it when needed. Only rendered to leadership. */}
              {isLeadership && (
                <button
                  onClick={() => setLeadershipPanelOpen(v => !v)}
                  title={leadershipPanelOpen ? 'Hide leadership controls' : 'Show leadership controls'}
                  aria-expanded={leadershipPanelOpen}
                  aria-label="Toggle leadership controls"
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
                    leadershipPanelOpen
                      ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                      : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400'
                  }`}
                >
                  <Settings className="w-4 h-4" />
                </button>
              )}
              {/* Mobile launcher — only visible below md breakpoint (<768px).
                  Opens the dedicated mobile-optimised War Room overlay. */}
              <button
                onClick={() => setMobileOpen(true)}
                className="md:hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
              >
                <Smartphone className="w-4 h-4" />
                Mobile App
              </button>
            </div>
            {/* Subtitle / enemy summary */}
            {!isActive && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {hasMembers
                  ? 'War room paused — showing last-known data. Enable to start live polling.'
                  : 'Real-time enemy faction monitor. Leadership must enable it to start polling.'}
              </p>
            )}
          </div>

          {/* Header right column — just status indicator + error messages.
              All leadership actions live in ConfigPanel below, grouped
              with the rest of the admin controls. */}
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {isActive && lastFetched && !pollError && (
              <span className="text-xs text-gray-400 dark:text-gray-500 hidden sm:block">
                {Math.round((Date.now() - lastFetched) / 1000)}s ago
              </span>
            )}
            {(pollError || toggleError || spiesMsg || dibsError) && (
              <div className="text-right space-y-0.5">
                {pollError   && <p className="text-xs text-red-500 dark:text-red-400">⚠ Poll: {pollError}</p>}
                {toggleError && <p className="text-xs text-red-500 dark:text-red-400">⚠ {toggleError}</p>}
                {spiesMsg && isLeadership && <p className={`text-xs ${spiesMsg.ok ? 'text-purple-600 dark:text-purple-400' : 'text-red-500 dark:text-red-400'}`}>{spiesMsg.text}</p>}
                {dibsError   && <p className="text-xs text-red-500 dark:text-red-400">⚠ Dibs: {dibsError}</p>}
              </div>
            )}
          </div>
        </div>

        {isLeadership && leadershipPanelOpen && (
          <ConfigPanel
            config={config}
            isActive={isActive}
            toggling={toggling}
            onToggleEnabled={toggleEnabled}
            updatingSpies={updatingSpies}
            onUpdateSpies={handleUpdateSpies}
            pollIntervalSec={pollIntervalSec}
            onPollIntervalChange={(v) => setPollIntervalSec(Math.max(0.5, Number(v) || 0.5))}
            onSaveAndFetch={handleSaveAndFetch}
            onSaveReviveService={handleSaveReviveService}
            onSaveReviveList={handleSaveReviveList}
            onClearState={handleClearState}
          />
        )}

        {/* Filters — shown whenever there are members to filter */}
        {hasMembers && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-slate-700 flex flex-col gap-2">
            <div className="flex flex-wrap gap-y-2 gap-x-4 items-center">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-0.5">Status:</span>
                <button
                  onClick={() => setStatusFilter(new Set())}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    statusFilter.size === 0
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  All
                </button>
                {STATUS_FILTERS.map(f => (
                  <button key={f} onClick={() => toggleStatusFilter(f)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      statusFilter.has(f)
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-0.5">Activity:</span>
                <button
                  onClick={() => setActivityFilter(new Set())}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    activityFilter.size === 0
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  All
                </button>
                {ACTIVITY_FILTERS.map(f => (
                  <button key={f} onClick={() => toggleActivityFilter(f)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      activityFilter.has(f)
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Farm mode toggle — overrides column-header sort with a tiered
                "Okay (most-recently-released first) → timer ascending → other"
                layout designed for watching hospital list during farming.
                Clicking any sortable column header turns farm off again. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Sort:</span>
              <button
                onClick={() => setSortCol(c => c === 'farm' ? 'timer' : 'farm')}
                title="Tiered sort: Okay at top (just-released first), then hospital/jail by timer ascending. Click a column header to leave farm mode."
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  sortCol === 'farm'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {sortCol === 'farm' ? 'Farm mode — ON' : 'Farm mode'}
              </button>
              {sortCol === 'farm' && (
                <span className="text-[11px] text-gray-500 dark:text-gray-500">
                  Okay first (just-released at top), then timer ascending. Click a column to exit.
                </span>
              )}
            </div>

            {/* Stats filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Stats:</span>
              <button
                onClick={() => setStatsFilterEnabled(v => !v)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  statsFilterEnabled
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {statsFilterEnabled ? 'On' : 'Off'}
              </button>
              <input
                type="text"
                placeholder="Min (e.g. 3m)"
                value={statsFilterMin}
                onChange={e => setStatsFilterMin(e.target.value)}
                className={`w-28 px-2.5 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${statsFilterEnabled ? '' : 'opacity-60'}`}
              />
              <span className="text-xs text-gray-400 dark:text-gray-600">–</span>
              <input
                type="text"
                placeholder="Max (e.g. 2.6b)"
                value={statsFilterMax}
                onChange={e => setStatsFilterMax(e.target.value)}
                className={`w-28 px-2.5 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${statsFilterEnabled ? '' : 'opacity-60'}`}
              />
              {statsFilterEnabled && (parseStatInput(statsFilterMin) !== null || parseStatInput(statsFilterMax) !== null) && (
                <span className="text-xs text-blue-600 dark:text-blue-400">
                  {[
                    parseStatInput(statsFilterMin) !== null && `≥ ${formatStats(parseStatInput(statsFilterMin))}`,
                    parseStatInput(statsFilterMax) !== null && `≤ ${formatStats(parseStatInput(statsFilterMax))}`,
                  ].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Paused notice — above the status bar so it's visible even without scrolling */}
      {!isActive && hasMembers && (
        <div className="rounded-lg px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2">
          <span>⚠</span>
          <span>Paused — last-known snapshot. Timers shown are not live. Enable the war room to start polling.</span>
        </div>
      )}

      {/* Faction status bar — shown whenever enemy members are loaded (active or paused) */}
      {hasMembers && (() => {
        // The active service's "source" + "sourceKey" live inside the revive_services
        // jsonb list (alongside name + url). Derive at render — no extra DB columns.
        const activeService = (config?.revive_services ?? []).find(s => s.name === config?.revive_service_name)
        const activeSource    = activeService?.source    ?? activeService?.name ?? null
        const activeSourceKey = activeService?.sourceKey ?? 'source'
        const activePreset    = activeService?.preset    ?? 'json'
        // Resolve the requester's current country from our own faction's
        // war_room_state row (e.g. "In a Mexican hospital" → "Mexico").
        // Used by the Nuke direct-POST path which needs to send the country
        // explicitly (the Edge Function path resolves it server-side).
        const myRow = ourMembers.find(m => String(m.member_id) === String(user?.id))
        const userCountry = resolveCountryFromDescription(myRow?.status_description)
        return (
          <FactionStatusBar
            enemyMembers={members}
            ourMembers={ourMembers}
            factionLabel={resolvedName ?? (config?.faction_id ? `Faction ${config.faction_id}` : null)}
            reviveServiceName={config?.revive_service_name}
            reviveServiceUrl={config?.revive_service_url}
            reviveServiceSource={activeSource}
            reviveServiceSourceKey={activeSourceKey}
            reviveServicePreset={activePreset}
            userCountry={userCountry}
            user={user}
            factionName={appConfig.faction.name}
          />
        )
      })()}

      {/* Member table — shown whenever members exist, or when active (so "waiting…" shows) */}
      {(hasMembers || isActive) ? (
        <div className="card p-0 overflow-hidden">

          {!hasMembers ? (
            <div className="flex items-center justify-center py-16 text-gray-400 dark:text-gray-600 text-sm">
              Waiting for first poll… ({pollIntervalSec}s interval)
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    <SortTh col="name"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="px-4">Name</SortTh>
                    <SortTh col="activity" sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Activity</SortTh>
                    <SortTh col="status"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Status</SortTh>
                    <SortTh col="timer"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Timer</SortTh>
                    <SortTh col="stats"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right">Stats</SortTh>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Flags</th>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Dibs</th>
                    <th className="py-2.5 px-3 sticky top-0 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                        No members match the current filters.
                      </td>
                    </tr>
                  )}
                  {filtered.map((m, idx) => {
                    const dib = dibs[m.member_id]
                    const isMyDib = dib && String(dib.claimed_by) === String(user?.id)
                    const rowBg = idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/50 dark:bg-slate-800/40'

                    return (
                      <tr key={m.member_id} className={`${rowBg} hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors`}>
                        {/* Name */}
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <a href={`https://www.torn.com/profiles.php?XID=${m.member_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                              {m.member_name}
                            </a>
                            <span className="text-xs text-gray-400 dark:text-gray-600">Lv{m.level}</span>
                          </div>
                        </td>

                        {/* Activity */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <div className="flex flex-col gap-0.5">
                            <ActivityBadge status={m.last_action_status} />
                            <span className="text-xs text-gray-400 dark:text-gray-600">{formatRelative(m.last_action_timestamp)}</span>
                          </div>
                        </td>

                        {/* Status */}
                        <td className="py-2.5 px-3">
                          <StatusCell state={m.status_state} description={m.status_description} />
                        </td>

                        {/* Timer */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <CountdownCell until={m.status_until} />
                        </td>

                        {/* Stats — hover for str/dex/spd/def breakdown + source. */}
                        <td className="py-2.5 px-3 whitespace-nowrap text-right">
                          <BspCell member={m} />
                        </td>

                        {/* Flags */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {(() => {
                            const isFlying = stateToFilterKey(m.status_state, m.status_description) === 'Flying'
                            const anyFlag = m.is_revivable || m.has_early_discharge || m.is_in_oc || m.is_on_wall || isFlying
                            return (
                              <div className="flex items-center gap-1.5">
                                {isFlying            && <span title="Flying / abroad" className="text-base leading-none cursor-default">✈</span>}
                                {m.is_revivable       && <span title="Revivable"       className="text-base leading-none cursor-default">💉</span>}
                                {m.has_early_discharge && <span title="Early Discharge" className="text-base leading-none cursor-default">⚡</span>}
                                {m.is_in_oc           && <span title="In OC"           className="text-base leading-none cursor-default">🔒</span>}
                                {m.is_on_wall         && <span title="On Wall"         className="text-base leading-none cursor-default">🛡</span>}
                                {!anyFlag && (
                                  <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>
                                )}
                              </div>
                            )
                          })()}
                        </td>

                        {/* Dibs */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {dib ? (
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs font-medium ${isMyDib ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                {isMyDib ? 'You' : dib.claimed_name}
                              </span>
                              {(isMyDib || isAdmin) && (
                                <button onClick={() => handleReleaseDibs(m.member_id)}
                                  title={isMyDib ? 'Release your dibs' : 'Admin override: release this claim'}
                                  className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 underline">
                                  Release
                                </button>
                              )}
                            </div>
                          ) : (
                            <button onClick={() => handleClaimDibs(m.member_id)}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                              Dibs
                            </button>
                          )}
                        </td>

                        {/* Attack / Assist — flips to a blue "Assist" link
                            when someone else has dibs, so allies can still
                            jump in and help instead of being locked out. */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {dib && !isMyDib ? (
                            <a href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.member_id}`}
                              target="_blank" rel="noopener noreferrer"
                              title={`${dib.claimed_name} called dibs — click to assist`}
                              className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium transition-colors">
                              ⚔ Assist {dib.claimed_name}
                            </a>
                          ) : (
                            <a href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.member_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-medium transition-colors">
                              ⚔ Attack
                            </a>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="px-4 py-2.5 border-t border-gray-200 dark:border-slate-700 flex items-center justify-between text-xs text-gray-400 dark:text-gray-600">
            <span>Showing {filtered.length} of {members.length} members</span>
            {isActive
              ? <span>Enemy: every {pollIntervalSec}s · Ours: every 30s · Timers: every 1s</span>
              : <span>Static snapshot · Enable to refresh</span>
            }
          </div>
        </div>
      ) : (
        // No members and not active — non-leadership sees a simple message
        !isLeadership && (
          <div className="card flex items-center justify-center py-10 text-gray-400 dark:text-gray-600">
            <span className="text-sm">War Room is not currently active.</span>
          </div>
        )
      )}

      {/* ── Mobile War Room overlay ────────────────────────────────────
          On actual phones (<sm) the inner frame fills the viewport. On
          desktop browsers we render the mobile UI inside a centred
          phone-shaped frame (max ~420px wide) on a dimmed backdrop so it
          previews at a realistic mobile resolution and browser zoom
          scales it relative to itself rather than revealing more page.
          Desktop WarRoomView still owns all state, realtime
          subscriptions, and handlers — MobileWarRoomView is purely
          presentational. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center sm:p-4 overflow-hidden"
          style={{ width: '100dvw', height: '100dvh' }}
        >
          <div className="w-full h-full sm:w-[420px] sm:max-w-full sm:h-[90vh] sm:max-h-[900px] sm:rounded-3xl overflow-hidden shadow-2xl bg-gray-50 dark:bg-slate-900 ring-1 ring-black/10 dark:ring-white/10">
            <MobileWarRoomView
              members={mobileMembers}
              dibsByEnemyId={mobileDibs}
              currentUserId={user?.id}
              factionId={String(config?.faction_id ?? '')}
              factionName={factionName ?? config?.faction_name}
              ourCounts={mobileOurCounts}
              isLeadership={isLeadership}
              isActive={isActive}
              paused={!isActive}
              pollIntervalS={pollIntervalSec}
              onPollIntervalChange={(s) => setPollIntervalSec(Math.max(0.5, Number(s) || 0.5))}
              reviveServices={Array.isArray(config?.revive_services) ? config.revive_services : []}
              activeReviveName={config?.revive_service_name ?? ''}
              activeReviveUrl={config?.revive_service_url ?? ''}
              onPickReviveService={handleSaveReviveService}
              onRequestRevive={async () => {
                // Mirror desktop ReviveQuickLinkButton: look up the active
                // service's source/sourceKey/preset from the revive_services
                // list (those don't live in dedicated config columns) and
                // proxy through the same requestRevive helper. The preset
                // selects payload shape AND transport (nuke = direct browser
                // POST to match userscript fingerprint). `country` is only
                // consumed by the nuke path.
                const active = (config?.revive_services ?? []).find(s => s.name === config?.revive_service_name)
                const myRow = ourMembers.find(m => String(m.member_id) === String(user?.id))
                return requestRevive(
                  {
                    url: config?.revive_service_url,
                    userID: Number(user?.id),
                    userName: user?.name,
                    factionName: appConfig.faction.name,
                    source: active?.source ?? active?.name ?? 'War Room',
                    sourceKey: active?.sourceKey ?? 'source',
                    preset: active?.preset ?? 'json',
                    country: resolveCountryFromDescription(myRow?.status_description),
                  },
                  user?.apiKey,
                )
              }}
              updatingSpies={updatingSpies}
              spiesMsg={spiesMsg}
              tornstatsMaxAgeDays={config?.tornstats_max_age_days ?? 0}
              onChangeTornstatsMaxAge={(n) => handleSaveReviveService({ tornstats_max_age_days: n })}
              onClaim={handleClaimDibs}
              onRelease={handleReleaseDibs}
              onTogglePaused={toggleEnabled}
              onUpdateSpies={handleUpdateSpies}
              onSetFactionId={handleSaveAndFetch}
              onClearState={handleClearState}
              onClose={() => setMobileOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
