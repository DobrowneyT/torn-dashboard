/**
 * Mobile War Room — drop-in module for src/views/MobileWarRoomView.jsx
 *
 * A one-handed mobile UI for the War Room. Designed to overlay the
 * desktop WarRoomView, NOT replace it: the launcher button in
 * WarRoomView is responsible for mounting/unmounting this component
 * on mobile viewports.
 *
 * --------------------------------------------------------------------
 *   PROPS
 * --------------------------------------------------------------------
 * members        Array of normalised war-room rows (shape below).
 * dibsByEnemyId  Object map of enemy_id → { claimedBy, claimedName }
 * currentUserId  String/number — the logged-in user's id (used to
 *                detect "your dib")
 * myBattleStats  Object|null — the VIEWER's own battle stats, used for the
 *                per-card Fair Fight badge. Null hides the badge entirely.
 * factionId      String — enemy faction id, shown in header
 * factionName    String — enemy faction name, shown in header
 * isLeadership   Boolean — gates leadership cog
 * isActive       Boolean — show LIVE pill (not paused)
 * paused         Boolean — show PAUSED pill + banner
 * onClaim(id)        Called when user taps Dibs
 * onRelease(id)      Called when user taps their own Dibs (release)
 * onTogglePaused()   Called from leadership sheet
 * onUpdateSpies()    Called from leadership sheet
 * onClose()      Called when the red X in the header is tapped (the
 *                parent should unmount this overlay and return the user
 *                to the desktop view)
 *
 *   Expected member shape:
 *     {
 *       id:            Number,        // Torn user id (enemy_id)
 *       name:          String,
 *       level:         Number,
 *       activity:      'Online'|'Idle'|'Offline',
 *       lastActionTs:  Number,        // seconds since epoch
 *       state:         'Okay'|'Hospital'|'Traveling'|'Abroad'|'Jail'|'Fallen',
 *       description:   String|null,   // Torn's raw status_description
 *       until:         Number|null,   // seconds since epoch, used for countdowns
 *       bsp:           Number|null,   // battle stats sum (battlescore proxy)
 *       flags: { reviveAudience, earlyDischarge, overdosed, onWall }
 *     }
 *
 * --------------------------------------------------------------------
 *   ICONS
 * --------------------------------------------------------------------
 * Uses lucide-react. If you haven't already:
 *     npm install lucide-react
 */

import { useState, useEffect, useMemo, useReducer, useRef, useCallback, Fragment } from 'react'
import { useViewState } from '../contexts/ViewStateContext'
import {
  Check, BriefcaseMedical, Plane, MapPin, Skull, Lock, Clock,
  Syringe, Zap, Shield, Hand, Plus, Swords, X, ChevronRight,
  ChevronDown, ChevronUp, ShieldCheck, AlertTriangle,
  Settings, Search, Pause, Play,
  SlidersHorizontal, ShoppingBag, HeartPulse, Loader2,
} from 'lucide-react'
import { isGreenTarget, splitFarmAbroad } from '../utils/warRoomFarmSort'
import { passesStatsFilter, passesFfFilter } from '../utils/warRoomRosterSide'
import { parseDbTime } from '../utils/time'
import SpotlightTour from '../components/warroom/SpotlightTour'
import { tourStepsFor } from '../components/warroom/warRoomTourSteps'
import { isTourSeen, markTourSeen } from '../utils/warRoomTour'
import HeadlineBanner from '../components/warroom/HeadlineBanner'
import MemberNoteButton from '../components/warroom/MemberNoteButton'
import InfoTooltip from '../components/InfoTooltip'
import { isOverdosed } from '../utils/memberNotes'
import { parseStatInput } from '../utils/statInput'
import {
  trueFairFight, formatFF, ffTrueHue, isMaxFF, scoreIsEstimated, targetBattleStats, FF_MAX,
} from '../utils/fairFight'
import { useDisplaySettings } from '../hooks/useDisplaySettings'

// ───────────────────────────────────────────────────────────────────
// Static config — status visuals, activity colours, flag icons
// ───────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  Okay:      { Icon: Check,              chipClass: 'bg-green-100 text-green-800' },
  Hospital:  { Icon: BriefcaseMedical,   chipClass: 'bg-red-100 text-red-800' },
  Traveling: { Icon: Plane,              chipClass: 'bg-blue-100 text-blue-800' },
  Abroad:    { Icon: MapPin,             chipClass: 'bg-orange-100 text-orange-800' },
  Fallen:    { Icon: Skull,              chipClass: 'bg-purple-100 text-purple-800' },
  Jail:      { Icon: Lock,               chipClass: 'bg-slate-200 text-slate-700' },
}
const ABROAD_HOSP_STYLE = { Icon: Plane, chipClass: 'bg-amber-100 text-amber-800' }

const ACTIVITY = {
  Online:  { dot: 'bg-green-500', text: 'text-green-700 dark:text-green-400', label: 'Online'  },
  Idle:    { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400', label: 'Idle'    },
  Offline: { dot: 'bg-gray-400',  text: 'text-gray-500  dark:text-gray-400',  label: 'Offline' },
}

// #339: "In OC" removed — it never bore on whether a member could be hit or
// revived. Revivable splits by audience: only the green one means a reviver we
// can HIRE will work; "Friends & faction" is revivable but not by us.
const FLAG_ICONS = [
  { key: 'reviveAnyone',   Icon: Syringe, label: 'Revivable by anyone',            color: 'text-emerald-600' },
  { key: 'reviveFriends',  Icon: Syringe, label: 'Revivable by their faction only', color: 'text-gray-400' },
  { key: 'earlyDischarge', Icon: Zap,     label: 'Early discharge',                color: 'text-yellow-600' },
  { key: 'overdosed',      Icon: Skull,   label: 'Overdosed',                      color: 'text-red-600' },
  { key: 'onWall',         Icon: Shield,  label: 'On wall',                        color: 'text-blue-600' },
]

// ───────────────────────────────────────────────────────────────────
// Helpers — formatters + state parsers
// ───────────────────────────────────────────────────────────────────

function formatStats(n) {
  if (n == null) return '???'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k'
  return String(n)
}

function formatCountdown(s) {
  if (s <= 0) return 'Releasing…'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function formatRelative(ts) {
  if (!ts) return '—'
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function parseTravel(state, description) {
  if (state === 'Traveling') {
    const m = description?.match(/^Traveling from (.+) to (.+)$/)
    if (m) {
      const [, from, to] = m
      return to === 'Torn'
        ? { returning: true,  label: `from ${from}` }
        : { returning: false, label: `to ${to}` }
    }
  }
  if (state === 'Abroad') return { returning: false, label: description?.replace(/^In /, '') || '' }
  return null
}

function parseAbroadHospital(state, description) {
  if (state !== 'Hospital' || !description) return null
  const m = description.match(/^(In (?:a|an) .*? hospital)\b/i)
  return m ? { label: m[1] } : null
}

function stateToFilterKey(state, description) {
  if (state === 'Traveling' || state === 'Abroad') return 'Flying'
  if (state === 'Hospital' && parseAbroadHospital(state, description)) return 'Flying'
  if (state === 'Fallen') return 'Fallen'
  return state
}

// ───────────────────────────────────────────────────────────────────
// Sub-components
// ───────────────────────────────────────────────────────────────────

function ActivityDot({ status, ts }) {
  const cfg = ACTIVITY[status] || ACTIVITY.Offline
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${status === 'Online' ? 'animate-pulse' : ''}`} />
      <span className="font-medium">{cfg.label}</span>
      {ts && <span className="font-normal text-gray-400 dark:text-gray-500">· {formatRelative(ts)}</span>}
    </span>
  )
}

function StatusChip({ state, description, size = 'md' }) {
  const abroadHosp = parseAbroadHospital(state, description)
  const cfg = abroadHosp ? ABROAD_HOSP_STYLE : (STATUS_STYLES[state] || STATUS_STYLES.Okay)
  const padding = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap ${cfg.chipClass} ${padding}`}>
      <cfg.Icon size={size === 'sm' ? 12 : 14} />
      {abroadHosp ? 'Abroad-hosp' : state}
    </span>
  )
}

function TimerPill({ until, urgentBelow = 300 }) {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => { if (!until) return; const id = setInterval(force, 1000); return () => clearInterval(id) }, [until])
  if (!until) return null
  const rem = until - Math.floor(Date.now() / 1000)
  const urgent = rem > 0 && rem < urgentBelow
  const releasing = rem <= 0
  const color = releasing ? 'text-orange-600' : urgent ? 'text-red-600' : 'text-gray-700 dark:text-gray-300'
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-sm font-semibold tabular-nums ${color} ${releasing ? 'animate-pulse' : ''}`}>
      <Clock size={13} />
      {formatCountdown(rem)}
    </span>
  )
}

function FlagPill({ Icon, color, title }) {
  return (
    <InfoTooltip
      label={<Icon size={12} aria-hidden="true" />}
      ariaLabel={title}
      decoration="no-underline"
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 dark:bg-slate-700 ${color}`}
    >
      {title}
    </InfoTooltip>
  )
}

function FlagsRow({ flags, state, description }) {
  const isFlying = stateToFilterKey(state, description) === 'Flying'
  const active = FLAG_ICONS.filter(f => flags?.[f.key])
  if (!active.length && !isFlying) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {isFlying && (
        <FlagPill Icon={Plane} color="bg-blue-100 text-blue-800" title="Flying" />
      )}
      {active.map(f => <FlagPill key={f.key} Icon={f.Icon} color={f.color} title={f.label} />)}
    </div>
  )
}

/**
 * Fair Fight for the viewer against this target (#422), sat beside the stats.
 *
 * Personal by construction — `mine` is the viewer's own battle stats, so the
 * same card reads differently for every person looking at it. On a phone that
 * matters more than on desktop: this surface is used mid-chain to pick who to
 * hit next, and the stat total alone doesn't say what the hit is worth.
 *
 * ⚠️ Two different absences, deliberately shown differently. No stats on record
 * for the VIEWER means FF cannot be computed for anybody, so the badge is
 * omitted entirely rather than stamping a dash on all forty cards. A dash means
 * this one target's stats are missing — a data gap worth seeing.
 */
function FairFightBadge({ mine, m }) {
  // #995: the TRUE (uncapped) FF, coloured red → green (3.00) → red again.
  const { ff_red_high: redHigh } = useDisplaySettings()
  if (!mine) return null
  const target = targetBattleStats(m)
  const ff = trueFairFight(mine, target)

  if (ff === null) {
    return (
      <InfoTooltip
        label={
          <span className="block text-right">
            <span className="block font-mono text-[15px] font-bold leading-none text-gray-400">—</span>
            <span className="block text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">FF</span>
          </span>
        }
        decoration="no-underline"
        className="shrink-0"
      >
        No battle stats for this target yet.
      </InfoTooltip>
    )
  }

  // An estimate on EITHER side makes the result an estimate, and the even-split
  // assumption inflates FF on the target side — so a number resting on a bare
  // BSP total must not look as solid as one from a real spy.
  const estimated = scoreIsEstimated(mine) || scoreIsEstimated(target)
  // Same double-ended scale as the desktop column.
  const hue = ffTrueHue(ff, redHigh)

  return (
    <InfoTooltip
      label={
        <span className="block text-right">
          <span
            style={{ '--grad-hue': hue }}
            className={`hue-grad block font-mono text-[15px] font-bold leading-none tabular-nums ${
              estimated ? 'underline decoration-dotted decoration-from-font' : ''
            }`}
          >
            {formatFF(ff)}
          </span>
          <span className="block text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">FF</span>
        </span>
      }
      // The dotted underline on the number means "estimate", so the component's
      // own affordance would be a second, conflicting meaning for the same mark.
      decoration="no-underline"
      className="shrink-0"
    >
      <div>Fair Fight {formatFF(ff)} against this target.</div>
      {isMaxFF(ff) && (
        <div className="mt-1.5">
          {ff > FF_MAX
            ? `Respect pays at the ${formatFF(FF_MAX)} cap. Above it, the higher the number, the stronger the target is than you.`
            : 'At the 3.00 cap: full respect.'}
        </div>
      )}
      <div className="mt-1.5">
        {estimated
          ? 'Estimated: only a stat total is known for one side, so an even split was assumed. The real FF may be lower.'
          : 'From a full stat breakdown on both sides.'}
      </div>
    </InfoTooltip>
  )
}

// Farm mode's Abroad section divider (#561) — dropped once, between the
// main card list and the trailing Abroad cards. Named export so it (and the
// section boundary that decides where it lands) is directly testable rather
// than only provable by eyeballing the overlay.
export function AbroadSectionDivider() {
  return (
    <div className="mt-1 px-3 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs font-semibold text-amber-800 dark:text-amber-300">
      <span aria-hidden="true">✈</span> Abroad — still needs travel time home, timers below don&apos;t mean &quot;attackable soon&quot;
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Member card — compact, side-by-side actions (per design system spec)
// ───────────────────────────────────────────────────────────────────

function MemberCard({ m, dib, currentUserId, myBattleStats, onClaim, onRelease, note, canEditNote = false, onSaveNote }) {
  const isMyDib = dib && String(dib.claimedBy) === String(currentUserId)
  const claimedByOther = dib && !isMyDib
  const isPending = !!(dib && dib._pending)
  const isPendingRelease = dib?._pendingOp === 'release'
  const isPendingClaim   = dib?._pendingOp === 'claim'
  const subLabel = parseTravel(m.state, m.description) || parseAbroadHospital(m.state, m.description)

  // Tap the BSP corner to reveal the per-stat breakdown (mobile analogue of
  // the desktop hover tooltip). Only meaningful when we have a value to show.
  const [statsOpen, setStatsOpen] = useState(false)
  const hasBsp = m.bsp != null
  const isTs = m.spySource === 'tornstats'
  // #996: "DB" — measured from our own hits; its age is the hit's.
  const isMeasured = m.spySource === 'measured'
  const sourceLabel = isMeasured ? 'DB' : isTs ? 'TS' : 'BSP'
  const ageSource = isMeasured ? m.measuredAt : isTs && m.tsSpyAt ? m.tsSpyAt : m.bspFetchedAt
  const ageMs = parseDbTime(ageSource)?.getTime() ?? null
  const ageTs = ageMs === null ? null : Math.floor(ageMs / 1000)
  const ageLabel = ageTs ? formatRelative(ageTs) : '—'
  const breakdownRows = [
    ['STR', m.bspStr],
    ['DEF', m.bspDef],
    ['SPD', m.bspSpd],
    ['DEX', m.bspDex],
  ].filter(([, v]) => v != null)

  return (
    <div className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl p-3 flex flex-col gap-2">
      {/* Row 1 — name + id + level + BSP (tap-to-expand on the BSP corner) */}
      <div className="flex justify-between items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <a
            href={`https://www.torn.com/profiles.php?XID=${m.id}`}
            target="_blank" rel="noopener noreferrer"
            className="text-[15px] font-bold text-gray-900 dark:text-gray-100 truncate block leading-tight no-underline"
          >
            {m.name}
          </a>
          <div className="text-[11px] text-gray-500 dark:text-gray-400 flex gap-1.5 items-center mt-0.5">
            <span>[{m.id}]</span>
            <span>·</span>
            <span>Lv{m.level}</span>
            {m.overdosed && (
              <InfoTooltip
                label="OD"
                decoration="no-underline"
                className="px-1 rounded bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-300 text-[10px] font-semibold"
              >Overdosed</InfoTooltip>
            )}
            <MemberNoteButton
              memberId={m.id}
              memberName={m.name}
              note={note}
              canEdit={canEditNote}
              onSave={onSaveNote}
            />
          </div>
        </div>
        {/* FF sits to the LEFT of the stats: the two are read together — what
            they are worth, then how big they are — and the stats block keeps
            the outer edge because it is the tap target. */}
        <div className="flex items-start gap-2.5 shrink-0">
          <FairFightBadge mine={myBattleStats} m={m} />
          <button
            type="button"
            onClick={() => hasBsp && setStatsOpen(o => !o)}
            aria-expanded={statsOpen}
            aria-label={hasBsp ? `Toggle stats breakdown for ${m.name}` : 'No stats available'}
            disabled={!hasBsp}
            className={`text-right -m-1 p-1 rounded ${hasBsp ? 'cursor-pointer active:bg-gray-100 dark:active:bg-slate-700' : 'cursor-default'}`}
          >
            <div className={`font-mono text-[15px] font-bold leading-none tabular-nums ${m.bsp == null ? 'text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
              {isMeasured && m.measuredBound === 'at_least' ? '≥' : ''}{formatStats(m.bsp)}
            </div>
            <div className="text-[10px] text-gray-400 uppercase tracking-wider mt-0.5">
              {hasBsp ? sourceLabel : 'BSP'}
            </div>
          </button>
        </div>
      </div>

      {/* Stats breakdown — collapsed by default, expanded on BSP tap. Mirrors
          the desktop hover tooltip: per-stat rows when available, Total, and
          a "{relative age} ({TS|BSP})" footer. */}
      {hasBsp && statsOpen && (
        <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 p-2.5 text-[12px] font-mono">
          {breakdownRows.length > 0 ? (
            <table className="w-full">
              <tbody>
                {breakdownRows.map(([label, v]) => (
                  <tr key={label}>
                    <td className="pr-3 text-gray-500 dark:text-gray-400">{label}</td>
                    <td className="text-right text-gray-900 dark:text-gray-100">{formatStats(v)}</td>
                  </tr>
                ))}
                <tr className="border-t border-gray-200 dark:border-slate-700">
                  <td className="pr-3 pt-1 text-gray-500 dark:text-gray-400 font-semibold">Total</td>
                  <td className="text-right pt-1 text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <div className="flex justify-between gap-3">
              <span className="text-gray-500 dark:text-gray-400 font-semibold">Total</span>
              <span className="text-gray-900 dark:text-gray-100 font-semibold">{formatStats(m.bsp)}</span>
            </div>
          )}
          <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400 text-[10px] text-right whitespace-nowrap">
            {ageLabel} ({sourceLabel})
          </div>
        </div>
      )}

      {/* Row 2 — activity + status + timer */}
      <div className="flex items-center flex-wrap gap-2">
        <ActivityDot status={m.activity} ts={m.lastActionTs} />
        <span className="ml-auto inline-flex gap-2 items-center">
          {m.until && <TimerPill until={m.until} />}
          <StatusChip state={m.state} description={m.description} size="sm" />
        </span>
      </div>

      {/* Travel sub-label */}
      {subLabel && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">{subLabel.label}</div>
      )}

      {/* Row 3 — flags + dibs marker */}
      {(FLAG_ICONS.some(f => m.flags?.[f.key]) || stateToFilterKey(m.state, m.description) === 'Flying' || dib) && (
        <div className="flex items-center gap-2 flex-wrap">
          <FlagsRow flags={m.flags} state={m.state} description={m.description} />
          {dib && (
            <span className={`ml-auto text-[11px] font-semibold inline-flex items-center gap-1 ${isMyDib ? 'text-blue-600' : 'text-purple-700 dark:text-purple-400'}`}>
              <Hand size={12} />
              Dibs: {isMyDib ? 'You' : dib.claimedName}
            </span>
          )}
        </div>
      )}

      {/* Row 4 — actions, side-by-side */}
      <div className="flex gap-2">
        <InfoTooltip
          wrap
          className="flex-1"
          // Only the reasons it is UNPRESSABLE need a way in. "Press to release
          // your dib" just restated the button's own label, and a tooltip on a
          // live button would have to steal the tap to show it.
          label={
        <button
          onClick={() => isMyDib ? onRelease(m.id) : onClaim(m.id)}
          disabled={claimedByOther || isPending}
          className={`flex-1 min-h-[40px] rounded-lg px-3 font-semibold text-[13px] border inline-flex items-center justify-center gap-1.5 transition-colors ${
            claimedByOther
              ? 'bg-gray-200 text-gray-400 border-gray-200 cursor-not-allowed dark:bg-slate-700 dark:text-slate-500 dark:border-slate-700'
              : isMyDib
              ? `bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800 ${isPending ? 'opacity-70' : ''}`
              : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700'
          }`}
        >
          {isPending ? <Loader2 size={14} className="animate-spin" /> : isMyDib ? <Check size={14} /> : <Plus size={14} />}
          {isPendingRelease ? (
            <span className="flex flex-col items-center leading-tight">
              <span>Releasing…</span>
            </span>
          ) : isMyDib ? (
            <span className="flex flex-col items-center leading-tight">
              <span>Your dib</span>
              <span className="text-[10px] font-normal opacity-75">{isPendingClaim ? 'Claiming…' : 'Tap to release'}</span>
            </span>
          ) : (
            'Dibs'
          )}
        </button>
          }
        >
          {claimedByOther ? `Claimed by ${dib.claimedName}`
            : isPending ? 'Waiting for server confirmation…'
            : null}
        </InfoTooltip>
        {/* Attack — 3 states (priority order):
              1. Green Attack: target is Online AND Okay (overrides dibs —
                 a fresh-kill window shouldn't be locked behind a claim).
              2. Blue Assist <name>: someone else holds dibs AND target
                 isn't in the green window.
              3. Red Attack: default — Idle / Offline / hospitalised. */}
        {(() => {
          const isOnlineOkay = m.activity === 'Online' && m.state === 'Okay'
          const showAssist   = !isOnlineOkay && claimedByOther
          const colorClass   = isOnlineOkay
            ? 'bg-green-600 hover:bg-green-700 text-white'
            : showAssist
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-red-600 hover:bg-red-700 text-white'
          // No tooltip: the assist state already says "Assist {name}" on the
          // button face, and "tap to assist" only restated it (#612).
          const label = showAssist ? `Assist ${dib.claimedName}` : 'Attack'
          return (
            <a
              href={`https://www.torn.com/page.php?sid=attack&user2ID=${m.id}`}
              target="_blank" rel="noopener noreferrer"
              className={`flex-1 min-h-[40px] rounded-lg px-3 font-semibold text-[13px] inline-flex items-center justify-center gap-1.5 no-underline ${colorClass}`}
            >
              <Swords size={15} />
              {label}
            </a>
          )
        })()}
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Surge banner (#208 / #359 / #479)
// ───────────────────────────────────────────────────────────────────

/**
 * The server-detected push warning, on the phone.
 *
 * ⚠️ This existed only on desktop until #479, and not by decision. The banner
 * lives in the parent view, and the mobile overlay is a `fixed inset-0` sheet
 * drawn on top of it — so the warning was rendering the whole time, underneath
 * a full-screen cover. The parent's own comment is explicit that the banner
 * shows regardless of a member's alert preferences, because *"silencing a ping
 * is not the same as hiding the warning"*; on mobile it was hidden anyway.
 *
 * The sound and flash were never affected — `useWarRoomAlerts` runs in the
 * parent and fired normally. What a mobile user lost was WHICH surge it was and
 * what to do about it.
 *
 * Colour carries the direction, matching desktop exactly: green when it is us
 * pushing, amber for an incoming REVIVE surge (#359 — nothing has landed yet),
 * red only for "they are hitting us right now".
 */
function SurgeBanner({ alert, canPostRally, onPostRally, posting, onDismiss }) {
  const tone = alert.direction !== 'enemy' ? 'bg-green-600'
    : alert.surge === 'revive' ? 'bg-amber-600'
    : 'bg-red-600'
  return (
    <div className={`rounded-lg px-3 py-2.5 shadow-lg text-white flex items-start gap-2 ${tone}`}>
      <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="font-bold text-[15px] leading-tight">{alert.title}</div>
        {alert.body && <div className="text-[12px] opacity-90 leading-snug mt-0.5">{alert.body}</div>}
        {canPostRally && (
          alert.posted ? (
            <span className="inline-block mt-2 text-[11px] font-semibold px-2 py-1 rounded bg-white/20">
              Headline posted ✓
            </span>
          ) : (
            <button
              onClick={onPostRally}
              disabled={posting}
              className="mt-2 min-h-[36px] px-3 rounded-lg bg-white/90 text-gray-900 text-[12px] font-semibold disabled:opacity-60"
            >
              {posting ? 'Posting…' : 'Post rally call'}
            </button>
          )
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss" className="p-1 rounded hover:bg-black/20 flex-shrink-0">
        <X size={16} />
      </button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Header bar — sticky, with cog (leadership), close X, filter pill
// ───────────────────────────────────────────────────────────────────

function HeaderBar({ factionLabel, isActive, paused, isLeadership, activeFilterCount, onOpenFilters, onOpenLeadership, onClose }) {
  return (
    <div className="sticky top-0 z-20 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 px-3.5 py-2.5 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[17px] font-bold leading-tight text-gray-900 dark:text-gray-100">War Room</h1>
          {isActive && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-[10px] font-bold tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              LIVE
            </span>
          )}
          {paused && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold tracking-wider">PAUSED</span>}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{factionLabel}</div>
      </div>

      {isLeadership && (
        <button onClick={onOpenLeadership} aria-label="Leadership controls" className="w-9 h-9 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-300 inline-flex items-center justify-center flex-shrink-0">
          <Settings size={18} />
        </button>
      )}

      <button onClick={onOpenFilters} aria-label="Filters" className="relative w-9 h-9 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-300 inline-flex items-center justify-center flex-shrink-0">
        <SlidersHorizontal size={18} />
        {activeFilterCount > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-bold inline-flex items-center justify-center">
            {activeFilterCount}
          </span>
        )}
      </button>

      {onClose && (
        <button onClick={onClose} aria-label="Exit mobile view" className="w-9 h-9 rounded-lg bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 inline-flex items-center justify-center flex-shrink-0">
          <X size={18} />
        </button>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Faction strip + quick links + filter bar
// ───────────────────────────────────────────────────────────────────

// Combined two-side count ribbon: ENEMY on the left, US on the right,
// separated by a vertical divider. Wraps to two stacked rows on
// extremely narrow viewports via flex-wrap on the outer container.
function CombinedCountRibbon({ enemyCounts, ourCounts }) {
  const dot = (color, n, lbl) => (
    <span className="inline-flex items-center gap-1 text-xs min-w-0">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${color}`} />
      <span className="font-semibold text-gray-900 dark:text-gray-100">{n}</span>
      <span className="text-gray-500 dark:text-gray-400">{lbl}</span>
    </span>
  )
  const okayChip = (n, online) => (
    <span className="inline-flex items-center gap-1 text-xs min-w-0 text-emerald-700 dark:text-emerald-400">
      <span className="font-semibold">{n}</span>
      <span>Okay</span>
      <span className="text-emerald-600/70 dark:text-emerald-500/70">({online})</span>
    </span>
  )
  return (
    <div className="px-3.5 py-2 bg-gray-50 dark:bg-slate-900 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className="text-[10px] font-bold text-gray-400 tracking-wider">ENEMY</span>
        {dot('bg-green-500', enemyCounts.Online, 'on')}
        {dot('bg-amber-500', enemyCounts.Idle,   'idle')}
        {okayChip(enemyCounts.Okay ?? 0, enemyCounts.OkayOnline ?? 0)}
      </div>
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        {okayChip(ourCounts.Okay ?? 0, ourCounts.OkayOnline ?? 0)}
        {dot('bg-amber-500', ourCounts.Idle,   'idle')}
        {dot('bg-green-500', ourCounts.Online, 'on')}
        <span className="text-[10px] font-bold text-gray-400 tracking-wider">US</span>
      </div>
    </div>
  )
}

function QuickLinksBar({ reviveServiceName, reviveServiceUrl, onRequestRevive }) {
  const tileBase = 'flex-1 h-12 rounded-lg border flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium no-underline transition-colors'
  const tileIdle = 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-gray-700 dark:text-gray-300 active:bg-gray-100 dark:active:bg-slate-800'

  // Plain external links (mirror desktop URLs in QuickLinksBar)
  const links = [
    { href: 'https://www.torn.com/factions.php?step=your&type=1#/war/rank',                 Icon: Swords,           label: 'War'     },
    { href: 'https://www.torn.com/factions.php?step=your#/tab=armoury&start=0&sub=medical', Icon: BriefcaseMedical, label: 'Medical' },
    { href: 'https://www.torn.com/item.php',                                                Icon: ShoppingBag,      label: 'Items'   },
  ]

  return (
    <div className="px-3.5 py-2.5 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex justify-between gap-2">
      {links.map(({ href, Icon, label }) => (
        <a key={label} href={href} target="_blank" rel="noopener noreferrer" className={`${tileBase} ${tileIdle}`}>
          <Icon size={18} />
          {label}
        </a>
      ))}
      <ReviveQuickLinkTile
        serviceName={reviveServiceName}
        serviceUrl={reviveServiceUrl}
        onRequestRevive={onRequestRevive}
        tileBase={tileBase}
      />
    </div>
  )
}

// Mirrors desktop ReviveQuickLinkButton: fires onRequestRevive (parent owns
// the actual edge-function call + user context). Locks for 2s after firing
// and surfaces a brief ok/error tint so tappers know it actually went out.
function ReviveQuickLinkTile({ serviceName, serviceUrl, onRequestRevive, tileBase }) {
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const disabled = !serviceUrl || busy || cooldown

  async function handleClick() {
    if (disabled) return
    setBusy(true); setFeedback(null)
    try {
      const result = await onRequestRevive()
      if (result?.ok) {
        setFeedback({ ok: true, text: 'Sent' })
      } else {
        const reason = result?.body?.reason ?? (result?.status ? `HTTP ${result.status}` : 'Failed')
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

  const baseLabel = serviceName || 'Revives'
  const title = !serviceUrl
    ? 'Revives — leadership must select a service'
    : busy ? `${baseLabel} — sending…`
    : feedback ? `${baseLabel} — ${feedback.text}`
    : `${baseLabel} — tap to request a revive`

  const stateClasses = feedback?.ok
    ? 'border-green-400 text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20'
    : feedback && !feedback.ok
    ? 'border-red-400 text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20'
    : disabled
    ? 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-gray-300 dark:text-slate-600 cursor-not-allowed'
    : 'border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-gray-700 dark:text-gray-300 active:bg-gray-100 dark:active:bg-slate-800'

  return (
    <button type="button" onClick={handleClick} disabled={disabled} aria-label={title} className={`${tileBase} ${stateClasses}`}>
      <HeartPulse size={18} />
      {busy ? '…' : feedback ? feedback.text : 'Revives'}
    </button>
  )
}

function TwoTierFilters({
  statusFilter, onToggleStatus,
  activityFilter, onToggleActivity,
  ffMaxOnly, onToggleFf, ffUsable,
  sortBy, onToggleFarm,
  advancedCount, onOpenAdvanced,
}) {
  const chip = (label, active, onClick, activeClass = 'bg-blue-600 text-white border-blue-600', opts = {}) => (
    <InfoTooltip
      key={label}
      wrap
      className="flex-shrink-0"
      label={
    <button
      onClick={onClick}
      disabled={opts.disabled}
      className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border ${
        active
          ? activeClass
          : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700'
      } ${opts.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {label}
    </button>
      }
    >
      {opts.title ?? null}
    </InfoTooltip>
  )
  return (
    <div className="px-3 py-2 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex gap-1.5 overflow-x-auto whitespace-nowrap items-center scrollbar-hide">
      {/* Status filters — Flying/Jail moved to the More sheet to make room
          for an activity (Online) chip and the Farm sort toggle. */}
      {chip('Okay',     statusFilter.has('Okay'),     () => onToggleStatus('Okay'))}
      {chip('Hospital', statusFilter.has('Hospital'), () => onToggleStatus('Hospital'))}
      {/* Activity filter — single-purpose Online toggle. Idle/Offline still
          live in the More sheet's Activity section. */}
      {chip('Online', activityFilter.has('Online'), () => onToggleActivity('Online'))}
      {/* "3x FF" (#479) — only targets paying the full respect multiplier.
          In farm mode anyone online and out of hospital stays on the board
          regardless, so the filter cannot hide a push forming. */}
      {chip('3x FF', ffMaxOnly && ffUsable, onToggleFf, 'bg-purple-600 text-white border-purple-600', {
        disabled: !ffUsable,
        title: ffUsable
          ? 'Only targets at the 3.00 fair-fight cap. In farm mode anyone online and out of hospital stays visible regardless.'
          : 'No battle stats on record for you yet, so FF cannot be computed.',
      })}
      {/* Farm-mode sort toggle. Distinct emerald active styling so it reads
          as "mode" rather than another filter chip. */}
      {chip('Farm', sortBy === 'farm', onToggleFarm, 'bg-emerald-600 text-white border-emerald-600')}
      <button
        onClick={onOpenAdvanced}
        className="flex-shrink-0 px-3 py-1.5 rounded-full bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-gray-300 text-xs font-medium inline-flex items-center gap-1.5"
      >
        <SlidersHorizontal size={12} />
        More{advancedCount > 0 ? ` (${advancedCount})` : ''}
      </button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Sheet primitives — MUST live at module scope so React keeps their
// component identity stable across parent renders. Previously these
// were defined inside FilterSheet/LeadershipSheet, which gave them a
// new identity on every keystroke and caused React to unmount + remount
// every input → inputs lost focus mid-type, and on iOS the on-screen
// keyboard dismissed each character (looked like "the sheet closes").
// ───────────────────────────────────────────────────────────────────

function SheetSection({ title, children }) {
  return (
    <div className="px-4 py-3.5 border-b border-gray-200 dark:border-slate-700">
      <div className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  )
}

function SheetInput({ className = '', ...props }) {
  return (
    <input
      {...props}
      className={`px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-[13px] text-gray-900 dark:text-gray-100 font-mono min-w-0 ${className}`}
    />
  )
}

// ───────────────────────────────────────────────────────────────────
// Bottom-sheet primitive
// ───────────────────────────────────────────────────────────────────

function BottomSheet({ open, onClose, title, children }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black/45 flex items-end">
      <div
        onClick={e => e.stopPropagation()}
        className="w-full bg-white dark:bg-slate-800 rounded-t-2xl max-h-[85vh] flex flex-col"
        style={{ animation: 'wrSlideUp 220ms cubic-bezier(0.32, 0.72, 0, 1)' }}
      >
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-9 h-1 bg-gray-300 dark:bg-slate-600 rounded-full" />
        </div>
        <div className="px-4 pt-1.5 pb-3.5 flex justify-between items-center border-b border-gray-200 dark:border-slate-700">
          <div className="text-[15px] font-bold text-gray-900 dark:text-gray-100">{title}</div>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-lg text-gray-500 inline-flex items-center justify-center">
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────
// Filter sheet — used by "More" button + the always-on filter icon
// ───────────────────────────────────────────────────────────────────

function FilterSheet({
  open, onClose,
  statusFilter, toggleStatus, activityFilter, toggleActivity,
  ffMaxOnly, setFfMaxOnly, ffUsable,
  statsEnabled, setStatsEnabled, statsMin, setStatsMin, statsMax, setStatsMax,
  sortBy, setSortBy, sortDir, setSortDir,
  onClear,
}) {
  const chip = (label, active, onClick) => (
    <button
      key={label}
      onClick={onClick}
      className={`px-3.5 py-2 rounded-full text-[13px] font-medium border ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700'
      }`}
    >
      {label}
    </button>
  )

  return (
    <BottomSheet open={open} onClose={onClose} title="Filters & sort">
      <SheetSection title="Sort by">
        <div className="flex gap-1.5 flex-wrap">
          {[
            { key: 'timer',    label: 'Timer'    },
            { key: 'stats',    label: 'Stats'    },
            { key: 'status',   label: 'Status'   },
            { key: 'activity', label: 'Activity' },
            { key: 'name',     label: 'Name'     },
            { key: 'farm',     label: 'Farm'     },
            ...(ffUsable ? [{ key: 'ff', label: 'FF' }] : []),
          ].map(opt => chip(opt.label, sortBy === opt.key, () => setSortBy(opt.key)))}
        </div>
        {sortBy === 'farm' ? (
          <div className="mt-2.5 text-[11px] text-gray-500 dark:text-gray-400">
            Okay at top (most-recently-released first), then hospital/jail by timer ascending. Direction toggle doesn't apply.
          </div>
        ) : (
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-[11px] text-gray-500 dark:text-gray-400 uppercase tracking-wider">Direction</span>
            <div className="flex gap-1.5">
              {chip('Asc ↑',  sortDir === 'asc',  () => setSortDir('asc'))}
              {chip('Desc ↓', sortDir === 'desc', () => setSortDir('desc'))}
            </div>
          </div>
        )}
      </SheetSection>
      <SheetSection title="Status">
        <div className="flex gap-1.5 flex-wrap">
          {['Okay', 'Hospital', 'Flying', 'Jail'].map(s => chip(s, statusFilter.has(s), () => toggleStatus(s)))}
        </div>
      </SheetSection>
      <SheetSection title="Activity">
        <div className="flex gap-1.5 flex-wrap">
          {['Online', 'Idle', 'Offline'].map(a => chip(a, activityFilter.has(a), () => toggleActivity(a)))}
        </div>
      </SheetSection>
      <SheetSection title="Fair Fight">
        <div className="flex gap-2 items-center">
          <button
            onClick={() => ffUsable && setFfMaxOnly(!ffMaxOnly)}
            disabled={!ffUsable}
            className={`px-3.5 py-2 rounded-full text-[13px] font-medium border ${
              ffMaxOnly && ffUsable
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700'
            } ${ffUsable ? '' : 'opacity-50 cursor-not-allowed'}`}
          >
            3x FF only
          </button>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {ffUsable
              ? 'Targets at the 3.00 cap. In farm mode anyone online and out of hospital stays visible regardless, so a push can’t hide behind the filter.'
              : 'No battle stats on record for you yet, so FF cannot be computed.'}
          </span>
        </div>
      </SheetSection>
      <SheetSection title="Battle Stats (BSP)">
        <div className="flex gap-2 items-center mb-2">
          <button
            onClick={() => setStatsEnabled(!statsEnabled)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
              statsEnabled ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-slate-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-slate-700'
            }`}
          >
            {statsEnabled ? 'On' : 'Off'}
          </button>
          <input
            type="text" placeholder="Min — 3m" value={statsMin}
            onChange={e => setStatsMin(e.target.value)}
            className={`flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-[13px] text-gray-900 dark:text-gray-100 font-mono ${statsEnabled ? '' : 'opacity-50'}`}
          />
          <span className="text-gray-400">–</span>
          <input
            type="text" placeholder="Max — 2.6b" value={statsMax}
            onChange={e => setStatsMax(e.target.value)}
            className={`flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-[13px] text-gray-900 dark:text-gray-100 font-mono ${statsEnabled ? '' : 'opacity-50'}`}
          />
        </div>
        <div className="text-[11px] text-gray-500">Suffixes: <code className="font-mono text-[10px] bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 px-1 rounded">k</code> · <code className="font-mono text-[10px] bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 px-1 rounded">m</code> · <code className="font-mono text-[10px] bg-gray-100 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 px-1 rounded">b</code></div>
      </SheetSection>
      <div className="p-4 flex gap-2.5">
        <button onClick={onClear} className="flex-1 min-h-[44px] rounded-lg bg-transparent border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 font-medium text-sm">Clear all</button>
        <button onClick={onClose} className="flex-[2] min-h-[44px] rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm">Apply</button>
      </div>
    </BottomSheet>
  )
}

// ───────────────────────────────────────────────────────────────────
// Leadership sheet
// ───────────────────────────────────────────────────────────────────

function LeadershipSheet({
  open, onClose, paused,
  reviveServices = [], activeReviveName = '', onPickReviveService,
  onTogglePaused, onUpdateSpies, updatingSpies = false, spiesMsg = null,
  tornstatsMaxAgeDays = 0, onChangeTornstatsMaxAge = () => {},
  factionId, onSetFactionId, onClearState,
}) {
  const [localFactionId, setLocalFactionId] = useState(factionId)
  const [localTsMaxAge, setLocalTsMaxAge] = useState(String(tornstatsMaxAgeDays ?? 0))
  // Resync when external config updates land.
  useEffect(() => { setLocalTsMaxAge(String(tornstatsMaxAgeDays ?? 0)) }, [tornstatsMaxAgeDays])
  function commitTsMaxAge() {
    const next = Math.max(0, Math.floor(Number(localTsMaxAge) || 0))
    if (next === (tornstatsMaxAgeDays ?? 0)) return
    onChangeTornstatsMaxAge(next)
  }

  function handlePickRevive(e) {
    const picked = e.target.value
    const found = reviveServices.find(s => s.name === picked)
    onPickReviveService({
      revive_service_name: found?.name ?? null,
      revive_service_url:  found?.url  ?? null,
    })
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Leadership controls">
      <SheetSection title="Polling">
        <div className="flex items-center gap-2.5 justify-between">
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{paused ? 'Paused' : 'Active'}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">{paused ? 'No live polling — last-known snapshot.' : 'Live — the roster streams over the socket.'}</div>
          </div>
          <button
            onClick={onTogglePaused}
            className={`min-h-[36px] px-3.5 rounded-lg font-semibold text-[13px] inline-flex items-center gap-1.5 ${
              paused ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
            }`}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? 'Enable' : 'Stop'}
          </button>
        </div>
        {/* The "Poll rate" input that lived here was inert (#336): the board
            is push-driven over the WebSocket, so the value was never read.
            Cadences are server-side settings now — see the desktop config
            panel. */}
      </SheetSection>
      <SheetSection title="Opponent Faction">
        <div className="flex items-center gap-2">
          <SheetInput
            type="text" placeholder="Faction ID — e.g. 8317"
            value={localFactionId} onChange={e => setLocalFactionId(e.target.value)}
            className="flex-1"
          />
          <button onClick={() => onSetFactionId(localFactionId)} className="min-h-[40px] px-3.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-[13px]">Save</button>
        </div>
      </SheetSection>
      <SheetSection title="Revive Service">
        <select
          value={activeReviveName}
          onChange={handlePickRevive}
          className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-[13px] text-gray-900 dark:text-gray-100"
        >
          <option value="">None</option>
          {reviveServices.map(s => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          Manage the list on desktop — Revives quick-link uses the active service.
        </div>
      </SheetSection>
      <SheetSection title="Stats Enrichment">
        <button
          onClick={onUpdateSpies}
          disabled={updatingSpies}
          className="w-full min-h-[44px] rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-800 font-semibold text-[13px] inline-flex items-center justify-center gap-2 disabled:opacity-60"
        >
          <Search size={14} />
          {updatingSpies ? 'Fetching…' : 'Update Spies — pull spies for all enemies'}
        </button>
        {spiesMsg && (
          <div className={`mt-2 text-[11px] ${spiesMsg.ok ? 'text-purple-700 dark:text-purple-300' : 'text-red-600 dark:text-red-400'}`}>
            {spiesMsg.text}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <label className="text-[12px] text-gray-600 dark:text-gray-400 whitespace-nowrap">TornStats age</label>
          <SheetInput
            type="number" min={0} step={1}
            value={localTsMaxAge}
            onChange={e => setLocalTsMaxAge(e.target.value)}
            onBlur={commitTsMaxAge}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="w-20 text-center"
          />
          <span className="text-[11px] text-gray-500 dark:text-gray-400">days (0 = any age)</span>
        </div>
      </SheetSection>
      {onClearState && (
        <SheetSection title="Danger Zone">
          <button
            onClick={async () => {
              if (!confirm('Clear all war room member data? Do this when starting a new war.')) return
              try { await onClearState() } catch (e) { alert(e.message) }
            }}
            className="w-full min-h-[40px] rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 font-semibold text-[13px]"
          >
            Clear War Room State
          </button>
          <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Wipes the current member roster. Use when starting a new war.
          </div>
        </SheetSection>
      )}
      <div className="p-4">
        <button onClick={onClose} className="w-full min-h-[44px] rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm">Done</button>
      </div>
    </BottomSheet>
  )
}

// ───────────────────────────────────────────────────────────────────
// Top-level component
// ───────────────────────────────────────────────────────────────────

export default function MobileWarRoomView({
  members = [],
  dibsByEnemyId = {},
  currentUserId,
  headlineConfig = null,
  canManageHeadline = false,
  memberNotes = {},
  canEditNotes = false,
  onSaveNote,
  // The viewer's own battle stats, for the personal FF badge (#422). Null when
  // we hold none for them — the badge is then omitted rather than dashed.
  myBattleStats = null,
  // Server-detected push surge (#208/#359). The parent owns detection, the
  // sound/flash and the dismiss timer; this component only renders it.
  surgeAlert = null,
  onDismissSurge = () => {},
  canPostRally = false,
  onPostRally = () => {},
  postingHeadline = false,
  factionId,
  factionName,
  ourCounts = { Online: 0, Idle: 0, Okay: 0, OkayOnline: 0 },
  isLeadership = false,
  isActive = true,
  paused = false,
  reviveServices = [],
  activeReviveName = '',
  activeReviveUrl = '',
  onPickReviveService = () => {},
  onRequestRevive = async () => ({ ok: false, body: { reason: 'No revive handler wired' } }),
  updatingSpies = false,
  spiesMsg = null,
  tornstatsMaxAgeDays = 0,
  onChangeTornstatsMaxAge = () => {},
  onClaim = () => {},
  onRelease = () => {},
  onTogglePaused = () => {},
  onUpdateSpies = () => {},
  onSetFactionId = () => {},
  onClearState = () => {},
  onClose,
}) {
  // Reload-persisted prefs for the mobile war room. Kept on a separate
  // key from the desktop view so each surface can have its own
  // filter/sort defaults — the user often uses them for different goals.
  const [persistedState, setPersistedState] = useViewState('warroom_mobile')

  // Filter Sets seed from persisted arrays (Set/Map don't JSON-serialise).
  // Status defaults to "Okay" only when there is no persisted preference
  // (preserves the previous behaviour for first-time visitors).
  const [statusFilter, setStatusFilter] = useState(() =>
    new Set(persistedState.statusFilter ?? ['Okay'])
  )
  const [activityFilter, setActivityFilter] = useState(() => new Set(persistedState.activityFilter ?? []))
  const [ffMaxOnly, setFfMaxOnly] = useState(() => persistedState.ffMaxOnly ?? false)
  const [statsEnabled, setStatsEnabled] = useState(() => persistedState.statsEnabled ?? false)
  const [statsMin, setStatsMin] = useState(() => persistedState.statsMin ?? '')
  const [statsMax, setStatsMax] = useState(() => persistedState.statsMax ?? '')
  const [sortBy, setSortBy] = useState(() => persistedState.sortBy ?? 'timer')
  const [sortDir, setSortDir] = useState(() => persistedState.sortDir ?? 'asc')
  const [filterOpen, setFilterOpen] = useState(false)
  const [leaderOpen, setLeaderOpen] = useState(false)

  // First-open spotlight pass for the mobile overlay (#153). Runs once per
  // browser the first time the overlay is opened; steps whose targets aren't
  // present are skipped. Its own seen-flag + one-click Skip, separate from the
  // desktop tour.
  const [tourActive, setTourActive] = useState(() => !isTourSeen('mobile'))

  // Persist any user-tweakable pref back to the context whenever it changes.
  useEffect(() => {
    setPersistedState({
      statusFilter: [...statusFilter],
      activityFilter: [...activityFilter],
      ffMaxOnly,
      statsEnabled,
      statsMin,
      statsMax,
      sortBy,
      sortDir,
    })
  }, [statusFilter, activityFilter, ffMaxOnly, statsEnabled, statsMin, statsMax, sortBy, sortDir, setPersistedState])

  // FF for one row, from the viewer's perspective (#422). Shared by the sort
  // and the 3x filter so the two cannot disagree with the badge on the card.
  // ⚠️ #995: TRUE (uncapped) FF — the sort ranks by it; the 3x filter still
  // means "pays full respect" because isMaxFF is `>= 3`.
  const ffFor = useCallback(
    (m) => trueFairFight(myBattleStats, targetBattleStats(m)),
    [myBattleStats]
  )
  // Only offerable when we can actually compute it — a 3x filter with no
  // attacker stats would silently empty the board.
  const ffUsable = myBattleStats != null

  const toggleStatus = s => setStatusFilter(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n })
  const toggleActivity = a => setActivityFilter(p => { const n = new Set(p); n.has(a) ? n.delete(a) : n.add(a); return n })
  const clearFilters = () => {
    setStatusFilter(new Set()); setActivityFilter(new Set())
    setFfMaxOnly(false)
    setStatsEnabled(false); setStatsMin(''); setStatsMax('')
  }

  // Farm-mode tracking: remember when each member transitioned INTO Okay
  // during the current session, so freshly-released targets bubble to the
  // very top of the Okay tier. Members already Okay when mobile opens get
  // no timestamp (they fall back to BSP-desc within the Okay group), so a
  // brand-new transition reliably outranks the standing pool.
  const prevStatesRef = useRef(new Map())  // memberId → last observed state
  const okayAtRef     = useRef(new Map())  // memberId → ms-since-epoch first observed as Okay

  // Farm mode's Abroad section (#561): `filtered` stays a flat array
  // (unchanged for every other sort), but in farm mode the Abroad cards are
  // pushed to the tail and `farmAbroadStart` records where that section
  // begins so the card list can drop a divider there. Non-farm sorts leave
  // it null.
  const [filtered, farmAbroadStart] = useMemo(() => {
    // Update transition tracker as a side effect of recomputing the filtered
    // list. Safe because the only consumer of these refs is the sort below.
    const prev = prevStatesRef.current
    const okayAt = okayAtRef.current
    const now = Date.now()
    for (const m of members) {
      const wasState = prev.get(m.id)
      if (m.state === 'Okay' && wasState && wasState !== 'Okay') {
        okayAt.set(m.id, now)
      } else if (m.state !== 'Okay') {
        okayAt.delete(m.id)
      }
      prev.set(m.id, m.state)
    }

    let list = members
    if (statusFilter.size > 0)   list = list.filter(m => statusFilter.has(stateToFilterKey(m.state, m.description)))
    if (activityFilter.size > 0) list = list.filter(m => activityFilter.has(m.activity))
    // ⚠️ In FARM MODE both "3x FF" and the min/max keep a GREEN attack button
    // on screen (#481) — someone online and out of hospital is the enemy
    // standing up, and a filter that hides the thing you have to react to is
    // worse than no filter. The two take the same condition deliberately, so
    // the board never depends on which filter you reached for.
    const farmMode = sortBy === 'farm'
    if (ffMaxOnly && ffUsable) {
      list = list.filter(m => passesFfFilter(ffFor(m), {
        enabled: true, farmMode, isGreen: isGreenTarget(m),
      }))
    }
    if (statsEnabled) {
      const minVal = parseStatInput(statsMin)
      const maxVal = parseStatInput(statsMax)
      list = list.filter(m => passesStatsFilter(m, {
        min: minVal, max: maxVal, farmMode, isGreen: isGreenTarget(m),
      }))
    }
    // Farm mode (#561): split off before the generic sort below — see the
    // matching comment in WarRoomViewV2.jsx for why this can't be one more
    // `switch` case (it changes the SHAPE of the result, not just its
    // order). sortDir is intentionally ignored, same as farmCompare's
    // existing fixed semantics.
    if (sortBy === 'farm') {
      const farmTarget = m => ({
        isGreen: m.activity === 'Online' && m.state === 'Okay',
        okay: m.state === 'Okay',
        until: m.until,
        bsp: m.bsp,
        okayAt: okayAt.get(m.id) ?? -1,
      })
      const { main, abroad } = splitFarmAbroad(list, farmTarget)
      return [[...main, ...abroad], main.length]
    }

    const dir = sortDir === 'asc' ? 1 : -1
    const sorted = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return dir * (a.name || '').localeCompare(b.name || '')
        case 'activity': {
          const order = { Online: 0, Idle: 1, Offline: 2 }
          return dir * ((order[a.activity] ?? 3) - (order[b.activity] ?? 3))
        }
        case 'status':
          return dir * (a.state ?? '').localeCompare(b.state ?? '')
        case 'stats':
          return dir * ((a.bsp ?? -1) - (b.bsp ?? -1))
        case 'ff': {
          // #351: a target we cannot compute FF for sinks to the bottom in
          // BOTH directions. Sorting an unknown as 1.00 or as 3.00 buries it
          // mid-list, which is worse than either end.
          const av = ffFor(a)
          const bv = ffFor(b)
          if (av === null && bv === null) return (a.name || '').localeCompare(b.name || '')
          if (av === null) return 1
          if (bv === null) return -1
          return dir * (av - bv)
        }
        case 'timer':
        default: {
          // Members with an active timer (Hospital/Jail) sort by timer in
          // the chosen direction; everyone else drops below them sorted by
          // BSP desc for a scannable trailing block.
          const aT = a.until && a.state !== 'Okay'
          const bT = b.until && b.state !== 'Okay'
          if (aT && bT) return dir * (a.until - b.until)
          if (aT) return -1
          if (bT) return 1
          return (b.bsp ?? 0) - (a.bsp ?? 0)
        }
      }
    })
    return [sorted, null]
  }, [members, statusFilter, activityFilter, ffMaxOnly, ffUsable, ffFor, statsEnabled, statsMin, statsMax, sortBy, sortDir])

  // Phase 7e shape: { Online, Idle, Okay, OkayOnline }. Offline dropped.
  // Okay = strict in-Torn (state AND description both 'Okay');
  // OkayOnline = subset of Okay also Online.
  const enemyCounts = useMemo(() => {
    const c = { Online: 0, Idle: 0, Okay: 0, OkayOnline: 0 }
    for (const m of members) {
      if (m.activity === 'Online') c.Online += 1
      else if (m.activity === 'Idle') c.Idle += 1
      if (m.state === 'Okay' && m.description === 'Okay') {
        c.Okay += 1
        if (m.activity === 'Online') c.OkayOnline += 1
      }
    }
    return c
  }, [members])

  const ffFilterActive = ffMaxOnly && ffUsable
  const activeFilterCount = statusFilter.size + activityFilter.size
    + (ffFilterActive ? 1 : 0)
    + (statsEnabled && (statsMin || statsMax) ? 1 : 0)
  // The 3x chip lives on the top bar, so it does not count towards "More".
  const advancedCount = activityFilter.size + (statsEnabled && (statsMin || statsMax) ? 1 : 0)

  return (
    <div className="w-full h-full overflow-y-auto overflow-x-hidden bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-gray-100 relative">
      <style>{`
        @keyframes wrSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { scrollbar-width: none; }
      `}</style>

      <HeaderBar
        factionLabel={`${factionName || 'Enemy faction'} [${factionId}]`}
        isActive={isActive && !paused}
        paused={paused}
        isLeadership={isLeadership}
        activeFilterCount={activeFilterCount}
        onOpenFilters={() => setFilterOpen(true)}
        onOpenLeadership={() => setLeaderOpen(true)}
        onClose={onClose}
      />

      {/* Surge warning (#479) — above the headline and everything else, because
          it is the one thing on this screen that is time-critical. z-40 keeps it
          over the roster and the headline while staying under the bottom
          sheets (z-50), so opening Filters does not bury it either. */}
      {surgeAlert && (
        <div className="sticky top-0 z-40 px-3 pt-2">
          <SurgeBanner
            alert={surgeAlert}
            canPostRally={canPostRally}
            onPostRally={onPostRally}
            posting={postingHeadline}
            onDismiss={onDismissSurge}
          />
        </div>
      )}

      {/* Leader headline (#197) — pinned to the top of the overlay so it stays
          visible as the roster scrolls. Only mount the sticky wrapper when the
          banner has something to show (a headline, or the leader composer). */}
      {(headlineConfig?.headline_text || canManageHeadline) && (
        <div className="sticky top-0 z-30 px-3 pt-2 bg-gray-50/95 dark:bg-slate-900/95 backdrop-blur">
          <HeadlineBanner config={headlineConfig} canManage={canManageHeadline} />
        </div>
      )}

      {paused && (
        <div className="mx-3 my-2.5 px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-xs leading-relaxed flex items-start gap-2 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} className="flex-shrink-0 mt-px" />
          <span>Paused — showing last-known snapshot. Timers below aren't live.</span>
        </div>
      )}

      {/* Quick links sit directly under the header; a single combined ribbon
          beneath them carries both ENEMY and US activity counts side-by-side. */}
      <QuickLinksBar
        reviveServiceName={activeReviveName}
        reviveServiceUrl={activeReviveUrl}
        onRequestRevive={onRequestRevive}
      />
      <CombinedCountRibbon enemyCounts={enemyCounts} ourCounts={ourCounts} />
      <div data-tour="m-settings">
      <TwoTierFilters
        statusFilter={statusFilter}
        onToggleStatus={toggleStatus}
        activityFilter={activityFilter}
        onToggleActivity={toggleActivity}
        ffMaxOnly={ffMaxOnly}
        onToggleFf={() => setFfMaxOnly(v => !v)}
        ffUsable={ffUsable}
        sortBy={sortBy}
        onToggleFarm={() => setSortBy(s => s === 'farm' ? 'timer' : 'farm')}
        advancedCount={advancedCount}
        onOpenAdvanced={() => setFilterOpen(true)}
      />
      </div>

      <div data-tour="m-roster" className="px-3 pt-3 pb-20 flex flex-col gap-2">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">
            No members match the current filters.<br />
            <button onClick={clearFilters} className="mt-3 px-3.5 py-1.5 rounded-full bg-transparent border border-gray-300 dark:border-slate-600 text-gray-700 dark:text-gray-300 text-xs">Clear filters</button>
          </div>
        ) : filtered.map((m, idx) => (
          <Fragment key={m.id}>
            {farmAbroadStart != null && idx === farmAbroadStart && <AbroadSectionDivider />}
            <MemberCard
              m={m}
              dib={dibsByEnemyId[m.id]}
              currentUserId={currentUserId}
              myBattleStats={myBattleStats}
              onClaim={onClaim}
              onRelease={onRelease}
              note={memberNotes[m.id]}
              canEditNote={canEditNotes}
              onSaveNote={onSaveNote}
            />
          </Fragment>
        ))}
        <div className="mt-1 text-[11px] text-gray-400 text-center px-3 py-2">
          Showing {filtered.length} of {members.length} · {paused ? 'Static snapshot' : 'Live'}
        </div>
      </div>

      <FilterSheet
        open={filterOpen} onClose={() => setFilterOpen(false)}
        statusFilter={statusFilter} toggleStatus={toggleStatus}
        activityFilter={activityFilter} toggleActivity={toggleActivity}
        ffMaxOnly={ffMaxOnly} setFfMaxOnly={setFfMaxOnly} ffUsable={ffUsable}
        statsEnabled={statsEnabled} setStatsEnabled={setStatsEnabled}
        statsMin={statsMin} setStatsMin={setStatsMin}
        statsMax={statsMax} setStatsMax={setStatsMax}
        sortBy={sortBy} setSortBy={setSortBy}
        sortDir={sortDir} setSortDir={setSortDir}
        onClear={clearFilters}
      />
      <LeadershipSheet
        open={leaderOpen} onClose={() => setLeaderOpen(false)}
        paused={paused}
        reviveServices={reviveServices}
        activeReviveName={activeReviveName}
        onPickReviveService={onPickReviveService}
        onTogglePaused={onTogglePaused}
        onUpdateSpies={onUpdateSpies}
        updatingSpies={updatingSpies}
        spiesMsg={spiesMsg}
        tornstatsMaxAgeDays={tornstatsMaxAgeDays}
        onChangeTornstatsMaxAge={onChangeTornstatsMaxAge}
        factionId={factionId}
        onSetFactionId={onSetFactionId}
        onClearState={onClearState}
      />

      {/* First-open spotlight pass for the mobile layout (#153). */}
      {tourActive && (
        <SpotlightTour
          steps={tourStepsFor('mobile')}
          onFinish={() => { markTourSeen('mobile'); setTourActive(false) }}
        />
      )}
    </div>
  )
}
