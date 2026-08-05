// War Room v2 — delta-polling architecture.
// At Phase 5 cutover this is the canonical War Room implementation. The
// "V2" suffix in filenames + exports is a vestige of side-by-side
// validation; renaming is deferred to a quiet follow-up commit.
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useViewState } from '../contexts/ViewStateContext'
import {
  fetchWarRoomMembersV2,
  fetchOurMembersV2,
  fetchBspStatsV2,
  setWarRoomConfigV2,
  clearWarRoomStateV2,
  claimDibsV2,
  releaseDibsV2,
  claimChainSaveV2,
  releaseChainSaveV2,
  fetchChainsV2,
  requestRevive,
  resolveCountryFromDescription,
  submitRollCall,
  saveWarNotes,
  getWarNotesPrivate,
  fetchRollCall,
  fetchWarNotes,
} from '../utils/warRoomApiV2'
import { apiGet, apiPut } from '../utils/apiClient'
import MemberNoteButton from '../components/warroom/MemberNoteButton'
import { isOverdosed, canEditMemberNotes, notesByMember } from '../utils/memberNotes'
import { useWarRoomSocket } from '../hooks/useWarRoomSocket'
import { isWarLead as checkWarLead } from '../config'
import { getFactionId, getFactionIdentity } from '../utils/factionIdentity'
import { effectiveReviveServices } from '../utils/reviveServices'
import { FactionWarIcon, FactionMedicalIcon, ItemsIcon, RevivesIcon } from '../components/WarRoomIcons'
import ReviveServicesModal from '../components/ReviveServicesModal'
import MobileWarRoomView from './MobileWarRoomView'
import RollCallOverlay from '../components/warroom/RollCallOverlay'
import WarSummaryCard from '../components/warroom/WarSummaryCard'
import WarNotesPanel from '../components/warroom/WarNotesPanel'
import AlertSettingsButton from '../components/warroom/AlertSettingsButton'
import HeadlineBanner, { PUSH_HEADLINE_PRESETS } from '../components/warroom/HeadlineBanner'
import WarRoomPushPrompt from '../components/warroom/WarRoomPushPrompt'
import { setWarHeadline } from '../utils/warRoomApiV2'
import { useWarRoomAlerts } from '../hooks/useWarRoomAlerts'
import { loadAlertPrefs, fireAlert } from '../utils/warRoomAlerts'
import { rollCallGateActive, canSeeWarNotes, isRollCallDismissed, markRollCallDismissed } from '../utils/rollCall'
import { parseDbTime } from '../utils/time'
import { farmCompare } from '../utils/warRoomFarmSort'
import { Smartphone, Settings, Crosshair, Loader2, ClipboardList, HelpCircle, AlertTriangle, X as XIcon } from 'lucide-react'
import HelpPanel from '../components/warroom/HelpPanel'
import SpotlightTour from '../components/warroom/SpotlightTour'
import { tourStepsFor } from '../components/warroom/warRoomTourSteps'
import { isTourSeen, markTourSeen, resetTourSeen } from '../utils/warRoomTour'

// OUR_FACTION_ID and flattenMemberRow are owned by useWarRoomPoll in v2 —
// the hook flattens rows before exposing them. The view receives the flat
// shape and uses the bootstrap faction id (coerced to number inside the
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
  // Use parseDbTime, not new Date(): the API serves Postgres timestamptz text
  // with a bare "+00" offset (db.ts) that JS Date rejects → the age showed a
  // dash even with a real ts_spy_at (#140).
  const ageDate = isTs && m.ts_spy_at ? parseDbTime(m.ts_spy_at) : parseDbTime(m.bsp_fetched_at)
  const ageSourceTs = ageDate ? Math.floor(ageDate.getTime() / 1000) : null
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
  // "Okay in Torn" — strict: status_state AND status_description both 'Okay'.
  // Excludes Traveling/Abroad/Hospital/Jail. The parenthetical Online subset
  // shows how many of the Okay pool are also active right now (decision input
  // for "how many of them could chain-hit at this moment").
  const okayInTorn = members.filter(m => m.status_state === 'Okay' && m.status_description === 'Okay')
  const okayCount  = okayInTorn.length
  const okayOnline = okayInTorn.filter(m => m.last_action_status === 'Online').length
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
      <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
        <span className="font-semibold">{okayCount}</span> Okay
        <span className="text-xs text-emerald-600/70 dark:text-emerald-500/70">({okayOnline} online)</span>
      </span>
    </div>
  )
}

// ── Chain timer ─────────────────────────────────────────────────────────────
// Reads from war_room_chain_v2 (singleton, polled by the cron tick at 5s/30s
// with force-on-deadline). Countdown ticks client-side every second for smooth
// visual; the underlying numbers refresh from the DB delta poll.

// Active chain timer — capped by Torn at ~5 min, so MM:SS suffices.
function formatActiveTime(secs) {
  if (secs <= 0) return '0:00'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Cooldown countdown — can run multi-hour, so always HH:MM:SS. Hours can
// exceed 24 (e.g. a long chain cooldown) and grow naturally.
function formatCooldownTime(secs) {
  if (secs <= 0) return '00:00:00'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function chainStateOf(chain) {
  if (!chain) return 'idle'
  const nowSec = Math.floor(Date.now() / 1000)
  if (chain.cooldown && chain.cooldown > nowSec) return 'cooldown'
  if (chain.timeout && chain.timeout > nowSec && (chain.current ?? 0) > 0) return 'active'
  return 'idle'
}

function ChainTimerCard({ chain, userId, isAdmin, onClaim, onRelease, claimError }) {
  // Tick local clock every second for smooth countdown.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  const state = chainStateOf(chain)
  const secsLeft = state === 'active' && chain?.timeout ? Math.max(0, chain.timeout - now) : 0
  const cooldownLeft = state === 'cooldown' && chain?.cooldown ? Math.max(0, chain.cooldown - now) : 0

  // Color ramp matches the tampermonkey reference: green ≥3min, yellow 1-3min,
  // red <1min (pulsing). Cooldown and idle are gray.
  let timerClass = 'text-gray-500 dark:text-gray-400'
  let bgClass = 'bg-gray-50 dark:bg-slate-800/50'
  if (state === 'active') {
    if (secsLeft < 60)        { timerClass = 'text-red-600 dark:text-red-400 font-bold'; bgClass = 'bg-red-50 dark:bg-red-900/30 animate-pulse' }
    else if (secsLeft <= 180) { timerClass = 'text-amber-600 dark:text-amber-400 font-semibold'; bgClass = 'bg-amber-50 dark:bg-amber-900/20' }
    else                      { timerClass = 'text-green-600 dark:text-green-400 font-semibold'; bgClass = 'bg-green-50 dark:bg-green-900/20' }
  }

  const claimedByMe = chain?.save_claimed_by && String(chain.save_claimed_by) === String(userId)
  const claimedBySomeone = !!chain?.save_claimed_by
  const canRelease = claimedByMe || (claimedBySomeone && isAdmin)

  // Enemy chain readout. The enemy payload includes an absolute `timeout`
  // (refreshed every ~30s), so we can show a live countdown like our own chain
  // and tell at a glance whether their chain is about to drop.
  const enemy = chain?.enemy
  const enemyCooldownLeft = enemy?.cooldown && enemy.cooldown > now ? enemy.cooldown - now : 0
  const enemySecsLeft = enemy?.timeout && enemy.timeout > now ? enemy.timeout - now : 0
  const enemyState = enemy
    ? (enemyCooldownLeft > 0 ? 'cooldown' : ((enemy.current ?? 0) > 0 ? 'active' : 'idle'))
    : 'unknown'
  // Same urgency ramp as our chain so "close to dropping" reads red.
  let enemyTimerClass = 'text-purple-600 dark:text-purple-400 font-semibold'
  if (enemySecsLeft > 0 && enemySecsLeft < 60)        enemyTimerClass = 'text-red-600 dark:text-red-400 font-bold'
  else if (enemySecsLeft > 0 && enemySecsLeft <= 180) enemyTimerClass = 'text-amber-600 dark:text-amber-400 font-semibold'
  const enemyLabel =
    enemyState === 'cooldown' ? `${(enemy.current ?? 0).toLocaleString()}× — cooldown ${formatCooldownTime(enemyCooldownLeft)}` :
    enemyState === 'idle'     ? 'no chain' :
    enemyState === 'active'   ? `${(enemy.current ?? 0).toLocaleString()}× chained` :
                                '—'

  return (
    <div className={`flex items-center gap-3 px-3 py-1.5 rounded-md border border-gray-200 dark:border-slate-700 ${bgClass} transition-colors`}>
      {/* Our chain — timer + value */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Chain</span>
        {state === 'active' && (
          <>
            <span className={`font-mono text-lg leading-none ${timerClass}`}>{formatActiveTime(secsLeft)}</span>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              <span className="font-semibold">{(chain.current ?? 0).toLocaleString()}×</span>
              {chain.modifier ? <span className="text-xs ml-1 text-gray-500">R{Number(chain.modifier).toFixed(2)}</span> : null}
            </span>
          </>
        )}
        {state === 'cooldown' && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            cooldown <span className="font-mono">{formatCooldownTime(cooldownLeft)}</span>
          </span>
        )}
        {state === 'idle' && (
          <span className="text-xs text-gray-400 dark:text-gray-500">no chain</span>
        )}
      </div>

      {/* Save claim controls — only when chain is active */}
      {state === 'active' && (
        <div className="flex items-center gap-2 ml-auto">
          {!claimedBySomeone && (
            <button
              onClick={onClaim}
              className="text-xs px-2.5 py-1 rounded border border-blue-400 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:hover:bg-blue-900/60 dark:text-blue-300 dark:border-blue-700 font-medium transition-colors"
            >
              Save Chain
            </button>
          )}
          {claimedBySomeone && (
            <span className={`text-xs ${claimedByMe ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
              {claimedByMe ? "You're saving" : `${chain.save_claimed_name} is saving`}
            </span>
          )}
          {canRelease && (
            <button
              onClick={onRelease}
              title={claimedByMe ? 'Release your claim' : 'Admin override: release claim'}
              className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 underline"
            >
              Release
            </button>
          )}
        </div>
      )}

      {/* Enemy chain readout — timer + value, mirrors our chain countdown */}
      <div className={`flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 ${state === 'active' ? '' : 'ml-auto'}`}>
        <span className="uppercase tracking-wide font-semibold">Enemy:</span>
        {enemyState === 'active' && enemySecsLeft > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className={`font-mono text-sm leading-none ${enemyTimerClass}`}>{formatActiveTime(enemySecsLeft)}</span>
            <span className="text-purple-600 dark:text-purple-400 font-medium">{(enemy.current ?? 0).toLocaleString()}×</span>
          </span>
        ) : (
          <span className={enemyState === 'active' ? 'text-purple-600 dark:text-purple-400 font-medium' : ''}>
            {enemyLabel}
          </span>
        )}
      </div>

      {claimError && (
        <span className="text-xs text-red-500 dark:text-red-400 ml-2">⚠ {claimError}</span>
      )}
    </div>
  )
}

function FactionStatusBar({ enemyMembers, ourMembers, factionLabel, reviveServiceName, reviveServiceUrl, reviveServiceSource, reviveServiceSourceKey, reviveServicePreset, userCountry, user, factionName, chain, onClaimChainSave, onReleaseChainSave, chainClaimError, isAdmin }) {
  // On <md viewports stack into 3 rows so the bar can't overflow a phone
  // screen (which would inflate the layout viewport and break the mobile
  // overlay). On md+ keep the original single-row layout.
  // ChainTimerCard renders as a top sub-row when the cron has any chain data.
  return (
    <div className="card py-3 px-4 flex flex-col gap-3">
      {chain && (
        <ChainTimerCard
          chain={chain}
          userId={user?.id}
          isAdmin={isAdmin}
          onClaim={onClaimChainSave}
          onRelease={onReleaseChainSave}
          claimError={chainClaimError}
        />
      )}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4">
        <div className="flex items-center gap-3 md:gap-4 min-w-0 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide shrink-0">
            {factionLabel ?? 'Enemy'}
          </span>
          <ActivityCounts members={enemyMembers} />
        </div>
        <div data-tour="quickbar" className="flex items-center justify-center md:justify-center shrink-0 self-center md:self-auto">
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
      const result = await requestRevive(requestArgs)
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

// Find Target — emergency chain-save. Single click opens a random Torn user
// page in the configured ID range. Range defaults to the tampermonkey script's
// 3.6M–3.9M (likely-inactive accounts that are still attackable). Range is
// per-user via localStorage so each leader can tune for their own preference.
// A small gear next to the button opens an inline popover with the inputs.

const FT_RANGE_MIN_KEY = 'warroom_find_target_min'
const FT_RANGE_MAX_KEY = 'warroom_find_target_max'
const FT_DEFAULT_MIN = 4_200_000
const FT_DEFAULT_MAX = 4_300_000

function FindTargetButton() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  // localStorage seed on mount — keep as numbers internally.
  const [minId, setMinId] = useState(() => Number(localStorage.getItem(FT_RANGE_MIN_KEY)) || FT_DEFAULT_MIN)
  const [maxId, setMaxId] = useState(() => Number(localStorage.getItem(FT_RANGE_MAX_KEY)) || FT_DEFAULT_MAX)
  const popoverRef = useRef(null)

  // Close popover on outside click.
  useEffect(() => {
    if (!settingsOpen) return
    function onClick(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [settingsOpen])

  function pickAndOpen() {
    // Defensive clamp in case localStorage has garbage.
    const lo = Math.max(1, Math.min(minId, maxId) || FT_DEFAULT_MIN)
    const hi = Math.max(lo,  Math.max(minId, maxId) || FT_DEFAULT_MAX)
    const id = Math.floor(Math.random() * (hi - lo + 1)) + lo
    window.open(`https://www.torn.com/page.php?sid=attack&user2ID=${id}`, '_blank', 'noopener,noreferrer')
  }

  function commitMin(v) {
    const n = Math.max(1, Math.floor(Number(v) || FT_DEFAULT_MIN))
    setMinId(n)
    localStorage.setItem(FT_RANGE_MIN_KEY, String(n))
  }
  function commitMax(v) {
    const n = Math.max(1, Math.floor(Number(v) || FT_DEFAULT_MAX))
    setMaxId(n)
    localStorage.setItem(FT_RANGE_MAX_KEY, String(n))
  }

  const base = 'inline-flex items-center justify-center w-9 h-9 rounded-lg border transition-colors'
  return (
    <div className="relative inline-flex items-center gap-0.5" ref={popoverRef}>
      <button
        type="button"
        onClick={pickAndOpen}
        title={`Find Target — open random attack page in ID range ${minId.toLocaleString()}–${maxId.toLocaleString()}. Use when the chain timer is critical and you can't waste a second picking a target.`}
        className={`${base} border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300 hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20`}
      >
        <Crosshair className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(o => !o)}
        title="Adjust Find Target ID range (stored per-user in localStorage)"
        className="inline-flex items-center justify-center w-5 h-9 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
      >
        <Settings className="w-3 h-3" />
      </button>
      {settingsOpen && (
        <div className="absolute top-full right-0 mt-1 z-20 p-3 rounded-lg shadow-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 w-64 space-y-2">
          <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">Find Target ID range</div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 w-8">Min</label>
            <input
              type="number"
              value={minId}
              onChange={e => setMinId(Number(e.target.value) || 0)}
              onBlur={e => commitMin(e.target.value)}
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-gray-900 dark:text-white"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500 dark:text-gray-400 w-8">Max</label>
            <input
              type="number"
              value={maxId}
              onChange={e => setMaxId(Number(e.target.value) || 0)}
              onBlur={e => commitMax(e.target.value)}
              className="flex-1 px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded bg-white dark:bg-slate-900 text-gray-900 dark:text-white"
            />
          </div>
          <div className="text-[10px] text-gray-400 dark:text-gray-500">
            Defaults: {FT_DEFAULT_MIN.toLocaleString()}–{FT_DEFAULT_MAX.toLocaleString()}. Saved per-user.
          </div>
        </div>
      )}
    </div>
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
      <FindTargetButton />
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

  const services = effectiveReviveServices(config)
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

  // Chain poll cadences — how often the cron fetches /v2/faction/{id}/chain.
  // Ours defaults to 5s (we care a lot), enemy 30s (intel only). Both clamp
  // server-side to [1, 600]s in the Edge Function. Same commit-on-blur pattern.
  const [chainOursSec,  setChainOursSec]  = useState(String(config?.chain_poll_interval_ours_sec  ?? 5))
  const [chainEnemySec, setChainEnemySec] = useState(String(config?.chain_poll_interval_enemy_sec ?? 30))
  useEffect(() => { setChainOursSec(String(config?.chain_poll_interval_ours_sec  ?? 5)) },  [config?.chain_poll_interval_ours_sec])
  useEffect(() => { setChainEnemySec(String(config?.chain_poll_interval_enemy_sec ?? 30)) }, [config?.chain_poll_interval_enemy_sec])
  async function commitChainOurs() {
    const next = Math.min(600, Math.max(1, Math.floor(Number(chainOursSec) || 5)))
    if (next === (config?.chain_poll_interval_ours_sec ?? 5)) return
    try { await onSaveReviveService({ chain_poll_interval_ours_sec: next });  setMsg({ ok: true, text: `Our chain poll set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  async function commitChainEnemy() {
    const next = Math.min(600, Math.max(1, Math.floor(Number(chainEnemySec) || 30)))
    if (next === (config?.chain_poll_interval_enemy_sec ?? 30)) return
    try { await onSaveReviveService({ chain_poll_interval_enemy_sec: next }); setMsg({ ok: true, text: `Enemy chain poll set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // Dibs auto-drop window (#159): a claim on an already-alive target releases
  // this many seconds later if the holder still hasn't killed them. Default 30s,
  // clamped [5, 600]s. Same commit-on-blur pattern as the chain cadences.
  const [dibsExpirySec, setDibsExpirySec] = useState(String(config?.dibs_expiry_seconds ?? 30))
  useEffect(() => { setDibsExpirySec(String(config?.dibs_expiry_seconds ?? 30)) }, [config?.dibs_expiry_seconds])
  async function commitDibsExpiry() {
    const next = Math.min(600, Math.max(5, Math.floor(Number(dibsExpirySec) || 30)))
    if (next === (config?.dibs_expiry_seconds ?? 30)) return
    try { await onSaveReviveService({ dibs_expiry_seconds: next }); setMsg({ ok: true, text: `Dibs auto-drop set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // PUSH-surge alerts (#208): a global on/off plus per-direction rate thresholds
  // (N members Okay within M sec) and a cooldown. Off = a termed war stays
  // silent. Same commit-on-blur pattern as the cadences above; the toggle saves
  // immediately. All clamped server-side too via the config allowlist.
  const surgeEnabled = !!config?.surge_alerts_enabled
  const [surgeFields, setSurgeFields] = useState(null)
  useEffect(() => {
    setSurgeFields({
      surge_enemy_threshold:  String(config?.surge_enemy_threshold  ?? 3),
      surge_enemy_window_sec: String(config?.surge_enemy_window_sec ?? 60),
      surge_our_threshold:    String(config?.surge_our_threshold    ?? 4),
      surge_our_window_sec:   String(config?.surge_our_window_sec   ?? 60),
      surge_cooldown_sec:     String(config?.surge_cooldown_sec     ?? 300),
    })
  }, [config?.surge_enemy_threshold, config?.surge_enemy_window_sec, config?.surge_our_threshold, config?.surge_our_window_sec, config?.surge_cooldown_sec])
  async function toggleSurge() {
    try {
      await onSaveReviveService({ surge_alerts_enabled: !surgeEnabled })
      setMsg({ ok: true, text: `Surge alerts ${!surgeEnabled ? 'enabled' : 'disabled'}.` })
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  async function commitSurgeField(field, min, max, fallback) {
    const next = Math.min(max, Math.max(min, Math.floor(Number(surgeFields?.[field]) || fallback)))
    if (next === (config?.[field] ?? fallback)) return
    try { await onSaveReviveService({ [field]: next }); setMsg({ ok: true, text: 'Surge alert settings saved.' }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
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
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">UI Refresh</label>
          <div className="flex items-center gap-1.5" title="How often the UI re-reads the DB (delta poll). Torn API polling is now centralised server-side via pg_cron at 500ms — this slider only controls UI freshness from DB.">
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

        {/* Chain poll cadences — server-side throttle for /v2/faction/{id}/chain. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Our chain poll <span className="text-gray-400 dark:text-gray-600">(s)</span>
          </label>
          <input
            type="number"
            min={1}
            max={600}
            step={1}
            value={chainOursSec}
            onChange={e => setChainOursSec(e.target.value)}
            onBlur={commitChainOurs}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="5"
            title="How often the server polls our chain endpoint. Clamped to 1–600s. The cron forces an extra poll when the chain timer is within 6s of expiring regardless of this value."
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Enemy chain poll <span className="text-gray-400 dark:text-gray-600">(s)</span>
          </label>
          <input
            type="number"
            min={1}
            max={600}
            step={1}
            value={chainEnemySec}
            onChange={e => setChainEnemySec(e.target.value)}
            onBlur={commitChainEnemy}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="30"
            title="How often the server polls the enemy faction's chain endpoint. Clamped to 1–600s. Pauses while enemy is in cooldown."
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {/* Dibs auto-drop window (#159): free an unconverted claim on a live target. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Dibs auto-drop <span className="text-gray-400 dark:text-gray-600">(s)</span>
          </label>
          <input
            type="number"
            min={5}
            max={600}
            step={1}
            value={dibsExpirySec}
            onChange={e => setDibsExpirySec(e.target.value)}
            onBlur={commitDibsExpiry}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="30"
            title="If you dib an already-alive target and haven't killed them within this many seconds, your claim is released so someone else can take them. Only applies to alive targets — a hospital claim waits for them to come out. Clamped to 5–600s."
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* PUSH-surge alerts (#208): global on/off + per-direction rate + cooldown.
          Off means a termed war never pings anyone. */}
      <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={surgeEnabled} onChange={toggleSurge}
            className="w-4 h-4 rounded border-gray-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Push-surge alerts</span>
          <span className="text-xs text-gray-400 dark:text-gray-500">— warn on a wave of hospital exits (leave off for termed wars)</span>
        </label>
        {surgeEnabled && surgeFields && (
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2 pl-6">
            {[
              { label: 'Alert when ≥', field: 'surge_enemy_threshold', min: 1, max: 100, fb: 3, w: 'w-16', hint: 'Enemies leaving hospital within the window to trigger a "we\'re being pushed" alert.' },
              { label: 'within (s)', field: 'surge_enemy_window_sec', min: 5, max: 600, fb: 60, w: 'w-20', hint: 'Rolling window for the enemy hospital-exit count.' },
              { label: 'Cooldown (s)', field: 'surge_cooldown_sec', min: 30, max: 3600, fb: 300, w: 'w-24', hint: 'Quiet period after an alert so flicker can’t re-spam.' },
            ].map(({ label, field, min, max, fb, w, hint }) => (
              <div key={field}>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</label>
                <input
                  type="number" min={min} max={max} step={1} title={hint}
                  value={surgeFields[field]}
                  onChange={e => setSurgeFields(f => ({ ...f, [field]: e.target.value }))}
                  onBlur={() => commitSurgeField(field, min, max, fb)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  className={`${w} px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500`}
                />
              </div>
            ))}
          </div>
        )}
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
  const { user, tokenReady, isVisitor } = useAuth()
  // Derive war-lead status from config + ID rather than the session flag, so a
  // stale/older cached session object can't hide the War Notes controls.
  // API mode: the session's role_assignments are authoritative (bootstrap
  // sets user.isWarLead); legacy builds fall back to the config.js ID list.
  const isWarLead = user?.isWarLead ?? checkWarLead(user?.id)
  // War Notes & roll-call panel: war leaders + real leadership/admin, never
  // visitors (isLeadership is true for them — the leadership layout — but the
  // panel exposes the leads-only private note). See canSeeWarNotes.
  const canSeeNotes = canSeeWarNotes({ isWarLead, isLeadership, isVisitor })

  // Reload-persisted prefs: filter chips, stats range, sort, poll rate.
  // Sets are stored as arrays so JSON.stringify can round-trip them.
  const [persistedState, setPersistedState] = useViewState('warroom_desktop_v2')

  const [pollIntervalSec, setPollIntervalSec] = useState(() => persistedState.pollIntervalSec ?? 3)

  // ── v2 data layer ──
  // useWarRoomPoll owns config/members/ourMembers/dibs and refreshes via
  // war_room_*_v2_delta RPCs. The consumer-facing shape (arrays/objects) is
  // identical to v1's local state so the rest of this file is unchanged.
  // Per-tenant identity from bootstrap (#96) — resolved before views render.
  // Coerce to number to match the bigint faction_id column.
  const OUR_FACTION_ID = getFactionId()

  // Server-detected PUSH surge (#208): a transient banner + sound/flash, fired
  // automatically for every open tab (no opt-in). The web-push to subscribers
  // is sent server-side in the ticker.
  const [surgeAlert, setSurgeAlert] = useState(null)
  const onSurgeAlert = useCallback((msg) => {
    if (msg?.kind !== 'surge') return
    fireAlert('surge', { sound: true, flash: true })
    const shown = { ...msg, at: Date.now() }
    setSurgeAlert(shown)
    setTimeout(() => setSurgeAlert((cur) => (cur?.at === shown.at ? null : cur)), 12000)
  }, [])

  // #209: a leader can one-tap the matching rally-call preset onto the faction
  // headline. Nothing hits the banner until a leader confirms here (the surge
  // sound/flash/push in #208 already went to everyone).
  const [postingHeadline, setPostingHeadline] = useState(false)
  async function postSurgeHeadline() {
    const preset = PUSH_HEADLINE_PRESETS[surgeAlert?.direction]
    if (!preset) return
    setPostingHeadline(true)
    try {
      await setWarHeadline(preset.text, preset.tone)
      setSurgeAlert((cur) => (cur ? { ...cur, posted: true } : cur))
    } finally {
      setPostingHeadline(false)
    }
  }

  const {
    members: rawMembers,
    ourMembers,
    dibs,
    config,
    chain,
    isInitialLoading: configLoading,
    lastTick: lastFetched,
    pollError,
    pollNow,
  } = useWarRoomSocket({
    // API mode rides the WebSocket (intervalMs applies only to the legacy
    // polling transport and the REST fallback); legacy builds poll as before.
    intervalMs: Math.max(500, Math.round(pollIntervalSec * 1000)),
    enabled: !!user,
    ourFactionId: OUR_FACTION_ID,
    onAlert: onSurgeAlert,
  })

  // Hide enemy members who are effectively non-combatants:
  //   • Fallen   — Torn's "Resting in Peace" status; account is preserved
  //                so the faction can exceed 100 members but the player
  //                can't act and shouldn't be a chain target.
  //   • Federal  — federal jail, regular or permanent. Account is held
  //                and unreachable for the foreseeable future.
  // Both statuses still persist in war_room_state_v2 (we just filter at
  // render time) so any audit/history queries keep the original snapshot.
  // The polling delta keeps flowing for them, so when a player exits
  // federal jail they automatically reappear on the next tick.
  const members = useMemo(
    () => rawMembers.filter(m => m.status_state !== 'Fallen' && m.status_state !== 'Federal'),
    [rawMembers]
  )

  // Personal alerts (#156 dibs hospital-exit, #157 chain-watch). Per-user
  // prefs in localStorage; the hook fires sound/flash over the polled data and
  // reports when the chain is dropping so attack buttons can flag red.
  const [alertPrefs, setAlertPrefs] = useState(loadAlertPrefs)
  const { chainAlerting } = useWarRoomAlerts({
    chain, members, dibs, userId: user?.id, prefs: alertPrefs, active: !!config?.enabled,
  })

  const [toggling, setToggling]       = useState(false)
  const [toggleError, setToggleError] = useState(null)
  const [updatingSpies, setUpdatingSpies] = useState(false)
  const [spiesMsg, setSpiesMsg]       = useState(null)
  const [chainClaimError, setChainClaimError] = useState(null)

  // Leadership controls collapse — default closed so the page reads clean.
  // Persisted so users who keep it open don't have to reopen on every load.
  const [leadershipPanelOpen, setLeadershipPanelOpen] = useState(() => persistedState.leadershipPanelOpen ?? false)
  const [factionName, setFactionName] = useState(null)

  // ── Roll call + war notes ───────────────────────────────────────────────────
  const [notesPanelOpen, setNotesPanelOpen] = useState(() => persistedState.notesPanelOpen ?? false)
  const [currentWar, setCurrentWar]   = useState(null)   // { id, opponentId, opponentName, startAt }
  const [warNotes, setWarNotes]       = useState(null)
  const [rollCallRows, setRollCallRows] = useState([])
  const [rollCallLoaded, setRollCallLoaded] = useState(false)  // gate waits for this
  const [privateNotes, setPrivateNotes] = useState('')      // leads-only note
  const [rollCallOpen, setRollCallOpen] = useState(false)  // manual (edit) open
  // Gate dismissed for this war (member submitted, or a leader bypassed).
  // Persisted per war (#167) so a tab switch / re-mount / transient-empty
  // refresh can't re-trip the blocking overlay.
  const [rollCallDismissed, setRollCallDismissed] = useState(false)
  const [submittingRC, setSubmittingRC] = useState(false)
  const [rcError, setRcError]           = useState(null)
  const [savingNotes, setSavingNotes]   = useState(false)
  const [notesError, setNotesError]     = useState(null)
  const canBypass = isLeadership || isAdmin || isWarLead

  // Stats filter
  const [statsFilterEnabled, setStatsFilterEnabled] = useState(() => persistedState.statsFilterEnabled ?? false)
  const [statsFilterMin, setStatsFilterMin] = useState(() => persistedState.statsFilterMin ?? '')
  const [statsFilterMax, setStatsFilterMax] = useState(() => persistedState.statsFilterMax ?? '')

  // Mobile War Room overlay (only visible on < md viewport — see launcher button)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [tourActive, setTourActive] = useState(false)
  const [tourStep, setTourStep] = useState(null)
  const [alertsOpen, setAlertsOpen] = useState(false)

  // The tour opens the alerts window on its alerts step so members see what's
  // inside; it closes again when the tour moves on or ends.
  useEffect(() => {
    setAlertsOpen(!!tourStep?.openAlerts)
  }, [tourStep])

  // Per-member war notes (#199) — fetched once for the roster; war leads /
  // leadership / admin can edit, everyone reads. API-only feature.
  const [memberNotes, setMemberNotes] = useState({})
  const canEditNotes = canEditMemberNotes({ isWarLead, isLeadership, isAdmin, isVisitor })
  useEffect(() => {
    apiGet('/api/member-notes')
      .then(({ notes }) => setMemberNotes(notesByMember(notes)))
      .catch(() => {})
  }, [])
  async function saveMemberNote(memberId, note) {
    await apiPut(`/api/member-notes/${memberId}`, { note })
    setMemberNotes(prev => {
      const next = { ...prev }
      if (note && note.trim()) next[memberId] = note.trim()
      else delete next[memberId]
      return next
    })
  }

  // First-run spotlight tour (#153): auto-run once per browser on first War
  // Room visit. Steps whose targets aren't present are skipped, so it's safe to
  // start even before a war is active.
  useEffect(() => {
    if (!isTourSeen('desktop')) setTourActive(true)
  }, [])

  const finishTour = () => { markTourSeen('desktop'); setTourActive(false) }
  const replayTour = () => { resetTourSeen('desktop'); setHelpOpen(false); setTourActive(true) }

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

  const bspFiredRef      = useRef(false)
  const opponentFidRef = useRef(null)
  const membersRef     = useRef([])
  const userRef        = useRef(user)
  const dibsAbortRef   = useRef(null)   // cancels in-flight claim when user clicks another
  const [dibsError, setDibsError] = useState(null)
  // Tracks in-flight dibs writes per member so the row can flip optimistically
  // the moment the user clicks. Shape: { [memberId]: 'claim' | 'release' }.
  // Cleared in the handler's finally block after pollNow() returns canonical
  // truth (so a server-rejected claim disappears on the next render).
  const [pendingDibsOps, setPendingDibsOps] = useState({})

  // No refreshDibs / scheduleDibsRefresh in v2 — useWarRoomPoll polls the
  // dibs delta RPC every tick. Write handlers below call pollNow() after
  // success for ~50ms feedback latency.

  useEffect(() => { opponentFidRef.current = config?.faction_id }, [config?.faction_id])

  // Faction name comes down on the war-room config broadcast.
  useEffect(() => {
    if (!config?.faction_id) return
    if (config?.faction_name) setFactionName(config.faction_name)
  }, [config?.faction_id, config?.faction_name])
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
      notesPanelOpen,
    })
  }, [statusFilter, activityFilter, statsFilterEnabled, statsFilterMin, statsFilterMax, sortCol, sortDir, pollIntervalSec, leadershipPanelOpen, notesPanelOpen, setPersistedState])

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
      releaseDibsV2(id)
        .then(() => pollNow())
        .catch(e => console.error('Auto-release dibs:', e))
    }
    prevEnemyOkayRef.current = nowOkay
  }, [members, dibs, user?.id, pollNow])

  // ── BSP fire once when members first appear ───────────────────────────────

  useEffect(() => {
    if (!config?.enabled || !members.length || bspFiredRef.current) return
    bspFiredRef.current = true
    const missing = members.filter(m => m.bsp_total === null).map(m => m.member_id)
    if (!missing.length) return
    fetchBspStatsV2(missing).catch(e => console.error('BSP auto-fetch error:', e))
  }, [members.length, config?.enabled])

  // ── Torn polling is CENTRALISED server-side ───────────────────────────────
  // A single in-process ticker polls Torn once globally and writes war-room
  // state; viewers pick up changes over the WebSocket/delta hook rather than
  // each browser polling Torn. The Save flow and Update Spies still trigger
  // one-shot fetches (leader actions, not periodic).

  // ── Leadership actions ────────────────────────────────────────────────────

  async function toggleEnabled() {
    setToggling(true); setToggleError(null)
    try {
      const enabling = !config?.enabled
      if (enabling) bspFiredRef.current = false
      await setWarRoomConfigV2({ enabled: enabling })
      await pollNow()
    } catch (e) {
      setToggleError(e.message)
    } finally { setToggling(false) }
  }

  async function handleClearState() {
    await clearWarRoomStateV2()
    bspFiredRef.current = false
    await pollNow()
  }

  async function handleSaveReviveService(updates) {
    await setWarRoomConfigV2(updates)
    await pollNow()
  }

  // Same shape as handleSaveReviveService — the modal sends the full updated list
  // (plus optionally a cleared active selection if the active service was removed).
  async function handleSaveReviveList(updates) {
    await setWarRoomConfigV2(updates)
    await pollNow()
  }

  // Save flow: switching factions is a full reset — disable polling, wipe
  // state, save the new ID, pull an initial baseline.
  async function handleSaveAndFetch(newFactionId) {
    // 1. Disable polling so an in-flight poll for the OLD faction can't
    //    re-add members between the clear and the new fetch.
    if (config?.enabled) {
      await setWarRoomConfigV2({ enabled: false })
      await new Promise(r => setTimeout(r, 500))
    }
    // 2. Clear state (soft-deletes all current rows + zeroes the chain row).
    await clearWarRoomStateV2()
    bspFiredRef.current = false
    // 3. Persist the new faction_id (and reset cached name).
    // auto_managed:false — a manual Save yields the session to the leader, so
    // the lifecycle cron won't auto-disable it (e.g. when testing other factions).
    await setWarRoomConfigV2({ faction_id: newFactionId, faction_name: null, auto_managed: false, managed_war_id: null })
    setFactionName(null)
    // 4. Initial enemy + our fetch in parallel. Chain seed runs alongside
    //    so the ChainTimerCard shows the current state of both factions
    //    even before leadership enables war room. Chain fetch is best-effort:
    //    if Torn rejects (e.g., enemy ID typo) the member fetch result still
    //    drives the rest of the Save flow.
    const [enemyResp] = await Promise.all([
      fetchWarRoomMembersV2(newFactionId),
      fetchOurMembersV2(),
      fetchChainsV2(newFactionId).catch(e => console.warn('Chain seed failed:', e)),
    ])
    if (enemyResp?.faction_name) setFactionName(enemyResp.faction_name)
    // 5. Trigger an immediate poll so the new state appears within ~50ms.
    await pollNow()
  }

  // ── Roll call + war notes data ──────────────────────────────────────────────
  // Resolve the current/upcoming ranked war for the configured opponent. This
  // is what roll call + summary key off of; null = no active war (no gate).
  useEffect(() => {
    const oppId = config?.faction_id
    if (!oppId) { setCurrentWar(null); return }
    if (!tokenReady) return  // wait for the session token (RLS) before resolving
    let cancelled = false
    const resolve = apiGet('/api/wars?limit=20').then(({ wars }) =>
      (wars ?? [])
        .filter(w => Number(w.opponent_id) === Number(oppId))
        .sort((a, b) => (b.start_at ?? 0) - (a.start_at ?? 0))[0] ?? null
    )
    resolve.then((data) => {
      if (cancelled) return
      // Only treat as "current" when the war hasn't ended yet.
      if (data && !data.end_at) {
        setCurrentWar({ id: data.id, opponentId: data.opponent_id, opponentName: data.opponent_name, startAt: data.start_at })
      } else {
        setCurrentWar(null)
      }
    })
    return () => { cancelled = true }
  }, [config?.faction_id, tokenReady])

  // Load roll-call rows + notes for the current war; refresh periodically so the
  // summary counts + leader results stay reasonably live (data changes slowly).
  const refreshRollCall = useCallback(async () => {
    if (!currentWar?.id) { setRollCallRows([]); setWarNotes(null); setRollCallLoaded(true); return }
    // Per-channel guard (#167): a transient failure must NOT overwrite
    // known-good rows with [] — that would drop a submitted response and
    // re-trip the gate on a backgrounded/throttled tab. Adopt only a
    // successful read; only mark "loaded" once roll call actually loaded.
    const [rcRes, ntRes] = await Promise.allSettled([
      fetchRollCall(currentWar.id),
      fetchWarNotes(currentWar.id),
    ])
    if (rcRes.status === 'fulfilled') { setRollCallRows(rcRes.value ?? []); setRollCallLoaded(true) }
    if (ntRes.status === 'fulfilled') setWarNotes(ntRes.value ?? null)
  }, [currentWar?.id])

  useEffect(() => {
    // Wait for the session token — an RLS-denied read before it's ready returns
    // empty, which would wrongly trip the gate for someone who already responded.
    if (!tokenReady) return
    refreshRollCall()
    if (!currentWar?.id) return
    const t = setInterval(refreshRollCall, 30_000)
    return () => clearInterval(t)
  }, [refreshRollCall, currentWar?.id, tokenReady])

  const myRollCall = useMemo(
    () => rollCallRows.find(r => String(r.member_id) === String(user?.id)) ?? null,
    [rollCallRows, user?.id],
  )

  // A new war re-gates everyone: re-read this browser's persisted dismissal for
  // the new war (so a leader's bypass / a submit survives a re-mount), clear any
  // manual open, and mark roll call "not loaded" so the gate waits for the check.
  useEffect(() => {
    setRollCallDismissed(isRollCallDismissed(currentWar?.id))
    setRollCallOpen(false)
    setRollCallLoaded(false)
  }, [currentWar?.id])

  // Blocking gate: a current war, member hasn't responded, >1h before start, and
  // this browser hasn't dismissed it for this war. We only let it block AFTER the
  // roll-call check has completed (rollCallLoaded) so the overlay never flashes
  // for people who already filled it out. Manual "Roll Call" opens edit anytime.
  const gateActive = rollCallLoaded && rollCallGateActive({ currentWar, mySubmitted: !!myRollCall }) && !rollCallDismissed
  const showRollCall = gateActive || rollCallOpen

  async function handleSubmitRollCall(answers) {
    if (!currentWar?.id) return
    setSubmittingRC(true); setRcError(null)
    try {
      await submitRollCall(currentWar.id, answers)
      // Latch the gate closed for this war immediately + persistently (#167):
      // even before the refresh reflects the new row (or if a later refresh
      // transiently fails), the overlay won't come back for this browser.
      markRollCallDismissed(currentWar.id)
      setRollCallDismissed(true)
      await refreshRollCall()
      setRollCallOpen(false)
      // Let the global roll-call reminder banner re-check immediately so it
      // clears on submit instead of lingering until its next poll/refocus.
      window.dispatchEvent(new Event('rollcall:submitted'))
    } catch (e) {
      setRcError(e.message || 'Failed to submit roll call.')
    } finally {
      setSubmittingRC(false)
    }
  }

  // Load the leads-only private note via the edge function when a War Leader
  // opens the notes panel (it's never client-readable).
  useEffect(() => {
    // The session token authorizes the leads-only read.
    if (!notesPanelOpen || !canSeeNotes || !currentWar?.id) return
    let cancelled = false
    getWarNotesPrivate(currentWar.id)
      .then(r => { if (!cancelled) setPrivateNotes(r?.notes ?? '') })
      .catch(() => { if (!cancelled) setPrivateNotes('') })
    return () => { cancelled = true }
  }, [notesPanelOpen, canSeeNotes, currentWar?.id])

  // Collaborative live refresh: while the notes panel is open, pull the notes
  // (public via refreshRollCall + the leads-only private note) every few
  // seconds so war leads see each other's edits near-live. WarNotesPanel
  // re-syncs from these without clobbering in-progress local edits.
  useEffect(() => {
    if (!notesPanelOpen || !canSeeNotes || !currentWar?.id || !tokenReady) return
    let cancelled = false
    const tick = async () => {
      await refreshRollCall()
      const r = await getWarNotesPrivate(currentWar.id).catch(() => null)
      if (!cancelled && r) setPrivateNotes(r.notes ?? '')
    }
    const t = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [notesPanelOpen, canSeeNotes, currentWar?.id, tokenReady, refreshRollCall])

  async function handleSaveWarNotes(fields) {
    if (!currentWar?.id) return false
    setSavingNotes(true); setNotesError(null)
    try {
      await saveWarNotes(currentWar.id, fields)
      await refreshRollCall()  // refresh public notes + the optimistic-lock token
      const r = await getWarNotesPrivate(currentWar.id).catch(() => null)
      if (r) setPrivateNotes(r.notes ?? '')
      return true
    } catch (e) {
      setNotesError(e.message || 'Failed to save notes.')
      return false
    } finally {
      setSavingNotes(false)
    }
  }

  // Update Spies works even when the war room is paused: if no members are loaded
  // yet (paused state), it does an enemy fetch first, then BSP enrichment.
  async function handleUpdateSpies() {
    if (!config?.faction_id) return
    setUpdatingSpies(true); setSpiesMsg(null)
    try {
      let workingMembers = membersRef.current.length ? membersRef.current : members
      if (!workingMembers.length) {
        setSpiesMsg({ ok: true, text: 'Fetching members…' })
        await fetchWarRoomMembersV2(config.faction_id)
        // Give the next poll tick a beat to surface the new members, then
        // fall back to a direct delta read if the hook hasn't caught up.
        await pollNow()
        await new Promise(r => setTimeout(r, 200))
        workingMembers = membersRef.current
        if (!workingMembers.length) {
          const delta = await apiGet('/api/war-room/delta')
          const rows = delta?.state?.rows ?? []
          workingMembers = rows
            .filter(r => Number(r.faction_id) === Number(config.faction_id) && !r.deleted_at)
            .map(r => ({ member_id: r.member_id }))
        }
      }
      if (!workingMembers.length) throw new Error('No members loaded — check the faction ID')
      const ids = workingMembers.map(m => m.member_id)
      // Show progress BEFORE the await so it reflects in-flight state, not completion.
      setSpiesMsg({ ok: true, text: `Fetching spies for ${ids.length} members…` })
      const result = await fetchBspStatsV2(ids)
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

  // v2 dibs handlers: optimistic. We set a pendingDibsOps entry the instant
  // the user clicks so effectiveDibs flips immediately (claim → injects a
  // _pending synthetic row; release → hides my row). pollNow() flushes the
  // server truth within ~50ms and the finally block clears the pending
  // entry, so a server-rejected claim disappears on the next render.
  // AbortController guards rapid double-clicks; the DB unique partial index
  // on active target_id still resolves concurrent claims server-side.
  async function handleClaimDibs(memberId) {
    if (!user?.id) return
    setDibsError(null)
    setPendingDibsOps(prev => ({ ...prev, [memberId]: 'claim' }))

    if (dibsAbortRef.current) dibsAbortRef.current.abort()
    const controller = new AbortController()
    dibsAbortRef.current = controller

    try {
      await claimDibsV2(memberId, null)
      await pollNow()
    } catch (e) {
      if (e.name === 'AbortError') return
      setDibsError(e.message)
      setTimeout(() => setDibsError(null), 4000)
    } finally {
      if (dibsAbortRef.current === controller) dibsAbortRef.current = null
      setPendingDibsOps(prev => {
        if (prev[memberId] !== 'claim') return prev
        const next = { ...prev }; delete next[memberId]; return next
      })
    }
  }

  async function handleReleaseDibs(memberId) {
    if (!user?.id) return
    setDibsError(null)
    setPendingDibsOps(prev => ({ ...prev, [memberId]: 'release' }))
    try {
      await releaseDibsV2(memberId)
      await pollNow()
    } catch (e) {
      setDibsError(e.message)
      setTimeout(() => setDibsError(null), 4000)
    } finally {
      setPendingDibsOps(prev => {
        if (prev[memberId] !== 'release') return prev
        const next = { ...prev }; delete next[memberId]; return next
      })
    }
  }

  // ── Chain-save claim handlers ─────────────────────────────────────────────
  // Same shape as the dibs handlers — pollNow() flushes the DB delta within
  // ~50 ms so the UI reflects the claim immediately.
  async function handleClaimChainSave() {
    if (!user?.id) return
    setChainClaimError(null)
    try {
      await claimChainSaveV2()
      await pollNow()
    } catch (e) {
      setChainClaimError(e.message)
      setTimeout(() => setChainClaimError(null), 4000)
    }
  }

  async function handleReleaseChainSave() {
    if (!user?.id) return
    setChainClaimError(null)
    try {
      await releaseChainSaveV2()
      await pollNow()
    } catch (e) {
      setChainClaimError(e.message)
      setTimeout(() => setChainClaimError(null), 4000)
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
          // Two-tier farm sort (#108): green attack button (Online+Okay) on
          // top by battle stats, everyone else below in the prior ordering.
          // sortDir is intentionally ignored — farm has fixed semantics.
          const farmTarget = m => ({
            isGreen: m.last_action_status === 'Online' && m.status_state === 'Okay',
            okay: m.status_state === 'Okay',
            until: m.status_until,
            bsp: m.bsp_total,
            okayAt: okayAt.get(m.member_id) ?? -1,
          })
          return farmCompare(farmTarget(a), farmTarget(b))
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
    overdosed:    isOverdosed(m),
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

  // Activity-bucket counts for our faction. Phase 7e shape:
  //   { Online, Idle, Okay, OkayOnline }
  // - Online/Idle: last_action_status buckets (Offline dropped intentionally).
  // - Okay: strict "Okay AND in Torn" — both status_state and status_description = 'Okay'.
  // - OkayOnline: subset of Okay who are also Online (decision input for
  //   "how many of us could actually swing a chain hit right now").
  const mobileOurCounts = useMemo(() => {
    const c = { Online: 0, Idle: 0, Okay: 0, OkayOnline: 0 }
    for (const m of ourMembers) {
      if (m.last_action_status === 'Online') c.Online += 1
      else if (m.last_action_status === 'Idle') c.Idle += 1
      if (m.status_state === 'Okay' && m.status_description === 'Okay') {
        c.Okay += 1
        if (m.last_action_status === 'Online') c.OkayOnline += 1
      }
    }
    return c
  }, [ourMembers])

  // The dibs store uses snake_case from the DB (claimed_by / claimed_name);
  // MobileWarRoomView's MemberCard expects camelCase (claimedBy / claimedName).
  // Without this adapter every dib would read as "claimed by someone else,"
  // which both greys out the user's own Attack button and hides the claimer's name.
  // effectiveDibs = polled truth + in-flight optimistic ops. Claims inject a
  // synthetic _pending row so the UI flips to "You" instantly; releases hide
  // the existing row. Polled truth wins on conflict — if a claim is already
  // present in `dibs` for a target the user is trying to claim, we don't
  // override (someone else got there first; server will reject).
  const effectiveDibs = useMemo(() => {
    const ops = Object.keys(pendingDibsOps)
    if (ops.length === 0) return dibs
    const out = { ...dibs }
    for (const memberId of ops) {
      const op = pendingDibsOps[memberId]
      if (op === 'claim' && !out[memberId]) {
        out[memberId] = {
          target_id: Number(memberId),
          claimed_by: user?.id,
          claimed_name: user?.name,
          _pending: true,
        }
      } else if (op === 'release' && out[memberId] && String(out[memberId].claimed_by) === String(user?.id)) {
        delete out[memberId]
      } else if (op === 'claim' && out[memberId] && String(out[memberId].claimed_by) === String(user?.id)) {
        // Re-claim of an already-mine dib (rare; keep the spinner visible).
        out[memberId] = { ...out[memberId], _pending: true }
      }
    }
    return out
  }, [dibs, pendingDibsOps, user?.id, user?.name])

  const mobileDibs = useMemo(() => {
    const out = {}
    for (const [targetId, d] of Object.entries(effectiveDibs)) {
      out[targetId] = {
        ...d,
        claimedBy: d.claimed_by,
        claimedName: d.claimed_name,
        _pendingOp: d._pending ? 'claim' : undefined,
      }
    }
    // Re-inject pending releases — effectiveDibs hides them so the desktop
    // can render a standalone "Releasing…" stub, but mobile keeps the row
    // visible so the dib button itself flips to "Releasing…" + spinner.
    for (const [memberId, op] of Object.entries(pendingDibsOps)) {
      if (op !== 'release' || out[memberId]) continue
      const prev = dibs[memberId]
      if (!prev) continue
      out[memberId] = {
        ...prev,
        claimedBy: prev.claimed_by,
        claimedName: prev.claimed_name,
        _pending: true,
        _pendingOp: 'release',
      }
    }
    return out
  }, [effectiveDibs, dibs, pendingDibsOps])

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
                  it when needed. Only rendered to leadership. Visitors see
                  the leadership layout but the config panel is pure writes,
                  so it stays hidden for them. */}
              {isLeadership && !isVisitor && (
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
              {/* War Notes panel toggle — War Leaders + leadership/admin
                  (never visitors). Sits beside the settings gear. */}
              {canSeeNotes && (
                <button
                  onClick={() => setNotesPanelOpen(v => !v)}
                  title={notesPanelOpen ? 'Hide war notes' : 'Show war notes & roll-call results'}
                  aria-expanded={notesPanelOpen}
                  aria-label="Toggle war notes"
                  className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-colors ${
                    notesPanelOpen
                      ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'
                      : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400'
                  }`}
                >
                  <ClipboardList className="w-4 h-4" />
                </button>
              )}
              {/* Mobile launcher — always visible, regardless of viewport.
                  Opens the dedicated mobile-optimised War Room overlay. */}
              <button
                data-tour="mobile"
                onClick={() => setMobileOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
              >
                <Smartphone className="w-4 h-4" />
                Mobile App
              </button>
              {/* Roll Call — shown once a war exists so members can review/edit
                  their response even after the gate has auto-released.
                  Hidden from visitors: submitting would write a roll-call row
                  for a non-member. */}
              {currentWar && !isVisitor && (
                <button
                  data-tour="rollcall"
                  onClick={() => { setRollCallOpen(true) }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    myRollCall
                      ? 'border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300 hover:border-blue-400'
                      : 'bg-amber-500 hover:bg-amber-600 text-white'
                  }`}
                  title={myRollCall ? 'Review or edit your roll-call response' : 'Fill out your war roll call'}
                >
                  <ClipboardList className="w-4 h-4" />
                  Roll Call{myRollCall ? '' : ' !'}
                </button>
              )}
              {/* Personal alerts (#156/#157) — any member, saved per-browser.
                  Controlled so the first-run tour can open it on the alerts step. */}
              <span data-tour="alerts" className="inline-flex">
                <AlertSettingsButton
                  prefs={alertPrefs}
                  setPrefs={setAlertPrefs}
                  open={alertsOpen}
                  onOpenChange={setAlertsOpen}
                  lockOpen={tourStep?.id === 'alerts'}
                />
              </span>
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

          {/* Header right column — the "?" help sits top-right (#197 layout);
              status/error messages below. Leadership actions live in
              ConfigPanel below with the rest of the admin controls. */}
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {/* Contextual help (#153) — the "?" reference panel, everyone. */}
            <button
              data-tour="help"
              onClick={() => setHelpOpen(true)}
              title="How the War Room works"
              aria-label="War Room help"
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
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

        {isLeadership && !isVisitor && leadershipPanelOpen && (
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

        {/* War Notes & Roll Call results — War Leaders + leadership/admin. */}
        {canSeeNotes && notesPanelOpen && (
          <WarNotesPanel
            currentWar={currentWar}
            notes={warNotes}
            privateNotes={privateNotes}
            onSave={handleSaveWarNotes}
            saving={savingNotes}
            saveError={notesError}
            rollCallRows={rollCallRows}
            ourMembers={ourMembers}
            readOnly={isVisitor}
          />
        )}

        {/* This week's war summary — lives in the top card with the controls. */}
        {currentWar && (
          <WarSummaryCard
            currentWar={currentWar}
            notes={warNotes}
            rollCallRows={rollCallRows}
            ourMembers={ourMembers}
            mine={myRollCall}
            embedded
          />
        )}
      </div>

      {/* Filters — their own card below the controls. */}
      {hasMembers && (
        <div data-tour="filters" className="card flex flex-col gap-2">
            {/* Leader headline composer (#197 layout) — post/clear the headline
                from here; the banner itself renders above the roster. */}
            {(isWarLead || isLeadership || isAdmin) && !isVisitor && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Headline:</span>
                <HeadlineBanner config={config} canManage mode="composer" />
              </div>
            )}
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
            <div data-tour="farm" className="flex items-center gap-2 flex-wrap">
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

      {/* Paused notice — sits just above the chain/status bar so it reads with
          the (stale) timers it's warning about. */}
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
        const activeService = effectiveReviveServices(config).find(s => s.name === config?.revive_service_name)
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
          <div data-tour="chain">
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
            factionName={getFactionIdentity().name}
            chain={chain}
            onClaimChainSave={handleClaimChainSave}
            onReleaseChainSave={handleReleaseChainSave}
            chainClaimError={chainClaimError}
            isAdmin={isAdmin}
          />
          </div>
        )
      })()}

      {/* Leader headline banner (#158) — display sits between the status bar
          and roster (#197). The leader composer lives in the filters card. */}
      <HeadlineBanner config={config} mode="banner" canManage={(isWarLead || isLeadership || isAdmin) && !isVisitor} />

      {/* Push opt-in (#207): offer background notifications on entering a live
          war room (visitors are read-only observers). */}
      {!isVisitor && <WarRoomPushPrompt live={isActive} />}

      {/* Server-detected PUSH surge (#208) — auto-fires sound/flash for everyone. */}
      {surgeAlert && (
        <div className={`mb-3 rounded-lg px-4 py-3 flex items-center justify-between gap-3 shadow text-white ${
          surgeAlert.direction === 'enemy' ? 'bg-red-600' : 'bg-green-600'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <span className="font-bold text-base sm:text-lg truncate">{surgeAlert.title}</span>
            <span className="text-sm opacity-90 hidden sm:inline truncate">{surgeAlert.body}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Leader-only one-tap rally call (#209). Non-leaders never see it. */}
            {(isWarLead || isLeadership || isAdmin) && !isVisitor && PUSH_HEADLINE_PRESETS[surgeAlert.direction] && (
              surgeAlert.posted ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded bg-white/20">Headline posted ✓</span>
              ) : (
                <button onClick={postSurgeHeadline} disabled={postingHeadline}
                  title="Post the matching rally call to the headline banner for everyone"
                  className="text-xs font-semibold px-3 py-1.5 rounded bg-white/90 text-gray-900 hover:bg-white disabled:opacity-60">
                  {postingHeadline ? 'Posting…' : 'Post rally call'}
                </button>
              )
            )}
            <button onClick={() => setSurgeAlert(null)} aria-label="Dismiss" className="p-1 rounded hover:bg-black/20">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Member table — shown whenever members exist, or when active (so "waiting…" shows) */}
      {(hasMembers || isActive) ? (
        <div data-tour="roster" className="card p-0 overflow-hidden">

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
                    const dib = effectiveDibs[m.member_id]
                    const isMyDib = dib && String(dib.claimed_by) === String(user?.id)
                    const isPendingRelease = pendingDibsOps[m.member_id] === 'release'
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
                            {isOverdosed(m) && (
                              <span title="Overdosed" className="px-1 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300 text-[10px] font-semibold">OD</span>
                            )}
                            <MemberNoteButton
                              memberId={m.member_id}
                              memberName={m.member_name}
                              note={memberNotes[m.member_id]}
                              canEdit={canEditNotes}
                              onSave={saveMemberNote}
                            />
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

                        {/* Dibs — optimistic: clicking flips the cell instantly
                            via effectiveDibs; the Loader2 spinner signals the
                            server hasn't confirmed yet. Releases also show a
                            pending state by rendering a disabled "Releasing…"
                            stub until polling clears the row entirely. */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {dib ? (
                            <div className={`flex items-center gap-1.5 ${dib._pending ? 'opacity-70' : ''}`}>
                              <span className={`text-xs font-medium ${isMyDib ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                {isMyDib ? 'You' : dib.claimed_name}
                              </span>
                              {dib._pending && <Loader2 size={11} className="animate-spin text-blue-500 dark:text-blue-400" />}
                              {(isMyDib || isAdmin) && !dib._pending && (
                                <button onClick={() => handleReleaseDibs(m.member_id)}
                                  title={isMyDib ? 'Release your dibs' : 'Admin override: release this claim'}
                                  className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 underline">
                                  Release
                                </button>
                              )}
                            </div>
                          ) : isPendingRelease ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                              <Loader2 size={11} className="animate-spin" />
                              Releasing…
                            </span>
                          ) : (
                            <button onClick={() => handleClaimDibs(m.member_id)}
                              className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                              Dibs
                            </button>
                          )}
                        </td>

                        {/* Attack — 3 states (priority order):
                              1. Green Attack: target is Online AND Okay
                                 (overrides dibs — a fresh kill is everyone's
                                 to grab, can't lose the window to a claim).
                              2. Blue Assist <name>: someone else holds dibs
                                 AND the target isn't a fresh-kill window.
                              3. Red Attack: default — Idle / Offline /
                                 hospitalised, no contesting dib.            */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {(() => {
                            const isOnlineOkay = m.last_action_status === 'Online' && m.status_state === 'Okay'
                            const showAssist   = !isOnlineOkay && dib && !isMyDib
                            const colorClass   = isOnlineOkay
                              ? 'bg-green-600 hover:bg-green-700'
                              : showAssist
                                ? 'bg-blue-600 hover:bg-blue-700'
                                : 'bg-red-600 hover:bg-red-700'
                            const label = showAssist ? `⚔ Assist ${dib.claimed_name}` : '⚔ Attack'
                            const title = showAssist ? `${dib.claimed_name} called dibs — click to assist` : undefined
                            // #157: while the chain is about to drop, ring the
                            // buttons of hittable (Okay) targets red so it's
                            // obvious where to click to save it.
                            const chainCue = chainAlerting && m.status_state === 'Okay'
                              ? ' ring-2 ring-red-500 ring-offset-1 ring-offset-white dark:ring-offset-slate-800 animate-pulse'
                              : ''
                            return (
                              <a href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.member_id}`}
                                target="_blank" rel="noopener noreferrer"
                                title={title}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-white rounded text-xs font-medium transition-colors ${colorClass}${chainCue}`}>
                                {label}
                              </a>
                            )
                          })()}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer (#197 layout): members (left) · last updated (center) ·
              refresh rates (right). */}
          <div className="px-4 py-2.5 border-t border-gray-200 dark:border-slate-700 grid grid-cols-3 items-center text-xs text-gray-400 dark:text-gray-600">
            <span className="justify-self-start">Showing {filtered.length} of {members.length} members</span>
            <span className="justify-self-center">
              {isActive && lastFetched && !pollError
                ? `Updated ${Math.round((Date.now() - lastFetched) / 1000)}s ago`
                : ''}
            </span>
            <span className="justify-self-end text-right">
              {isActive
                ? `Enemy: every ${pollIntervalSec}s · Ours: every 30s · Timers: every 1s`
                : 'Static snapshot · Enable to refresh'}
            </span>
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
              headlineConfig={config}
              canManageHeadline={(isWarLead || isLeadership || isAdmin) && !isVisitor}
              memberNotes={memberNotes}
              canEditNotes={canEditNotes}
              onSaveNote={saveMemberNote}
              factionId={String(config?.faction_id ?? '')}
              factionName={factionName ?? config?.faction_name}
              ourCounts={mobileOurCounts}
              isLeadership={isLeadership && !isVisitor}
              isActive={isActive}
              paused={!isActive}
              pollIntervalS={pollIntervalSec}
              onPollIntervalChange={(s) => setPollIntervalSec(Math.max(0.5, Number(s) || 0.5))}
              reviveServices={effectiveReviveServices(config)}
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
                const active = effectiveReviveServices(config).find(s => s.name === config?.revive_service_name)
                const myRow = ourMembers.find(m => String(m.member_id) === String(user?.id))
                return requestRevive(
                  {
                    url: config?.revive_service_url,
                    userID: Number(user?.id),
                    userName: user?.name,
                    factionName: getFactionIdentity().name,
                    source: active?.source ?? active?.name ?? 'War Room',
                    sourceKey: active?.sourceKey ?? 'source',
                    preset: active?.preset ?? 'json',
                    country: resolveCountryFromDescription(myRow?.status_description),
                  },
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

      {/* Contextual help panel (#153) — the "?" reference. Leader sections show
          for war leads / leadership / admin (never visitors). */}
      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        isLeader={(isWarLead || isLeadership || isAdmin) && !isVisitor}
        onReplayTour={replayTour}
      />

      {/* First-run spotlight tour (#153) — desktop pass. */}
      {tourActive && (
        <SpotlightTour
          steps={tourStepsFor('desktop')}
          onFinish={finishTour}
          onStepEnter={setTourStep}
        />
      )}

      {/* Roll-call overlay — hard gate when the member hasn't responded and
          we're >1h from kickoff; also opened manually (edit) via the button.
          Never shown to visitors — they aren't part of the roll call. */}
      {showRollCall && currentWar && !isVisitor && (
        <RollCallOverlay
          currentWar={currentWar}
          notes={warNotes}
          existing={myRollCall}
          editing={!!myRollCall}
          canBypass={canBypass}
          submitting={submittingRC}
          error={rcError}
          onSubmit={handleSubmitRollCall}
          onClose={() => {
            if (rollCallOpen) setRollCallOpen(false)  // manual edit → just close
            else {
              // Hard gate → leadership bypass. Persist per war (#167) so it
              // survives tab switches / re-mounts instead of re-gating.
              markRollCallDismissed(currentWar?.id)
              setRollCallDismissed(true)
            }
          }}
        />
      )}
    </div>
  )
}
