// War Room v2 — delta-polling architecture.
// At Phase 5 cutover this is the canonical War Room implementation. The
// "V2" suffix in filenames + exports is a vestige of side-by-side
// validation; renaming is deferred to a quiet follow-up commit.
import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
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
import LoadoutShieldIcon from '../components/warroom/LoadoutShieldIcon'
import { isOverdosed, canEditMemberNotes, notesByMember } from '../utils/memberNotes'
import {
  THEM, US, DEFAULT_ROSTER_SIDE,
  selectRosterMembers, rosterColumns, rosterColumnCount, isStatsFilterAvailable,
  canViewOurRoster, effectiveRosterSide, pollingState, effectiveSortCol, passesStatsFilter,
  passesFfFilter,
} from '../utils/warRoomRosterSide'
import {
  formatEnergy, energyHue, energyBand, formatCooldown, remainingCooldown,
  overdosedByDrugCooldown, statsAgeSeconds, hasStatsError, compareMemberStat, cooldownHue,
} from '../utils/warRoomMemberStats'
import { memberFlags, flagRank, reviveAudience, isOverdosedAnySource } from '../utils/warRoomFlags'
import InfoTooltip, { InfoDot, tipLines } from '../components/InfoTooltip'
import { travelEta, formatTravelEta } from '../utils/warRoomTravel'
import {
  SCORE_DECAY_SEC, bestCaseChance,
  indexRevivesByTarget, reviveChanceHue, formatReviveChance, modelError,
} from '../utils/reviveChance'
import { indexBattleStats, withBattleStats } from '../utils/warRoomBattleStats'

// Flag glyph tones (#339). The muted revive is the load-bearing one: it must
// read as a weaker claim than the green one at a glance, not just on hover.
const FLAG_TONE_CLASS = {
  good: 'text-emerald-600 dark:text-emerald-400',
  muted: 'opacity-40',
  bad: 'text-red-600 dark:text-red-400',
  info: '',
}
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
import HeadlineBanner, { surgeHeadlinePreset } from '../components/warroom/HeadlineBanner'
import WarRoomPushPrompt from '../components/warroom/WarRoomPushPrompt'
import { setWarHeadline } from '../utils/warRoomApiV2'
import { useWarRoomAlerts } from '../hooks/useWarRoomAlerts'
import { loadAlertPrefs, fireAlert, surgeAlertKind } from '../utils/warRoomAlerts'
import { rollCallGateActive, canSeeWarNotes, isRollCallDismissed, markRollCallDismissed,
  rollCallLabel, rollCallTitle, compareRollCall } from '../utils/rollCall'
import { isGreenTarget, splitFarmAbroad } from '../utils/warRoomFarmSort'
import { Smartphone, Settings, Crosshair, Loader2, ClipboardList, HelpCircle, AlertTriangle, X as XIcon, CloudFog, Droplet, LifeBuoy } from 'lucide-react'
import HelpPanel from '../components/warroom/HelpPanel'
import SpotlightTour from '../components/warroom/SpotlightTour'
import { tourStepsFor } from '../components/warroom/warRoomTourSteps'
import { isTourSeen, markTourSeen, resetTourSeen } from '../utils/warRoomTour'
import { parseStatInput, formatStats } from '../utils/statInput'
import BattleStatsCell from '../components/BattleStatsCell'
import {
  fairFight, formatFF, ffGradientPosition, scoreIsEstimated, targetBattleStats,
} from '../utils/fairFight'
import { clampCadence } from '../utils/warRoomCadence.js'
import { assistBadgeState } from '../utils/assistBadge.js'

// OUR_FACTION_ID and flattenMemberRow are owned by useWarRoomPoll in v2 —
// the hook flattens rows before exposing them. The view receives the flat
// shape and uses the bootstrap faction id (coerced to number inside the
// component) for the `us` filter.

const STATUS_FILTERS   = ['Okay', 'Hospital', 'Flying', 'Jail']
const ACTIVITY_FILTERS = ['Online', 'Idle', 'Offline']

/** assistBadgeState() hands back a Lucide icon NAME (it has no JSX of its own to render one). */
const ASSIST_ICONS = { 'cloud-fog': CloudFog, droplet: Droplet, 'life-buoy': LifeBuoy }

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

// Farm mode's Abroad section divider (#561) — dropped once, between the main
// table body and the trailing Abroad rows. Named export so it (and the
// section boundary that decides where it lands) is directly testable rather
// than only provable by eyeballing the roster.
export function AbroadSectionDivider({ colSpan }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-2 px-3 bg-amber-50 dark:bg-amber-900/20 border-y border-amber-200 dark:border-amber-800 text-xs font-semibold text-amber-800 dark:text-amber-300">
        <span aria-hidden="true">✈</span> Abroad — still needs travel time home, timers below don't mean "attackable soon"
      </td>
    </tr>
  )
}

// ── Countdown (ticks every 1s client-side) ────────────────────────────────────

// Human names for the travel methods, for the ETA tooltip.
const TRAVEL_METHOD_LABELS = {
  business: 'Business Class',
  wlt: 'WLT',
  airstrip: 'private airstrip',
  standard: 'standard flight',
}

/**
 * Estimated arrival for a traveller (#330).
 *
 * Rendered deliberately UNLIKE the exact countdown beside it — italic, muted,
 * always `~` prefixed — because it is inferred, not reported. Torn gives no
 * arrival time for travel, so this is derived from the observed departure, the
 * destination, and the aircraft, and it carries up to 3% of Torn's own
 * variance on top. A lead must be able to tell at a glance which numbers in
 * this column are facts and which are estimates.
 */
function TravelEtaCell({ member }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const eta = travelEta({
    description: member.status_description,
    planeType: member.plane_image_type,
    departedAt: member.travel_departed_at,
    nowMs: now,
  })
  if (eta.state === 'unknown') {
    return (
      <InfoTooltip label="—" className="text-gray-300 dark:text-gray-700 text-xs">
        No arrival estimate — we did not see this member take off, so there is
        nothing to count from.
      </InfoTooltip>
    )
  }
  if (eta.state === 'overdue') {
    return (
      <InfoTooltip label="landing" className="text-xs font-mono italic text-blue-500 dark:text-blue-400">
        Past every expected landing time. Either they are about to land, or their
        flight was extended (a Detective Agency Watchlist can do that).
      </InfoTooltip>
    )
  }

  const label = TRAVEL_METHOD_LABELS[eta.methods[0]] ?? eta.methods[0]
  const title = eta.methods.length === 1
    ? `Estimated arrival — ${label}, ±3% flight-time variance`
    : `Estimated arrival — still could be ${eta.methods.map((m) => TRAVEL_METHOD_LABELS[m] ?? m).join(' / ')}`
  return (
    <InfoTooltip label={formatTravelEta(eta)} className="text-xs font-mono italic text-blue-600 dark:text-blue-400">
      {title}
    </InfoTooltip>
  )
}

function CountdownCell({ until, member }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  // Travel has no `until` from Torn (#330) — the estimate is derived instead.
  if (member && (member.status_state === 'Traveling') && !until) {
    return <TravelEtaCell member={member} />
  }
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
              aria-label={claimedByMe ? 'Release your claim' : 'Admin override: release claim'}
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
      // ⚠️ aria-label on a bare <span> is not exposed to a screen reader, so a
      // disabled quick link would have no name at all. The wrap gives it one and
      // makes it readable by tap as well.
      <InfoTooltip wrap label={
        <span
          className={`${base} border-gray-200 dark:border-slate-700 text-gray-300 dark:text-slate-600 cursor-not-allowed`}
          aria-disabled="true"
        >
          {children}
        </span>
      }>{title}</InfoTooltip>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={title}
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
      //   'json' (UHC/WTF) → POST /api/war-room/revive (server-to-server)
      //   'nuke'           → direct browser form POST (matches userscript's
      //                      residential-IP fingerprint to avoid Nuke's
      //                      datacenter-IP shadow-filter)
      preset: servicePreset || 'json',
      // Required by the Nuke direct-POST path — resolved by the parent from
      // our own war_room_state row. Ignored by the json path (the server
      // resolves country from its own state table).
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

  // The live states (sending / sent / the error text) are already on the
  // button's own face and in `aria-label`. Only "there is no service
  // configured" is a fact the button cannot show, and it is the disabled case —
  // which is exactly what a wrap can still make tappable.
  return (
    <InfoTooltip wrap label={
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        aria-label={title}
        className={`${base} ${stateClasses}`}
      >
        {busy ? (
          <span className="block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <RevivesIcon className="w-5 h-5" />
        )}
      </button>
    }>
      {disabled ? title : null}
    </InfoTooltip>
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
        aria-label="Find Target"
        className={`${base} border-gray-200 dark:border-slate-700 text-gray-600 dark:text-gray-300 hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20`}
      >
        <Crosshair className="w-5 h-5" />
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(o => !o)}
        aria-label="Find Target settings"
        className="inline-flex items-center justify-center w-5 h-9 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
      >
        <Settings className="w-3 h-3" />
      </button>
      <InfoDot label="About Find Target" size={12}>
        Opens a random attack page in the ID range {minId}–{maxId}. Use it when
        the chain timer is critical and you
        cannot waste a second picking a target. The gear adjusts the range, which
        is stored per-user in this browser.
      </InfoDot>
      {/* z-30, not z-20: the sticky table header is z-20 (#331), and an equal
          z-index falls back to DOM order — the header comes later in the DOM,
          so it won and this popover opened underneath it. */}
      {settingsOpen && (
        <div className="absolute top-full right-0 mt-1 z-30 p-3 rounded-lg shadow-lg bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 w-64 space-y-2">
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
            Defaults: {FT_DEFAULT_MIN}–{FT_DEFAULT_MAX}. Saved per-user.
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

// A sticky <th> is a POSITIONED element, so it paints in the positioned layer —
// but with `z-index: auto` that layer is ordered by DOM position, and <tbody>
// comes after <thead>. Every positioned thing in a row (the note button's
// `relative` wrapper, the stat cell, the tooltips) therefore painted straight
// over the header as it scrolled underneath (#331). z-20 lifts the header above
// row content while staying below the z-30/z-40 popovers, which open downward
// and are meant to cover it.
// ── Our-roster live stats cells (#336) ───────────────────────────────────────
// Both cells distinguish three states that must never look alike: no reading
// yet (—), a reading of zero (Ready / 0), and a member whose own key failed
// (— with the error in the tooltip). A war lead planning around "Ready" that
// actually meant "we couldn't ask" would be planning around a fiction.

function MemberEnergyCell({ stats }) {
  const label = formatEnergy(stats)
  const hue = energyHue(stats)
  const band = energyBand(stats)
  const age = statsAgeSeconds(stats)
  const errored = hasStatsError(stats)
  // Only what the header cannot say about THIS row: how stale the reading is,
  // and whose key failed. "Energy (stacked) — green is ready" in all 100 rows
  // was noise the column heading already covers.
  const title = errored
    ? `Key failed: ${stats.last_error}`
    : age == null
      ? 'No reading yet'
      : `As of ${age}s ago`

  // Grey, not red, when there is no reading (#351): colouring a member we
  // couldn't ask as "empty" would get them written off for a push.
  if (hue == null) {
    return (
      <InfoTooltip label={label} className="text-xs font-mono text-gray-300 dark:text-gray-700">
        {title}
      </InfoTooltip>
    )
  }
  return (
    <InfoTooltip
      label={<span style={{ '--grad-hue': hue }} className="hue-grad">{label}</span>}
      className={`text-xs font-mono ${band === 'stacked' ? 'font-semibold' : ''}`}
    >
      {title}
    </InfoTooltip>
  )
}

function MemberCooldownCell({ stats, field, label }) {
  // Aged against the clock: the stored value is seconds-remaining as of the
  // sweep, so it is already stale by the time it renders.
  const remaining = remainingCooldown(stats?.[field], stats?.fetched_at)
  const errored = hasStatsError(stats)
  const overdosed = field === 'cooldown_drug' && overdosedByDrugCooldown(stats)

  const age = statsAgeSeconds(stats)
  const title = errored
    ? `Key failed: ${stats.last_error}`
    : overdosed
      ? 'Over 10h — overdosed'
      : age == null
        ? 'No reading yet'
        : `As of ${age}s ago`

  // Overdose wins outright (#356): it already has its own red-and-bold
  // treatment from #351, and a gradient underneath would be a second way of
  // saying the same thing in a slightly different colour.
  if (overdosed) {
    return (
      <InfoTooltip
        label={<>{formatCooldown(remaining)}<span className="ml-1 not-italic" aria-label="overdosed">OD</span></>}
        className="text-xs font-mono text-red-600 dark:text-red-400 font-semibold"
      >
        {title}
      </InfoTooltip>
    )
  }

  // Coloured off the AGED value, the same number printed in the cell.
  const hue = cooldownHue(field, remaining)
  if (hue == null) {
    // Grey, never green: a member whose key failed must not read as "ready".
    return (
      <InfoTooltip label={formatCooldown(remaining)} className="text-xs font-mono text-gray-300 dark:text-gray-700">
        {title}
      </InfoTooltip>
    )
  }
  return (
    <InfoTooltip
      label={<span style={{ '--grad-hue': hue }} className="hue-grad">{formatCooldown(remaining)}</span>}
      className="text-xs font-mono"
    >
      {title}
    </InfoTooltip>
  )
}

/**
 * Best-case revive chance for one of our members (#358).
 *
 * `revives` is that member's last 48h of received revives; `loaded` separates
 * "nobody has revived them" (a genuine 100%) from "the history hasn't arrived
 * yet" (—). Collapsing those two would put a confident 100% on every row for
 * the first second of every page load, which is exactly the number a lead
 * would act on.
 */
function MemberReviveChanceCell({ revives, loaded }) {
  // Own clock, like CountdownCell — but at 30s, not 1s. The score decays a
  // single revive's 4 points over a full day, so a per-second tick would
  // re-render every row on our roster to move a rounded percentage roughly
  // never. Thirty seconds keeps it live without the cost.
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(id)
  }, [])

  if (!loaded) return <span className="text-xs font-mono text-gray-300 dark:text-gray-700">—</span>

  const chance = bestCaseChance(revives ?? [], nowSec)
  const hue = reviveChanceHue(chance)
  return (
    <span style={{ '--grad-hue': hue }} className="hue-grad text-xs font-mono">
      {formatReviveChance(chance)}
    </span>
  )
}

/**
 * Fair Fight for the viewer against one enemy (#422).
 *
 * Personal by construction: `mine` is the viewer's own battle stats, so this
 * cell reads differently for every person looking at the same board. That is
 * the point — FF is what YOU would earn, not a property of the target.
 *
 * The gradient runs red at 1.00 to green at 3.00, which is the full range FF
 * can occupy. Note it saturates once the target reaches 75% of your BS score,
 * so a large share of a healthy roster sits at a flat 3.00; the dotted
 * underline below carries the information the colour cannot.
 */
function FairFightCell({ mine, target }) {
  const targetStats = targetBattleStats(target)
  const ff = fairFight(mine, targetStats)

  if (ff === null) return <span className="text-xs text-gray-300 dark:text-gray-600">—</span>

  // An estimate on EITHER side makes the result an estimate. The even-split
  // assumption overstates lopsided builds, and on the target side that inflates
  // FF — so a number built on a bare total should not look as solid as one
  // built on a real spy.
  const estimated = scoreIsEstimated(mine) || scoreIsEstimated(targetStats)

  // 0 → red (0deg), 1 → green (120deg).
  const hue = Math.round(120 * ffGradientPosition(ff))
  // The dotted underline still means "estimate" — that mark is the one thing
  // the header cannot say about an individual row.
  return (
    <span
      style={{ '--grad-hue': hue }}
      className={`hue-grad text-xs font-mono ${estimated ? 'underline decoration-dotted decoration-from-font' : ''}`}
    >
      {formatFF(ff)}
    </span>
  )
}

/**
 * The roster table's header cell.
 *
 * ⚠️ **Deliberately NOT the shared `SortableTh` (#838).** Two reasons, and both
 * are about this table specifically:
 *
 * 1. The whole `<th>` is the click target, not a button around the label. In a
 *    war room people are clicking fast at small headers; shrinking the target
 *    to the text would be a real cost for a cosmetic gain.
 * 2. This table's comparator is NOT generic and should not become so. It ranks
 *    activity, roll-call and flags by meaning rather than value, sinks unknown
 *    FF and missing stat readings in both directions, falls back through
 *    status → activity → name for timers, and returns 0 for revive chance
 *    until the fetch lands so the prior order stands. Every one of those is a
 *    decision the shared comparator has no way to express.
 *
 * What it DID lack is accessibility: a click handler on a `<th>` is invisible
 * to a keyboard and announces nothing. That is fixed here rather than by
 * replacing the component.
 */
function SortTh({ col, sortCol, sortDir, onSort, children, className = '', title, frozen = false }) {
  const active = sortCol === col
  // ⚠️ The frozen corner cell emits ONE z-index class, not `z-20 z-30` and a
  // bet on which order Tailwind happens to write them out in. `frozen-col-head`
  // carries sticky/left/top/z-30 together (#841); the header's background is
  // already opaque, so it needs no compositing — unlike the body cells.
  const stick = frozen ? 'frozen-col-head' : 'sticky top-0 z-20'
  return (
    <th
      onClick={() => onSort(col)}
      // ⚠️ Keyboard parity for a cell that is not a button. Enter and Space
      // both sort, and Space must not also scroll the page.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(col) }
      }}
      tabIndex={0}
      role="columnheader"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`py-2.5 px-3 ${stick} bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors whitespace-nowrap ${className}`}
    >
      <span className="flex items-center gap-1">
        {children}
        {title && (
          // ⚠️ stopPropagation, not decoration: the whole <th> sorts on click,
          // so without it reading the column's explanation would also re-sort
          // the board out from under whoever was reading it.
          <span onClick={(e) => e.stopPropagation()} className="inline-flex">
            <InfoDot label={`About this column`}>{tipLines(title)}</InfoDot>
          </span>
        )}
        <span className={`text-xs ${active ? 'text-blue-500 dark:text-blue-400' : 'text-gray-300 dark:text-gray-600'}`}>
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    </th>
  )
}

// One push-surge detector's controls (#359). Both kinds — Status and Revives —
// have an identical shape: a toggle, a threshold, a window and a cooldown. The
// component exists so the two sections cannot drift apart in layout or
// behaviour, only in their copy and their bounds.
function SurgeSection({ label, hint, checked, onToggle, fields, setFields, onCommit, rows }) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input type="checkbox" checked={checked} onChange={onToggle}
          className="w-4 h-4 rounded border-gray-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">— {hint}</span>
      </label>
      {checked && fields && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2 pl-6">
          {rows.map(({ label: fieldLabel, field, min, max, fb, w, hint: fieldHint }) => (
            <div key={field}>
              <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {fieldLabel}
                {fieldHint && <InfoDot label={`About ${fieldLabel}`} size={11} className="ml-1">{fieldHint}</InfoDot>}
              </label>
              <input
                type="number" min={min} max={max} step={1}
                value={fields[field]}
                onChange={e => setFields(f => ({ ...f, [field]: e.target.value }))}
                onBlur={() => onCommit(field, min, max, fb)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className={`${w} px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500`}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Config panel (leadership only) ────────────────────────────────────────────

function ConfigPanel({
  config,
  isActive, toggling, onToggleEnabled,
  updatingSpies, onUpdateSpies,
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
  // Ours defaults to 5s (we care a lot), enemy 30s (intel only).
  //
  // ⚠️ 0 means OFF and must survive as 0. `Number(x) || 5` cannot express that
  // — 0 is falsy, so a deliberate "off" came back as the default and the field
  // silently reverted in front of the operator. All three cadences below had
  // the same bug. Server-side the range is non-contiguous: 0, or [floor, 600].
  const [chainOursSec,  setChainOursSec]  = useState(String(config?.chain_poll_interval_ours_sec  ?? 5))
  const [chainEnemySec, setChainEnemySec] = useState(String(config?.chain_poll_interval_enemy_sec ?? 30))
  useEffect(() => { setChainOursSec(String(config?.chain_poll_interval_ours_sec  ?? 5)) },  [config?.chain_poll_interval_ours_sec])
  useEffect(() => { setChainEnemySec(String(config?.chain_poll_interval_enemy_sec ?? 30)) }, [config?.chain_poll_interval_enemy_sec])
  async function commitChainOurs() {
    const next = clampCadence(chainOursSec, 5, 1)
    if (next === (config?.chain_poll_interval_ours_sec ?? 5)) return
    try { await onSaveReviveService({ chain_poll_interval_ours_sec: next });  setMsg({ ok: true, text: `Our chain poll set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  async function commitChainEnemy() {
    const next = clampCadence(chainEnemySec, 30, 1)
    if (next === (config?.chain_poll_interval_enemy_sec ?? 30)) return
    try { await onSaveReviveService({ chain_poll_interval_enemy_sec: next }); setMsg({ ok: true, text: `Enemy chain poll set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // Dibs auto-drop window (#159): a claim on an already-alive target releases
  // this many seconds later if the holder still hasn't killed them. Default
  // 30s; 0 turns auto-drop off, and a claim then stands until it is released
  // or the target is hospitalised. Otherwise [5, 600]s.
  const [dibsExpirySec, setDibsExpirySec] = useState(String(config?.dibs_expiry_seconds ?? 30))
  useEffect(() => { setDibsExpirySec(String(config?.dibs_expiry_seconds ?? 30)) }, [config?.dibs_expiry_seconds])
  async function commitDibsExpiry() {
    const next = clampCadence(dibsExpirySec, 30, 5)
    if (next === (config?.dibs_expiry_seconds ?? 30)) return
    try { await onSaveReviveService({ dibs_expiry_seconds: next }); setMsg({ ok: true, text: `Dibs auto-drop set to ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // Assist request window (#591): how long a raised hand for smoke/tear/help
  // stays up. Default 300s — a Torn fight runs to five minutes, and the old
  // hardcoded 120s meant a max-length fight outlived its own request. Kept
  // separate from the dibs window above on purpose: that one measures how long
  // a CLAIM survives after a target surfaces, and sharing a value would keep
  // claims blocking other claimers for five minutes.
  const [assistExpirySec, setAssistExpirySec] = useState(String(config?.assist_expiry_seconds ?? 300))
  useEffect(() => { setAssistExpirySec(String(config?.assist_expiry_seconds ?? 300)) }, [config?.assist_expiry_seconds])
  async function commitAssistExpiry() {
    const next = clampCadence(assistExpirySec, 300, 5)
    if (next === (config?.assist_expiry_seconds ?? 300)) return
    try { await onSaveReviveService({ assist_expiry_seconds: next }); setMsg({ ok: true, text: `Assist requests expire after ${next}s.` }) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // Roster refresh cadence (#339). Stored in MILLISECONDS but edited in
  // seconds, because sub-second is the whole point: leads push this to 0.5s
  // (2 Hz) during a live chain and pull it back to several seconds for a
  // termed war so a 1 Hz sweep of both rosters stops burning Torn calls.
  // Unlike the old "UI Refresh" slider this is a SERVER setting, so it really
  // does change how often we call Torn — and it applies on the next tick.
  const [rosterSec, setRosterSec] = useState(
    String((config?.roster_poll_interval_ms ?? 1000) / 1000)
  )
  useEffect(() => {
    setRosterSec(String((config?.roster_poll_interval_ms ?? 1000) / 1000))
  }, [config?.roster_poll_interval_ms])
  async function commitRosterSec() {
    const asMs = Math.round(Number(rosterSec) * 1000)
    // Mirror the server's zero-or-floor rule: 0 (or below) is off, anything
    // positive is raised to the 500ms floor rather than silently discarded.
    const next = !Number.isFinite(asMs) || asMs <= 0 ? 0 : Math.min(60_000, Math.max(500, asMs))
    if (next === (config?.roster_poll_interval_ms ?? 1000)) return
    try {
      await onSaveReviveService({ roster_poll_interval_ms: next })
      setMsg({
        ok: true,
        text: next === 0
          ? 'Roster polling disabled — no roster calls to Torn.'
          : `Roster refresh set to ${next / 1000}s (${(1000 / next).toFixed(1)} Hz).`,
      })
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // Our-members live stats sweep (#336): how often the server walks every
  // enrolled member's own key for energy + cooldowns. 0 = off; anything else
  // floors at 30s, because this costs ONE Torn call per member per cycle.
  // Server clamps identically (CONFIG_BOUNDS) — this is the typo guard.
  const [memberStatsSec, setMemberStatsSec] = useState(String(config?.member_stats_poll_interval_sec ?? 0))
  useEffect(() => {
    setMemberStatsSec(String(config?.member_stats_poll_interval_sec ?? 0))
  }, [config?.member_stats_poll_interval_sec])
  async function commitMemberStats() {
    const raw = Math.floor(Number(memberStatsSec) || 0)
    // Mirror the server's zero-or-floor rule: 0 stays off, anything positive
    // is raised to the 30s floor rather than being silently discarded.
    const next = raw <= 0 ? 0 : Math.min(600, Math.max(30, raw))
    if (next === (config?.member_stats_poll_interval_sec ?? 0)) return
    try {
      await onSaveReviveService({ member_stats_poll_interval_sec: next })
      setMsg({
        ok: true,
        text: next === 0
          ? 'Member stats polling disabled — no per-member Torn calls.'
          : `Member stats polling set to ${next}s (one call per member per cycle).`,
      })
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  // PUSH-surge alerts (#208): a global on/off plus per-direction rate thresholds
  // (N members Okay within M sec) and a cooldown. Off = a termed war stays
  // silent. Same commit-on-blur pattern as the cadences above; the toggle saves
  // immediately. All clamped server-side too via the config allowlist.
  //
  // Two independent detectors (#359), each with its own toggle and rates:
  // hospital churn is constant during a chain while enabling revives is
  // deliberate and rare, so one shared window would tune one of them wrong.
  const surgeEnabled = !!config?.surge_alerts_enabled
  const surgeReviveEnabled = !!config?.surge_revive_alerts_enabled
  const [surgeFields, setSurgeFields] = useState(null)
  useEffect(() => {
    setSurgeFields({
      surge_enemy_threshold:  String(config?.surge_enemy_threshold  ?? 3),
      surge_enemy_window_sec: String(config?.surge_enemy_window_sec ?? 60),
      surge_our_threshold:    String(config?.surge_our_threshold    ?? 4),
      surge_our_window_sec:   String(config?.surge_our_window_sec   ?? 60),
      surge_cooldown_sec:     String(config?.surge_cooldown_sec     ?? 300),
      surge_revive_enemy_threshold:  String(config?.surge_revive_enemy_threshold  ?? 3),
      surge_revive_enemy_window_sec: String(config?.surge_revive_enemy_window_sec ?? 300),
      surge_revive_cooldown_sec:     String(config?.surge_revive_cooldown_sec     ?? 600),
    })
  }, [config?.surge_enemy_threshold, config?.surge_enemy_window_sec, config?.surge_our_threshold, config?.surge_our_window_sec, config?.surge_cooldown_sec,
      config?.surge_revive_enemy_threshold, config?.surge_revive_enemy_window_sec, config?.surge_revive_cooldown_sec])
  async function toggleSurgeKind(column, current, label) {
    try {
      await onSaveReviveService({ [column]: !current })
      setMsg({ ok: true, text: `${label} alerts ${!current ? 'enabled' : 'disabled'}.` })
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
          <InfoTooltip wrap label={
          <button
            onClick={onToggleEnabled}
            disabled={toggling || !config?.faction_id}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          >
            <span className="w-2 h-2 rounded-full bg-white opacity-80" />
            {toggling ? 'Enabling…' : 'Enable War Room'}
          </button>
          }>{!config?.faction_id ? 'Set an opponent faction ID first.' : null}</InfoTooltip>
        )}
        <InfoTooltip wrap label={
        <button
          onClick={onUpdateSpies}
          disabled={updatingSpies || !config?.faction_id}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 text-purple-700 dark:text-purple-400 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {updatingSpies ? '⏳ Fetching…' : '🔍 Update Spies'}
        </button>
        }>{!config?.faction_id ? 'Set a faction ID first.' : 'Fetches members plus BSP battle stats.'}</InfoTooltip>
        {/* Roster Refresh (#339) — the control the old "UI Refresh" slider
            pretended to be. That one was client-side and inert since the
            API-mode collapse; this one is the server cadence, so turning it
            down genuinely cuts Torn calls. Floor 0.5s = 2 Hz. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Roster Refresh
            <InfoDot label="About Roster Refresh" size={11} className="ml-1">{'How often the server re-reads BOTH rosters from Torn (two calls per sweep). 0 stops roster polling entirely; otherwise 0.5s (2 Hz) is the hard floor, and a small key pool is held slower still. Takes effect on the next tick.'}</InfoDot>
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={rosterSec}
              onChange={e => setRosterSec(e.target.value)}
              onBlur={commitRosterSec}
              className="w-16 px-2 py-1.5 text-sm text-center border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400 dark:text-gray-500">
              {Number(rosterSec) > 0 ? 's' : 's (off)'}
            </span>
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
            <InfoDot label="About TornStats max spy age" size={11} className="ml-1">{'Upper bound on TornStats spy age. 0 = no age filter (always use TornStats spy if one exists). BSP only fills members TornStats has no spy for, or whose spy is older than this value.'}</InfoDot>
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
            className="w-24 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Chain poll cadences — server-side throttle for /v2/faction/{id}/chain. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Our chain poll <span className="text-gray-400 dark:text-gray-600">(s)</span>
            <InfoDot label="About Our chain poll" size={11} className="ml-1">{'How often the server polls our chain endpoint. Clamped to 1–600s. The cron forces an extra poll when the chain timer is within 6s of expiring regardless of this value.'}</InfoDot>
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
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Enemy chain poll <span className="text-gray-400 dark:text-gray-600">(s)</span>
            <InfoDot label="About Enemy chain poll" size={11} className="ml-1">{"How often the server polls the enemy faction's chain endpoint. Clamped to 1–600s. Pauses while enemy is in cooldown."}</InfoDot>
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
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {/* Member stats sweep (#336) — sits with the other server cadences.
            0 = off, and it is the only one here that can be switched off
            entirely: it is the only one whose cost scales with roster size
            (one Torn call per enrolled member per cycle). */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Member stats <span className="text-gray-400 dark:text-gray-600">(s, 0 = off)</span>
            <InfoDot label="About Member stats" size={11} className="ml-1">{"How often the server refreshes OUR members' energy and drug/medical/booster cooldowns, using each member's own key. One Torn call per enrolled member per cycle, so 0 disables it and the minimum when enabled is 30s. Only runs while the war room is enabled."}</InfoDot>
          </label>
          <input
            type="number"
            min={0}
            max={600}
            step={30}
            value={memberStatsSec}
            onChange={e => setMemberStatsSec(e.target.value)}
            onBlur={commitMemberStats}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="0"
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {/* Dibs auto-drop window (#159): free an unconverted claim on a live target. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Dibs auto-drop <span className="text-gray-400 dark:text-gray-600">(s)</span>
            <InfoDot label="About Dibs auto-drop" size={11} className="ml-1">{"If you dib an already-alive target and haven't killed them within this many seconds, your claim is released so someone else can take them. Only applies to alive targets — a hospital claim waits for them to come out. Clamped to 5–600s."}</InfoDot>
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
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {/* Assist request window (#591): a raised hand must outlive the fight. */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Assist window <span className="text-gray-400 dark:text-gray-600">(s)</span>
            <InfoDot label="About Assist window" size={11} className="ml-1">{'How long a smoke / tear / help request stays up before it expires on its own. A Torn fight runs to five minutes, so anything shorter can drop the request while the fight it is about is still going. Also cleared the moment the target stops being attackable. Clamped to 5–600s.'}</InfoDot>
          </label>
          <input
            type="number"
            min={5}
            max={600}
            step={1}
            value={assistExpirySec}
            onChange={e => setAssistExpirySec(e.target.value)}
            onBlur={commitAssistExpiry}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            placeholder="300"
            className="w-20 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* PUSH-surge alerts: two independent detectors (#208 status, #359 revives).
          Off means a termed war never pings anyone. */}
      <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-3">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Push-surge alerts</div>

        {/* Status — they are already back up and swinging. */}
        <SurgeSection
          label="Status"
          hint="a wave of enemy hospital exits — the push is already under way"
          checked={surgeEnabled}
          onToggle={() => toggleSurgeKind('surge_alerts_enabled', surgeEnabled, 'Status surge')}
          fields={surgeFields}
          setFields={setSurgeFields}
          onCommit={commitSurgeField}
          rows={[
            { label: 'Alert when ≥', field: 'surge_enemy_threshold', min: 1, max: 100, fb: 3, w: 'w-16', hint: 'Enemies leaving hospital within the window to trigger a "we\'re being pushed" alert.' },
            { label: 'within (s)', field: 'surge_enemy_window_sec', min: 5, max: 600, fb: 60, w: 'w-20', hint: 'Rolling window for the enemy hospital-exit count.' },
            { label: 'Cooldown (s)', field: 'surge_cooldown_sec', min: 30, max: 3600, fb: 300, w: 'w-24', hint: 'Quiet period after an alert so flicker can\u2019t re-spam.' },
          ]}
        />

        {/* Revives — the push being SET UP, before anyone is back on their feet. */}
        <SurgeSection
          label="Revives"
          hint="enemies switching revives on — a push is being set up"
          checked={surgeReviveEnabled}
          onToggle={() => toggleSurgeKind('surge_revive_alerts_enabled', surgeReviveEnabled, 'Revive surge')}
          fields={surgeFields}
          setFields={setSurgeFields}
          onCommit={commitSurgeField}
          rows={[
            { label: 'Alert when ≥', field: 'surge_revive_enemy_threshold', min: 1, max: 100, fb: 3, w: 'w-16', hint: 'Enemies turning revives on within the window. Nobody does this casually mid-war.' },
            { label: 'within (s)', field: 'surge_revive_enemy_window_sec', min: 5, max: 1800, fb: 300, w: 'w-20', hint: 'Rolling window. Longer than the status one by default: revive prep is deliberate and spread out.' },
            { label: 'Cooldown (s)', field: 'surge_revive_cooldown_sec', min: 30, max: 3600, fb: 600, w: 'w-24', hint: 'Quiet period after an alert. Longer than the status one — re-alerting on the same prep is noise.' },
          ]}
        />
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


  // ── v2 data layer ──
  // useWarRoomPoll owns config/members/ourMembers/dibs and refreshes via
  // war_room_*_v2_delta RPCs. The consumer-facing shape (arrays/objects) is
  // identical to v1's local state so the rest of this file is unchanged.
  // Per-tenant identity from bootstrap (#96) — resolved before views render.
  // Coerce to number to match the bigint faction_id column.
  const OUR_FACTION_ID = getFactionId()

  // Personal alert prefs (#156/#157, surge channel added in #361). Declared
  // here rather than lower down because onSurgeAlert depends on it, and a
  // useCallback dependency array is evaluated at definition time.
  const [alertPrefs, setAlertPrefs] = useState(loadAlertPrefs)

  // Server-detected PUSH surge (#208 status, #359 revives): a transient banner
  // plus sound/flash. The web-push to subscribers is sent server-side.
  //
  // Leadership's surge toggles are the master switch — with them off the server
  // emits nothing and none of this runs. What changed in #361 is that the
  // sound/flash used to be hardcoded on and consulted no preference at all, so
  // a member who wanted quiet had no control that could deliver it. The BANNER
  // still shows regardless: silencing a ping is not the same as hiding the
  // warning, and the war-wide notice is the point.
  const [surgeAlert, setSurgeAlert] = useState(null)
  const onSurgeAlert = useCallback((msg) => {
    if (msg?.kind !== 'surge') return
    const prefs = alertPrefs?.surge
    if (prefs?.enabled !== false) fireAlert(surgeAlertKind(msg.surge), prefs ?? { sound: true, flash: true })
    const shown = { ...msg, at: Date.now() }
    setSurgeAlert(shown)
    setTimeout(() => setSurgeAlert((cur) => (cur?.at === shown.at ? null : cur)), 12000)
  }, [alertPrefs])

  // #209: a leader can one-tap the matching rally-call preset onto the faction
  // headline. Nothing hits the banner until a leader confirms here (the surge
  // sound/flash/push in #208 already went to everyone).
  const [postingHeadline, setPostingHeadline] = useState(false)
  async function postSurgeHeadline() {
    const preset = surgeHeadlinePreset(surgeAlert?.surge, surgeAlert?.direction)
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
    assist,
    memberStats,
    loadout,
    config,
    chain,
    isInitialLoading: configLoading,
    lastTick: lastFetched,
    pollError,
    pollNow,
  } = useWarRoomSocket({
    // API mode rides the WebSocket (intervalMs applies only to the legacy
    // polling transport and the REST fallback); legacy builds poll as before.
    enabled: !!user,
    ourFactionId: OUR_FACTION_ID,
    onAlert: onSurgeAlert,
  })

  // Hide enemy members in federal jail, regular or permanent — the account is
  // held and unreachable for the foreseeable future, so they are not a chain
  // target. This is enemy-only on purpose: one of our own in fed is still a
  // faction member who comes back, and should stay on our roster.
  //
  // Fallen is NOT filtered here any more — it is dropped upstream in
  // useWarRoomSocket's publishState, for both factions at once, because it has
  // to apply to roll call and member stats too, not just this list.
  //
  // Either way the rows persist in war_room_state_v2 and the delta keeps
  // flowing, so a player leaving fed reappears on the next tick and audit
  // queries keep the original snapshot.
  const members = useMemo(
    () => rawMembers.filter(m => m.status_state !== 'Federal'),
    [rawMembers]
  )

  // Personal alerts (#156 dibs hospital-exit, #157 chain-watch). Per-user
  // prefs in localStorage; the hook fires sound/flash over the polled data and
  // reports when the chain is dropping so attack buttons can flag red.
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
  const [currentWar, setCurrentWar]   = useState(null)   // { id, opponentId, opponentName, startAt, endAt }
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

  // Which faction the roster table shows (#335). Deliberately NOT persisted:
  // finding the target list empty mid-war because the toggle was left flipped
  // in a previous session is a worse failure than re-clicking it.
  const [rosterSide, setRosterSide] = useState(DEFAULT_ROSTER_SIDE)

  // The viewer's OWN battle stats, for the personal FF column (#422).
  //
  // Fetched once on mount rather than joining the poll: a member's own stats
  // change on the timescale of a gym session, not a war-room tick, and putting
  // them in the 2 Hz roster poll would be a request per second for a value that
  // moves twice a week.
  const [myBattleStats, setMyBattleStats] = useState(null)
  useEffect(() => {
    let on = true
    apiGet('/api/members/me/battle-stats')
      .then(r => { if (on) setMyBattleStats(r?.battle_stats ?? null) })
      .catch(() => { if (on) setMyBattleStats(null) })
    return () => { on = false }
  }, [])

  // Stats filter
  const [ffMaxOnly, setFfMaxOnly] = useState(() => persistedState.ffMaxOnly ?? false)
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
      ffMaxOnly,
      sortCol,
      sortDir,
      leadershipPanelOpen,
      notesPanelOpen,
    })
  }, [statusFilter, activityFilter, statsFilterEnabled, statsFilterMin, statsFilterMax, ffMaxOnly, sortCol, sortDir, leadershipPanelOpen, notesPanelOpen, setPersistedState])

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
        // endAt feeds pollingState (#342) — without it the board cannot tell
        // "war finished, server stopped" from "still live".
        setCurrentWar({ id: data.id, opponentId: data.opponent_id, opponentName: data.opponent_name, startAt: data.start_at, endAt: data.end_at })
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

  // The roster the table renders, and which optional columns come with it.
  // Resolve the side through the permission check on EVERY render (#336): a
  // viewer can lose the war-lead role while the board is open (roles are
  // re-read on session refresh), and must fall straight back to the enemy
  // roster rather than sitting on one they may no longer see.
  const canSeeOurRoster = canViewOurRoster({ isWarLead, isLeadership, isAdmin, isVisitor })
  const effectiveSide = effectiveRosterSide(rosterSide, { isWarLead, isLeadership, isAdmin, isVisitor })

  // Our own members' battle stats (#353). Daily data, so it comes over the
  // lead-gated REST endpoint rather than the war room's delta channel — that
  // protocol is for per-second state. Refetched on a slow timer so a board left
  // open across the 02:45 UTC sweep doesn't sit on yesterday's figures.
  const [ourBattleStats, setOurBattleStats] = useState({})
  useEffect(() => {
    // The server refuses this to anyone who may not see our roster anyway; not
    // asking keeps a plain member's console free of a 403 every reload.
    if (!canSeeOurRoster) { setOurBattleStats({}); return undefined }
    let cancelled = false
    const load = () => apiGet('/api/members/battle-stats')
      .then(d => { if (!cancelled) setOurBattleStats(indexBattleStats(d?.battle_stats)) })
      .catch(() => { /* leave the column as "???" rather than blanking the board */ })
    load()
    const id = setInterval(load, 10 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [canSeeOurRoster])

  // Recent revives our members received (#358), for the revive-chance column.
  //
  // Only the EVENTS are fetched; the percentage is recomputed locally on every
  // render tick, because a target's score decays continuously — a number
  // computed server-side would be wrong before it finished rendering. Five
  // minutes is ample for the fetch: a new revive moves the figure by at most
  // four points, and the decay between polls is under a point.
  const [reviveHistory, setReviveHistory] = useState(null)   // null = not loaded
  useEffect(() => {
    if (!canSeeOurRoster) { setReviveHistory(null); return undefined }
    let cancelled = false
    const load = () => apiGet('/api/members/revive-history')
      .then(d => { if (!cancelled) setReviveHistory(d?.revives ?? []) })
      .catch(() => { /* leave the column as "—" rather than blanking the board */ })
    load()
    const id = setInterval(load, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [canSeeOurRoster])

  const revivesByTarget = useMemo(
    () => indexRevivesByTarget(reviveHistory ?? []),
    [reviveHistory]
  )

  // How far the chance model is from what Torn actually displayed.
  //
  // The formula interpolates between two published endpoints, and that
  // interpolation is inference. Every scraped revive carries the percentage
  // Torn really showed plus the reviver's skill, so it is checkable — and a
  // check nobody can see is a check nobody does. It rides in the column header
  // tooltip.
  //
  // Evaluated only on the last 24 hours, out of a 48-hour fetch: an
  // observation any older has had its own prior revives truncated away by the
  // window, which understates its score and shows up as bias we caused.
  const reviveModelCheck = useMemo(() => {
    if (!reviveHistory?.length) return null
    return modelError(reviveHistory, Math.floor(Date.now() / 1000) - SCORE_DECAY_SEC)
  }, [reviveHistory])

  const rawRosterMembers = selectRosterMembers(effectiveSide, { members, ourMembers })
  // Projected onto the bsp_* names the Stats cell, both sorts and the min/max
  // filter already read, so none of them needs an our-faction code path.
  const rosterMembers = useMemo(
    () => (effectiveSide === US ? withBattleStats(rawRosterMembers, ourBattleStats) : rawRosterMembers),
    [effectiveSide, rawRosterMembers, ourBattleStats]
  )
  const columns = rosterColumns(effectiveSide)
  // FF for one roster row, from the viewer's perspective. Shared by the sort,
  // the 3x filter and the cell so the three cannot disagree about a number.
  const ffFor = useCallback(
    (m) => fairFight(myBattleStats, targetBattleStats(m)),
    [myBattleStats]
  )
  // Only offerable when we can actually compute it — otherwise the button
  // would silently empty the board.
  const ffFilterUsable = columns.ff && myBattleStats != null
  const statsFilterUsable = isStatsFilterAvailable(effectiveSide, Object.keys(ourBattleStats).length)
  // Energy and the cooldowns only exist on our roster, and sortCol is
  // persisted — so a lead who sorts by energy, toggles back to the opponent
  // and reloads must not land on a sort over a column that isn't there (#351).
  const activeSortCol = effectiveSortCol(sortCol, effectiveSide)

  // Farm mode's Abroad section (#561): `filtered` stays a single flat array
  // (unchanged by every other sort column and every other consumer of
  // `filtered`), but in farm mode the Abroad rows are pushed to the tail and
  // `farmAbroadStart` records where that section begins so the table body
  // can drop a divider row there. Non-farm columns leave it null.
  // Roll-call answers by member (#793), shared by the sort comparator and the
  // column that renders them.
  //
  // ⚠️ A map, not a `find` per lookup. `sort` calls the comparator O(n log n)
  // times, and a linear scan inside it turns a 100-row roster into thousands of
  // passes over the response list on every re-render.
  const rollCallById = useMemo(
    () => new Map(rollCallRows.map(r => [String(r.member_id), r])),
    [rollCallRows],
  )

  const [filtered, farmAbroadStart] = useMemo(() => {
    // Update farm-mode transition tracker as a side effect of recomputing.
    // Cheap and safe — the refs are only read by the sort below.
    //
    // NOTE: this tracker always walks the ENEMY `members`, never the displayed
    // roster. Feeding it our own faction would pollute the just-released
    // timestamps keyed by member_id and corrupt farm ordering on the way back.
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

    let list = rosterMembers

    if (statusFilter.size > 0) {
      list = list.filter(m => statusFilter.has(stateToFilterKey(m.status_state, m.status_description)))
    }
    if (activityFilter.size > 0) {
      list = list.filter(m => activityFilter.has(m.last_action_status))
    }
    // Suspended on our own roster until we hold battle stats: spies are fetched
    // for the enemy only, so bsp_total would be null for everyone and an active
    // min/max would empty the table.
    // "3x FF" (#422): only targets that pay the full respect multiplier. Kept
    // separate from the min/max stats filter rather than folded into it — the
    // two express different intents ("in this weight class" vs "worth hitting")
    // and a lead routinely wants one without the other.
    //
    // In farm mode a green attack button survives it (#481), on the same rule
    // and the same condition as the stats filter below: someone online and out
    // of hospital is the enemy standing up, and a filter must not hide what a
    // lead has to react to.
    if (ffMaxOnly && ffFilterUsable) {
      list = list.filter((m) => passesFfFilter(ffFor(m), {
        enabled: true, farmMode: activeSortCol === 'farm', isGreen: isGreenTarget(m),
      }))
    }
    if (statsFilterEnabled && statsFilterUsable) {
      const minVal = parseStatInput(statsFilterMin)
      const maxVal = parseStatInput(statsFilterMax)
      // In farm mode a green attack button ALWAYS survives the stats filter
      // (#366). Those are the only people who can be hit this second, so if a
      // push starts they are what a lead needs to see — and a filter set for
      // farming would otherwise quietly remove exactly them. Outside farm mode
      // the filter is a deliberate targeting tool and is left alone.
      const farmMode = activeSortCol === 'farm'
      list = list.filter((m) => passesStatsFilter(m, {
        min: minVal, max: maxVal, farmMode, isGreen: isGreenTarget(m),
      }))
    }

    // Farm mode (#561): split off before the generic sort below, rather than
    // as one more `switch` case, because it changes `filtered`'s SHAPE (main
    // section + trailing Abroad section) rather than just its order. Two
    // sections can't be expressed as a single comparator — see
    // `splitFarmAbroad`'s own doc comment for why the Abroad section sorts
    // by stats instead of timer. sortDir is intentionally ignored, same as
    // farmCompare's existing fixed semantics.
    if (activeSortCol === 'farm') {
      const farmTarget = m => ({
        isGreen: isGreenTarget(m),
        okay: m.status_state === 'Okay',
        until: m.status_until,
        bsp: m.bsp_total,
        okayAt: okayAt.get(m.member_id) ?? -1,
      })
      const { main, abroad } = splitFarmAbroad(list, farmTarget)
      return [[...main, ...abroad], main.length]
    }

    // ⚠️ Built exactly as the cell builds it, from the same two inputs — so
    // what the column SHOWS and what it SORTS BY cannot drift apart. Computing
    // "is this member flying" a second way here is how a row ends up grouped
    // under a flag it is not displaying.
    const rollCallFor = (m) => rollCallById.get(String(m.member_id)) ?? null

    const flagsFor = (m) => memberFlags(m, {
      isFlying: stateToFilterKey(m.status_state, m.status_description) === 'Flying',
      stats: memberStats[String(m.member_id)],
    })

    const d = sortDir === 'asc' ? 1 : -1
    // `now` from the farm tracker above is reused deliberately (#351):
    // cooldowns are aged against it, and letting each comparison read its own
    // Date.now() would make the comparator non-transitive mid-sort.
    const sorted = list.slice().sort((a, b) => {
      switch (activeSortCol) {
        case 'name':
          return d * a.member_name.localeCompare(b.member_name)
        case 'activity': {
          const order = { Online: 0, Idle: 1, Offline: 2 }
          return d * ((order[a.last_action_status] ?? 3) - (order[b.last_action_status] ?? 3))
        }
        // #793 — group the roster by who actually said they are turning up.
        //
        // ⚠️ The ordering lives in rollCall.js and is shared with the results
        // table. Two orderings of the same seven states will drift, and the one
        // that drifts is the one nobody is looking at.
        case 'roll_call': {
          const cmp = compareRollCall(rollCallFor(a), rollCallFor(b), d)
          return cmp !== 0 ? cmp : a.member_name.localeCompare(b.member_name)
        }
        case 'status':
          return d * (a.status_state ?? '').localeCompare(b.status_state ?? '')
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
        // Group the roster by what is WRONG with somebody (#339 flags).
        //
        // ⚠️ Ranked by severity, not alphabetically — see FLAG_SORT_ORDER. A
        // member carries several flags at once, so this keys on their most
        // significant one: flying AND overdosed belongs with the overdosed.
        //
        // ⚠️ Unflagged members sink in BOTH directions, the same rule `ff`
        // follows. Reversing the sort should show the other end of the
        // interesting rows, not a screen of people with nothing wrong.
        case 'flags': {
          const ar = flagRank(flagsFor(a))
          const br = flagRank(flagsFor(b))
          if (ar === null && br === null) return a.member_name.localeCompare(b.member_name)
          if (ar === null) return 1
          if (br === null) return -1
          if (ar === br) return a.member_name.localeCompare(b.member_name)
          return d * (ar - br)
        }
        // #422. Nulls sink in BOTH directions (#351): a target we cannot
        // compute FF for is not "the worst" or "the best" one, it is unknown,
        // and parking it at either end of the order says something untrue.
        case 'ff': {
          const av = ffFor(a)
          const bv = ffFor(b)
          if (av === null && bv === null) return a.member_name.localeCompare(b.member_name)
          if (av === null) return 1
          if (bv === null) return -1
          return d * (av - bv)
        }
        // Our-roster live stats (#351). Members with no reading sink to the
        // bottom in both directions — see compareMemberStat.
        case 'energy':
        case 'cooldown_drug':
        case 'cooldown_medical':
        case 'cooldown_booster':
          return compareMemberStat(
            activeSortCol,
            memberStats[String(a.member_id)],
            memberStats[String(b.member_id)],
            d, now
          )
        // Revive chance (#358). Members with no history are a genuine 100%,
        // not an absence — but only once the fetch has landed; until then
        // every row compares equal and the prior order stands.
        case 'revive_chance': {
          if (!reviveHistory) return 0
          const nowSec = Math.floor(now / 1000)
          const chanceOf = (m) => bestCaseChance(revivesByTarget.get(Number(m.member_id)) ?? [], nowSec)
          return d * (chanceOf(a) - chanceOf(b))
        }
        default: return 0
      }
    })
    return [sorted, null]
  }, [members, rosterMembers, statusFilter, activityFilter, statsFilterEnabled, statsFilterUsable, statsFilterMin, statsFilterMax, ffMaxOnly, ffFilterUsable, ffFor, activeSortCol, sortDir, memberStats, reviveHistory, revivesByTarget, rollCallById])

  // ── Mobile War Room adapters ──────────────────────────────────────────────
  // Project the desktop's flat enemy `members` rows onto the prop shape that
  // MobileWarRoomView expects. Pure renaming — no transformation. The mobile
  // component is presentational; all polling/realtime stays in this parent.
  //
  // Deliberately stays on the ENEMY roster: the roster-side toggle (#335) is a
  // desktop control, and having the mobile overlay silently follow a switch it
  // cannot show would be worse than not following it. Wiring mobile up needs
  // its own toggle in that component — tracked on #335.
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
      // #339: inOc dropped — it never affected whether a member could be hit
      // or revived. reviveAudience distinguishes "anyone can revive" (a hired
      // reviver works) from "friends & faction only" (one cannot).
      reviveAnyone:   reviveAudience(m) === 'anyone',
      reviveFriends:  reviveAudience(m) === 'friends',
      earlyDischarge: !!m.has_early_discharge,
      overdosed:      isOverdosedAnySource(m, null),
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
  // What the board says it is doing. `enabled` is the ONLY gate on polling as
  // of #345; the one case still worth calling out is an enabled room whose
  // roster cadence has been set to 0.
  const polling = pollingState({
    enabled: isActive,
    rosterIntervalMs: config?.roster_poll_interval_ms,
  })
  const hasMembers = members.length > 0
  // Whether the SHOWN roster has anyone, and whether either does (#336).
  //
  // hasMembers is the ENEMY roster specifically, and several things below
  // rightly key off that. But the roster-side toggle and the table must not:
  // gating them on the enemy meant that with no opponent loaded — between
  // wars, or before Save & Fetch, which is exactly when you would want to
  // check your own members — the toggle did not render at all and the table
  // sat on "Waiting for first poll…" even though our own roster was loaded.
  const hasAnyMembers = members.length > 0 || ourMembers.length > 0
  const hasRosterMembers = rosterMembers.length > 0

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
              {polling.polling && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> LIVE
                </span>
              )}
              {polling.state === 'roster-paused' && (
                <InfoTooltip
                  decoration="no-underline"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-semibold"
                  label={<><span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> RUNNING — ROSTER PAUSED</>}
                >
                  The war room is running, but Roster Refresh is 0s so neither
                  roster is being polled. Set it above 0 to resume.
                </InfoTooltip>
              )}
              {polling.state === 'off' && isLeadership && (
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-gray-300 rounded-full text-xs font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400" /> STOPPED
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
                  aria-label={myRollCall ? 'Review or edit your roll-call response' : 'Fill out your war roll call'}
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
            enemyMembers={members}
            ourFactionId={OUR_FACTION_ID}
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

      {/* Filters — their own card below the controls. Keyed off EITHER roster
          (#336): this card holds the roster-side toggle, so gating it on the
          enemy hid the way to reach our own members precisely when no opponent
          was loaded. */}
      {hasAnyMembers && (
        <div data-tour="filters" className="card flex flex-col gap-2">
            {/* Leader headline composer (#197 layout) — post/clear the headline
                from here; the banner itself renders above the roster. */}
            {(isWarLead || isLeadership || isAdmin) && !isVisitor && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Headline:</span>
                <HeadlineBanner config={config} canManage mode="composer" />
              </div>
            )}
            {/* Roster side (#335) — swap the table between the opponent and our
                own faction. Both rosters already arrive on the same stream, so
                the switch itself is purely a view change: alerts and spy
                fetching keep tracking the enemy regardless of what is on
                screen. War leads only (#336), because our side carries live
                energy and drug cooldowns. The server enforces this too — the
                toggle disappearing is a courtesy, not the control. */}
            {canSeeOurRoster && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-0.5">Showing:</span>
              {[
                { side: THEM, label: resolvedName ?? 'Opponent' },
                // Our real faction name, to match how the opponent is labelled
                // — "Our faction" read as a generic control rather than a side.
                { side: US,   label: getFactionIdentity().name || 'Our faction' },
              ].map(({ side, label }) => (
                <button
                  key={side}
                  onClick={() => setRosterSide(side)}
                  aria-pressed={effectiveSide === side}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    effectiveSide === side
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
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
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  sortCol === 'farm'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                }`}
              >
                {sortCol === 'farm' ? 'Farm mode — ON' : 'Farm mode'}
              </button>
              <InfoDot label="About farm mode" size={12}>
                Tiered sort: Okay at top (just-released first), then hospital/jail
                by timer ascending. Click a column header to leave farm mode.
              </InfoDot>
              {sortCol === 'farm' && (
                <span className="text-[11px] text-gray-500 dark:text-gray-500">
                  Okay first (just-released at top), then timer ascending. Click a column to exit.
                </span>
              )}
            </div>

            {/* Stats filter — works on both sides since #353. Still suspended
                on our own roster until the daily battle-stats sweep has
                actually run: with every bsp_total null, a min/max carried over
                from the enemy side would silently empty the table. */}
            <div className={`flex items-center gap-2 flex-wrap ${statsFilterUsable ? '' : 'opacity-50'}`}>
              <span className="text-xs font-medium text-gray-400 dark:text-gray-500">Stats:</span>
              <button
                onClick={() => setStatsFilterEnabled(v => !v)}
                disabled={!statsFilterUsable}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  statsFilterEnabled && statsFilterUsable
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                } ${statsFilterUsable ? '' : 'cursor-not-allowed'}`}
              >
                {statsFilterEnabled && statsFilterUsable ? 'On' : 'Off'}
              </button>
              {!statsFilterUsable && (
                <span className="text-[11px] text-gray-500 dark:text-gray-500">
                  No battle stats for our members yet.
                </span>
              )}
              {columns.ff && (
                <InfoTooltip wrap label={
                <button
                  onClick={() => setFfMaxOnly(v => !v)}
                  disabled={!ffFilterUsable}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    ffMaxOnly && ffFilterUsable
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-600'
                  } ${ffFilterUsable ? '' : 'cursor-not-allowed opacity-50'}`}
                >
                  3x FF
                </button>
                }>
                  {ffFilterUsable ? (
                    <>
                      <div>Show only targets at the 3.00 fair-fight cap — full respect for you.</div>
                      <div className="mt-1.5">In farm mode anyone online and out of hospital stays visible regardless, so you can still see a push forming.</div>
                    </>
                  ) : 'No battle stats on record for you yet, so FF cannot be computed.'}
                </InfoTooltip>
              )}
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
          surgeAlert.direction !== 'enemy' ? 'bg-green-600'
            // Amber, not red, for an incoming revive surge (#359): nothing has
            // landed yet. Reserving red for "they are already hitting us" keeps
            // the two banners distinguishable at a glance mid-war.
            : surgeAlert.surge === 'revive' ? 'bg-amber-600'
            : 'bg-red-600'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <span className="font-bold text-base sm:text-lg truncate">{surgeAlert.title}</span>
            <span className="text-sm opacity-90 hidden sm:inline truncate">{surgeAlert.body}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Leader-only one-tap rally call (#209). Non-leaders never see it. */}
            {(isWarLead || isLeadership || isAdmin) && !isVisitor && surgeHeadlinePreset(surgeAlert.surge, surgeAlert.direction) && (
              surgeAlert.posted ? (
                <span className="text-xs font-semibold px-2.5 py-1 rounded bg-white/20">Headline posted ✓</span>
              ) : (
                <InfoTooltip wrap label={
                  <button onClick={postSurgeHeadline} disabled={postingHeadline}
                    className="text-xs font-semibold px-3 py-1.5 rounded bg-white/90 text-gray-900 hover:bg-white disabled:opacity-60">
                    {postingHeadline ? 'Posting…' : 'Post rally call'}
                  </button>
                }>Posts the matching rally call to the headline banner for everyone.</InfoTooltip>
              )
            )}
            <button onClick={() => setSurgeAlert(null)} aria-label="Dismiss" className="p-1 rounded hover:bg-black/20">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Member table — shown whenever either roster has members, or when
          active (so "waiting…" shows). The empty state follows the SHOWN side
          (#336), so switching to our faction with no opponent loaded renders
          our members instead of an enemy-flavoured "waiting" panel. */}
      {(hasAnyMembers || isActive) ? (
        <div data-tour="roster" className="card p-0 overflow-hidden">

          {!hasRosterMembers ? (
            <div className="flex items-center justify-center py-16 text-gray-400 dark:text-gray-600 text-sm">
              {effectiveSide === US
                ? 'No members loaded for our faction yet.'
                : 'Waiting for first poll…'}
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-separate border-spacing-0">
                <thead>
                  <tr className="text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    <SortTh col="name"     sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort} className="px-2" frozen>Name</SortTh>
                    {columns.rollCall && (
                      <SortTh col="roll_call" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}
                        title={
                          <>
                            <div>What this member said in the roll call for this war.</div>
                            <div className="mt-1.5">
                              <b>Here</b> — on at the start · <b>1-2</b> / <b>3-5</b> / <b>6+</b> — hours late ·
                              {' '}<b>Late</b> — late but did not say how long · <b>Unavailable</b> — not at all
                            </div>
                            <div className="mt-1.5">
                              <b>N/A</b> means no response, which sorts to the bottom in BOTH directions —
                              not answering is unknown, not "least available".
                            </div>
                          </>
                        }>Roll Call</SortTh>
                    )}
                    <SortTh col="activity" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Activity</SortTh>
                    <SortTh col="status"   sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Status</SortTh>
                    <SortTh col="timer"    sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Timer</SortTh>
                    <SortTh col="flags" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Flags</SortTh>
                    <SortTh col="stats"    sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort} className="text-right">Stats</SortTh>
                    {columns.ff && (
                      <SortTh
                        col="ff" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}
                        className="text-right"
                        title={
                          <>
                            <div>Fair Fight — the respect multiplier YOU would get hitting this target.</div>
                            <div className="mt-1.5 font-mono text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                              <div>FF = min(3, 1 + 8/3 × (their BS score / your BS score))</div>
                              <div>BS score = √str + √spd + √def + √dex</div>
                            </div>
                            <div className="mt-1.5">
                              It saturates at the 3.00 cap, so a lot of a healthy roster sits flat there.
                            </div>
                            <div className="mt-1.5">
                              A dotted underline on a value means it is an estimate: only a stat total was
                              known for one side, so an even split was assumed and the real FF may be lower.
                            </div>
                            <div className="mt-1.5">
                              This column is personal — computed from your own battle stats, so it reads
                              differently for every viewer.
                            </div>
                            {!myBattleStats && (
                              <div className="mt-1.5 text-amber-600 dark:text-amber-400">
                                No battle stats on record for you yet — the column cannot be computed.
                              </div>
                            )}
                          </>
                        }
                      >FF</SortTh>
                    )}
                    {/* Energy and the cooldowns sort like any other column (#351):
                        energy on the current value, cooldowns on the AGED
                        remaining one so the order matches the rendered numbers. */}
                    {columns.energy && (
                      <SortTh col="energy" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Energy</SortTh>
                    )}
                    {columns.drugCd && (
                      <SortTh col="cooldown_drug" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Drug CD</SortTh>
                    )}
                    {columns.medicalCd && (
                      <SortTh col="cooldown_medical" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Medical CD</SortTh>
                    )}
                    {columns.boosterCd && (
                      <SortTh col="cooldown_booster" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}>Booster CD</SortTh>
                    )}
                    {columns.reviveChance && (
                      <SortTh
                        col="revive_chance" sortCol={activeSortCol} sortDir={sortDir} onSort={handleSort}
                        title={
                          <>
                            <div>Best-case revive chance — what a skill-100 reviver would see.</div>
                            <div className="mt-1.5 font-mono text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                              chance = 90 + skill/10 − score × (8 − skill/25)
                            </div>
                            <div className="mt-1.5">
                              Computed from our own revive history (revives-sync). Torn does not report
                              this directly.
                            </div>
                            <div className="mt-1.5">
                              {reviveModelCheck
                            ? `History check vs what Torn displayed: ${reviveModelCheck.meanAbsError.toFixed(1)}pp mean error, ${reviveModelCheck.bias >= 0 ? '+' : ''}${reviveModelCheck.bias.toFixed(1)}pp bias over ${reviveModelCheck.samples} observed revive${reviveModelCheck.samples === 1 ? '' : 's'}. A positive bias means revives we never scraped — expected until the feed has run 24h.`
                            : 'History check: no observed revives to compare against yet.'}
                            </div>
                          </>
                        }
                      >Revive %</SortTh>
                    )}
                    {columns.dibs && (
                      <th className="py-2.5 px-3 sticky top-0 z-20 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Dibs</th>
                    )}
                    {columns.action && (
                      <th className="py-2.5 px-3 sticky top-0 z-20 bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">Action</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={rosterColumnCount(effectiveSide)} className="py-12 text-center text-gray-400 dark:text-gray-600 text-sm">
                        No members match the current filters.
                      </td>
                    </tr>
                  )}
                  {filtered.map((m, idx) => {
                    const dib = effectiveDibs[m.member_id]
                    const isMyDib = dib && String(dib.claimed_by) === String(user?.id)
                    const isPendingRelease = pendingDibsOps[m.member_id] === 'release'
                    // #523: a live "raise a hand" request against this target,
                    // if any — folded into the Dibs badge, not a second cell.
                    const activeAssist = assist[m.member_id]
                    const rowBg = idx % 2 === 0 ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/50 dark:bg-slate-800/40'
                    // ⚠️ The frozen Name cell paints in its own layer, so the
                    // row's stripe does not reach it — it has to restate it.
                    // `.frozen-col` supplies the opaque base that matches an
                    // EVEN row; odd rows add the translucent tint on top. See
                    // the compositing note in index.css (#841).
                    const frozenTint = idx % 2 === 0 ? '' : 'frozen-col-striped'

                    // Abroad section divider (#561): only inserted once, right
                    // before the first row of the trailing Abroad group that
                    // farm mode splits off (see `farmAbroadStart` above / the
                    // `filtered` memo). Everyone else — every other sort
                    // column, and farm mode with no abroad targets — never
                    // sees it.
                    const showAbroadDivider = farmAbroadStart != null && idx === farmAbroadStart

                    const row = (
                      // ⚠️ `group` is load-bearing, not styling sugar: it is
                      // what lets the frozen cell light up with its row, since
                      // it cannot inherit the row's hover background.
                      <tr key={m.member_id} className={`group ${rowBg} hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-colors`}>
                        {/* Name — narrower than the rest (#422): it was the
                            widest column by a distance and the FF column has to
                            come from somewhere. Truncates rather than wrapping,
                            so row height stays uniform down a 100-row board. */}
                        <td className={`py-2.5 px-2 whitespace-nowrap max-w-[13rem] frozen-col ${frozenTint}`}>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <a href={`https://www.torn.com/profiles.php?XID=${m.member_id}`}
                              target="_blank" rel="noopener noreferrer"
                              className="font-medium text-blue-600 dark:text-blue-400 hover:underline truncate">
                              {m.member_name}
                            </a>
                            <span className="text-xs text-gray-400 dark:text-gray-600">Lv{m.level}</span>
                            {isOverdosed(m) && (
                              <InfoTooltip
                                label="OD"
                                decoration="no-underline"
                                className="px-1 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300 text-[10px] font-semibold"
                              >Overdosed</InfoTooltip>
                            )}
                            <LoadoutShieldIcon loadoutRow={loadout[m.member_id]} />
                            <MemberNoteButton
                              memberId={m.member_id}
                              memberName={m.member_name}
                              note={memberNotes[m.member_id]}
                              canEdit={canEditNotes}
                              onSave={saveMemberNote}
                            />
                          </div>
                        </td>

                        {/* Roll Call (#793) — what this member said about
                            turning up, on the same row as their stats and
                            energy, so "who is actually here at opening, and how
                            big are they" stops being two pages and a memory. */}
                        {columns.rollCall && (() => {
                          const rc = rollCallById.get(String(m.member_id)) ?? null
                          const label = rollCallLabel(rc)
                          const tone = !rc
                            ? 'text-gray-400 dark:text-gray-500'
                            : rc.on_at_start
                              ? 'text-green-600 dark:text-green-400'
                              : rc.availability === 'unavailable'
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-amber-600 dark:text-amber-400'
                          return (
                            <td className="py-2.5 px-3 whitespace-nowrap">
                              {/* ⚠️ The full wording lives in the tooltip: "3-5"
                                  is meaningless to anybody who has not filled
                                  the survey in, and the column has to stay
                                  narrow enough not to push Stats off a phone. */}
                              <InfoTooltip decoration="no-underline" label={
                                <span className={`text-xs font-medium ${tone}`}>{label}</span>
                              }>{rollCallTitle(rc)}</InfoTooltip>
                            </td>
                          )
                        })()}

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
                          <CountdownCell until={m.status_until} member={m} />
                        </td>

                        {/* Flags (#339) — composed in warRoomFlags.js so the
                            revive nuance is tested rather than inlined. The
                            two revivable states share a glyph but not a
                            tooltip or tone: "Friends & faction" is revivable
                            in Torn's sense yet NOT by a reviver we can hire. */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {(() => {
                            const isFlying = stateToFilterKey(m.status_state, m.status_description) === 'Flying'
                            const flags = memberFlags(m, {
                              isFlying,
                              stats: memberStats[String(m.member_id)],
                            })
                            return (
                              <div className="flex items-center gap-1.5">
                                {/* Was a native `title`, which mobile browsers
                                    show on neither tap nor long press — so a
                                    flag's meaning was unreachable on a phone,
                                    which is where the War Room is most often
                                    read mid-war (#610). */}
                                {flags.map(f => (
                                  <InfoTooltip
                                    key={f.key}
                                    label={f.glyph}
                                    decoration="no-underline"
                                    className={`text-base leading-none ${FLAG_TONE_CLASS[f.tone] ?? ''}`}
                                  >
                                    {f.title}
                                  </InfoTooltip>
                                ))}
                                {flags.length === 0 && (
                                  <span className="text-gray-300 dark:text-gray-700 text-xs">—</span>
                                )}
                              </div>
                            )
                          })()}
                        </td>

                        {/* Stats — hover for str/dex/spd/def breakdown + source. */}
                        <td className="py-2.5 px-3 whitespace-nowrap text-right">
                          <BattleStatsCell member={m} />
                        </td>

                        {columns.ff && (
                          <td className="py-2.5 px-3 whitespace-nowrap text-right">
                            <FairFightCell mine={myBattleStats} target={m} />
                          </td>
                        )}

                        {/* Energy + cooldowns — our-roster only (#336), fetched
                            per-member with that member's own key because Torn
                            exposes bars/cooldowns as self-only selections.
                            Cooldowns are seconds-at-fetch-time, so every one is
                            aged against the clock rather than shown raw. */}
                        {columns.energy && (
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <MemberEnergyCell stats={memberStats[String(m.member_id)]} />
                          </td>
                        )}
                        {columns.drugCd && (
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <MemberCooldownCell
                              stats={memberStats[String(m.member_id)]}
                              field="cooldown_drug"
                              label="Drug"
                            />
                          </td>
                        )}
                        {columns.medicalCd && (
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <MemberCooldownCell
                              stats={memberStats[String(m.member_id)]}
                              field="cooldown_medical"
                              label="Medical"
                            />
                          </td>
                        )}
                        {columns.boosterCd && (
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <MemberCooldownCell
                              stats={memberStats[String(m.member_id)]}
                              field="cooldown_booster"
                              label="Booster"
                            />
                          </td>
                        )}
                        {columns.reviveChance && (
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <MemberReviveChanceCell
                              revives={revivesByTarget.get(Number(m.member_id))}
                              loaded={reviveHistory != null}
                            />
                          </td>
                        )}

                        {/* Dibs — optimistic: clicking flips the cell instantly
                            via effectiveDibs; the Loader2 spinner signals the
                            server hasn't confirmed yet. Releases also show a
                            pending state by rendering a disabled "Releasing…"
                            stub until polling clears the row entirely. */}
                        {columns.dibs && (
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          {isPendingRelease ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                              <Loader2 size={11} className="animate-spin" />
                              Releasing…
                            </span>
                          ) : (() => {
                            // ONE control, three-plus states (#509, #523) — the
                            // same shape the Torn userscript shows, from the
                            // same pure state→view-model function, so the two
                            // cannot drift. #523 folds an active assist request
                            // into this SAME badge (mode: 'assist') rather than
                            // a second indicator — see assistBadgeState's own
                            // doc comment for why.
                            const st = assistBadgeState(dib, activeAssist, m.member_id, user?.id, { isAdmin })

                            // The assist mode is a plain link straight to the
                            // fight, not a claim/release control.
                            if (st.mode === 'assist') {
                              const AssistIcon = ASSIST_ICONS[st.icon]
                              return (
                                <a
                                  href={st.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={st.title}
                                  className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border max-w-[9rem] transition-colors border-orange-400 text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-orange-900/40"
                                >
                                  {/* ⚠️ The icon replaced the LABEL, and the
                                      count went with it (#610). st.label is
                                      "Smoke ×3" when three are wanted, so
                                      swapping in the glyph left the number
                                      readable only on hover — on the board,
                                      the surface a lead scans to see who still
                                      needs help. The icon says WHICH, the count
                                      says HOW MANY; the row needs both. */}
                                  {AssistIcon ? <AssistIcon size={12} className="shrink-0" /> : <span className="truncate">{st.label}</span>}
                                  {st.wanted > 1 && (
                                    // Centred by LINE-HEIGHT against the icon's
                                    // own 12px box, not by `leading-none`. The
                                    // flex row centres each item's line box, but
                                    // a glyph does not sit centred within its
                                    // line box — the font's ascent and descent
                                    // are asymmetric — so 10px digits beside a
                                    // 12px icon still read high. Matching the
                                    // heights hands the decision to the font's
                                    // own metrics, which is what actually
                                    // decides where the glyph lands.
                                    <span className="text-[10px] font-bold tabular-nums h-3 leading-3">×{st.wanted}</span>
                                  )}
                                </a>
                              )
                            }

                            const tone = st.tone === 'mine'
                              ? 'border-blue-400 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20'
                              : st.tone === 'taken'
                                ? 'border-amber-400 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20'
                                : 'border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400'
                            const inert = st.action === 'none'
                            return (
                              <InfoTooltip wrap label={
                              <button
                                onClick={() => {
                                  if (st.action === 'claim') handleClaimDibs(m.member_id)
                                  else if (st.action === 'release') handleReleaseDibs(m.member_id)
                                }}
                                disabled={inert || dib?._pending}
                                className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border max-w-[9rem] transition-colors ${tone} ${
                                  inert ? 'cursor-default' : 'cursor-pointer'
                                } ${dib?._pending ? 'opacity-70' : ''}`}
                              >
                                <span className="truncate">{st.label}</span>
                                {dib?._pending && <Loader2 size={11} className="animate-spin shrink-0" />}
                              </button>
                              }>{st.title ?? (st.mine ? 'Click to release' : null)}</InfoTooltip>
                            )
                          })()}
                        </td>
                        )}

                        {/* Attack — 3 states (priority order):
                              1. Green Attack: target is Online AND Okay
                                 (overrides dibs — a fresh kill is everyone's
                                 to grab, can't lose the window to a claim).
                              2. Blue Assist <name>: someone else holds dibs
                                 AND the target isn't a fresh-kill window.
                              3. Red Attack: default — Idle / Offline /
                                 hospitalised, no contesting dib.            */}
                        {columns.action && (
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
                            // #157: while the chain is about to drop, ring the
                            // buttons of hittable (Okay) targets red so it's
                            // obvious where to click to save it.
                            const chainCue = chainAlerting && m.status_state === 'Okay'
                              ? ' ring-2 ring-red-500 ring-offset-1 ring-offset-white dark:ring-offset-slate-800 animate-pulse'
                              : ''
                            return (
                              <a href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.member_id}`}
                                target="_blank" rel="noopener noreferrer"
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-white rounded text-xs font-medium transition-colors ${colorClass}${chainCue}`}>
                                {label}
                              </a>
                            )
                          })()}
                        </td>
                        )}
                      </tr>
                    )

                    if (!showAbroadDivider) return row
                    return (
                      <Fragment key={`abroad-divider-${m.member_id}`}>
                        <AbroadSectionDivider colSpan={rosterColumnCount(effectiveSide)} />
                        {row}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer (#197 layout): members (left) · last updated (center) ·
              refresh rates (right).

              The rates shown are the REAL server-side cadences read from
              config, not a client setting (#336). They previously reported a
              dead client slider as the enemy rate and hardcoded "Ours: every
              30s" — so the two numbers a lead would check to confirm a cadence
              change had taken hold were the two that could not reflect it. */}
          <div className="px-4 py-2.5 border-t border-gray-200 dark:border-slate-700 grid grid-cols-3 items-center text-xs text-gray-400 dark:text-gray-600">
            <span className="justify-self-start">Showing {filtered.length} of {rosterMembers.length} members</span>
            <span className="justify-self-center">
              {polling.state === 'roster-paused'
                ? 'Last known state — roster refresh is off'
                : polling.polling && lastFetched && !pollError
                  ? `Updated ${Math.round((Date.now() - lastFetched) / 1000)}s ago`
                  : ''}
            </span>
            {/* Poll cadences used to be printed here (#342). They are
                diagnostic detail — every viewer had to read them, and only an
                admin can act on them, from War Room settings. The paused state
                still shows, because that changes how you read the timers. */}
            <span className="justify-self-end text-right">
              {isActive ? '' : 'Static snapshot · Enable to refresh'}
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
          presentational.

          ⚠️ Because this overlay is `fixed inset-0`, ANYTHING the desktop view
          renders is covered while it is open — which is how the surge banner
          came to be desktop-only without anyone deciding that (#479). Alerts
          that must reach a mobile user have to be passed in as props, not
          merely rendered above. */}
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
              myBattleStats={myBattleStats}
              surgeAlert={surgeAlert}
              onDismissSurge={() => setSurgeAlert(null)}
              canPostRally={
                (isWarLead || isLeadership || isAdmin) && !isVisitor
                && !!surgeAlert && !!surgeHeadlinePreset(surgeAlert.surge, surgeAlert.direction)
              }
              onPostRally={postSurgeHeadline}
              postingHeadline={postingHeadline}
              factionId={String(config?.faction_id ?? '')}
              factionName={factionName ?? config?.faction_name}
              ourCounts={mobileOurCounts}
              isLeadership={isLeadership && !isVisitor}
              isActive={isActive}
              paused={!isActive}
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
