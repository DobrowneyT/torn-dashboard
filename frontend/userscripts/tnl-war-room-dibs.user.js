// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.28.0
// @description  War Room dibs, battle stats, live status and roster intel on the Torn faction pages.
// @author       TNL
// @match        https://www.torn.com/factions.php*
// @run-at       document-end
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.torn.com
// @connect      monchoon.me
// @updateURL    https://files.monchoon.me/scripts/tnl-war-room-dibs.user.js
// @downloadURL  https://files.monchoon.me/scripts/tnl-war-room-dibs.user.js
// ==/UserScript==

/** Dibs, on the Torn war page itself (#487). */

const TNLDibs = (function () {
  'use strict'

  const TENANTS_URL = 'https://files.monchoon.me/scripts/tenants.json'
  const STORE_KEY = 'tnl-dibs-session'
  /** Reconnect backoff, ms — caps rather than growing without bound. */
  const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
  const BADGE_CLASS = 'tnl-dibs-badge'
  /** FF at which a target is worth pulling the eye across the table. */
  const FF_HIGHLIGHT = 2.5
  const DEBUG_KEY = 'tnl-dibs-debug'
  const SETTING_STATS = 'tnl-dibs-show-stats'
  const SETTING_FF_BOX = 'tnl-dibs-ff-box'
  /** #515 — rewrite Torn's Status cell: hospital countdown, travel ETA, last action. */
  const SETTING_STATUS = 'tnl-dibs-status'
  /** #525 — tint the member's name by activity. */
  const SETTING_TINT = 'tnl-dibs-tint'
  /** Warline-style online/idle count on the Members header. */
  const SETTING_MEMBER_COUNT = 'tnl-dibs-member-count'

  /** User settings (#514). */
  const SETTING_DEFAULTS = {
    [SETTING_STATS]: true,
    [SETTING_FF_BOX]: true,
    [SETTING_STATUS]: true,
    [SETTING_TINT]: true,
    [SETTING_MEMBER_COUNT]: true,
    [DEBUG_KEY]: false,
  }

  /** Is a setting on? */
  function settingOn(raw, key) {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return SETTING_DEFAULTS[key] ?? false
  }

  const settings = {
    on(key) {
      try { return settingOn(GM_getValue(key, null), key) } catch { return SETTING_DEFAULTS[key] ?? false }
    },
    set(key, value) { GM_setValue(key, value ? 'true' : 'false') },
  }

  /** The settings that change what a row LOOKS like, as a string. */
  function settingsSignature() {
    return `${settings.on(SETTING_STATS) ? 1 : 0}${settings.on(SETTING_FF_BOX) ? 1 : 0}`
  }

  /** Everything about a row that is visible, as one short string. */
  function paintSignature(state, stats, settingsSig, mineTotal) {
    return [
      state?.label, state?.action, state?.mine ? 1 : 0, state?.taken ? 1 : 0,
      stats?.total ?? '', stats?.str ?? '', stats?.def ?? '', stats?.spd ?? '', stats?.dex ?? '',
      stats?.source ?? '', stats?.spiedAt ?? '',
      mineTotal ?? '',
      settingsSig,
    ].join('|')
  }
  /** Read cadence — see the transport note above for why this is a poll. */
  const POLL_MS = 3000
  const POLL_HIDDEN_MS = 10000

  // ── Debug ────────────────────────────────────────────────────────────────

  /** Verbose tracing, off by default. */
  function debugOn() {
    return settings.on(DEBUG_KEY)
  }

  /** A URL with any token or key stripped, safe to print. */
  function redactUrl(url) {
    if (typeof url !== 'string') return String(url)
    return url.replace(/([?&](?:token|key|apiKey)=)[^&]*/gi, '$1REDACTED')
  }

  function log(...args) {
    if (!debugOn()) return
    // eslint-disable-next-line no-console
    console.log('[TNL Dibs]', ...args)
  }

  // ── Pure helpers (unit-tested — see __tests__/tnlDibs.test.js) ────────────

  /** The Torn user id in a profile link, or null. */
  function parseXid(href) {
    if (typeof href !== 'string') return null
    const parts = href.split('?XID=')
    if (parts.length !== 2) return null
    const id = parseInt(parts[1], 10)
    return Number.isFinite(id) && id > 0 ? id : null
  }

  /** Which tenant host serves this faction, or null when it is not one of ours. */
  function resolveTenant(map, factionId) {
    if (!map || factionId === null || factionId === undefined) return null
    const host = map[String(factionId)]
    return typeof host === 'string' && host.length > 0 ? host : null
  }

  /** Fold dib rows into "who holds what". */
  function indexDibs(rows, into) {
    const byTarget = into ?? new Map()
    for (const row of rows ?? []) {
      const targetId = Number(row.target_id)
      if (!Number.isFinite(targetId) || targetId <= 0) continue
      if (row.deleted_at) byTarget.delete(targetId)
      else byTarget.set(targetId, { by: Number(row.claimed_by), name: row.claimed_name })
    }
    return byTarget
  }

  /** The row array out of one channel of a socket frame. */
  function frameRows(channel) {
    if (Array.isArray(channel)) return channel
    return Array.isArray(channel?.rows) ? channel.rows : []
  }

  /** A stat total, formatted EXACTLY as the War Room formats it. */
  function formatStat(n) {
    if (n === null || n === undefined) return '???'
    const v = Number(n)
    if (!Number.isFinite(v)) return '???'
    if (v >= 1_000_000_000_000) return (v / 1_000_000_000_000).toFixed(2) + 'T'
    if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + 'B'
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M'
    if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K'
    return String(v)
  }

  /** A Postgres timestamp, parsed. */
  function parseDbTime(ts) {
    if (!ts) return null
    let str = String(ts)
    str = str.replace(/([+-]\d{2})$/, '$1:00')
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) str += 'Z'
    const d = new Date(str)
    return Number.isNaN(d.getTime()) ? null : d
  }

  /** Relative age, or an em dash. */
  function fmtAgo(ts, nowMs = Date.now()) {
    const d = parseDbTime(ts)
    if (!d) return '—'
    const diff = Math.floor((nowMs - d.getTime()) / 1000)
    if (diff < 60) return 'just now'
    if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
    return `${Math.floor(diff / 86_400)}d ago`
  }

  /** Which source a figure came from. */
  function statsSourceLabel(source) {
    return { torn: 'OWN', tornstats: 'TS', bsp: 'BSP' }[source] ?? 'BSP'
  }

  /** Which single stat dominates a build, or null for a balanced one. */
  function dominantStat(stats, threshold = 0.33) {
    const total = Number(stats?.total)
    if (!Number.isFinite(total) || total <= 0) return null
    const named = [
      ['str', Number(stats.str)], ['def', Number(stats.def)],
      ['spd', Number(stats.spd)], ['dex', Number(stats.dex)],
    ].filter(([, v]) => Number.isFinite(v) && v > 0)
    if (named.length === 0) return null
    const [name, value] = named.reduce((a, b) => (b[1] > a[1] ? b : a))
    return value >= threshold * total ? name : null
  }

  /** Battle-stat score: the sum of square ROOTS, not of the stats. */
  function statScore(stats) {
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : null
    }
    const s = num(stats?.str), sp = num(stats?.spd)
    const d = num(stats?.def), dx = num(stats?.dex)
    if (s !== null && sp !== null && d !== null && dx !== null) {
      return Math.sqrt(s) + Math.sqrt(sp) + Math.sqrt(d) + Math.sqrt(dx)
    }
    const total = num(stats?.total)
    return total === null ? null : 2 * Math.sqrt(total)
  }

  /** FF for hitting `defender`, given our own stats. */
  function fairFight(mine, theirs) {
    const attacker = statScore(mine)
    const defender = statScore(theirs)
    if (attacker === null || defender === null || attacker <= 0) return null
    return Math.min(3, 1 + (8 / 3) * (defender / attacker))
  }

  /**
   * A stat total in at most 5 characters: 1.23B, 12.3B, 123B.
   *
   * Three significant digits, so the width is fixed whatever the magnitude.
   * ⚠️ This is NOT formatStat() and must not replace it — formatStat is kept
   * byte-identical to the dashboard's formatStats() so the two screens never
   * disagree, and it is what the tooltip still shows. This one is for the
   * column, where five characters is all there is.
   */
  function formatStatShort(n) {
    if (n === null || n === undefined) return '???'
    const v = Number(n)
    if (!Number.isFinite(v)) return '???'
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'], [1, '']]
    for (let i = 0; i < units.length; i++) {
      const [scale, suffix] = units[i]
      if (Math.abs(v) < scale) continue
      const x = v / scale
      const ax = Math.abs(x)
      const digits = ax >= 100 ? 0 : ax >= 10 ? 1 : 2
      const rounded = Number(x.toFixed(digits))
      // ⚠️ Rounding can carry into the next unit — 999.6M is 1.00B, not 1000M,
      // which would be six characters and the wrong number.
      if (Math.abs(rounded) >= 1000 && i > 0) {
        const [upScale, upSuffix] = units[i - 1]
        return Number((v / upScale).toFixed(2)).toFixed(2) + upSuffix
      }
      return suffix === '' ? String(Math.round(v)) : rounded.toFixed(digits) + suffix
    }
    return String(Math.round(v))
  }

  /** Torn's direct-attack URL for a player. */
  function attackUrl(playerId) {
    const id = Number(playerId)
    if (!Number.isFinite(id) || id <= 0) return null
    return `https://www.torn.com/page.php?sid=attack&user2ID=${id}`
  }

  /**
   * The stat tooltip, stacked the way the War Room's BattleStatsCell stacks it:
   * one line per stat, Total on its own line, source last.
   */
  function statsTip(stats, ff) {
    if (!stats || stats.total === null) return 'No battle stats on record'
    // padEnd/padStart, with `white-space: pre` on the tooltip, is what keeps the
    // two columns aligned without a table.
    const line = (label, value) => `${label.padEnd(5)}${String(value).padStart(9)}`
    const rule = '─'.repeat(14)
    const out = [line('FF', ff === null || ff === undefined ? '—' : ff.toFixed(2)), rule]
    for (const [label, v] of [['STR', stats.str], ['DEF', stats.def], ['SPD', stats.spd], ['DEX', stats.dex]]) {
      if (v !== null && v !== undefined) out.push(line(label, formatStat(v)))
    }
    if (out.length > 2) out.push(rule)
    out.push(line('Total', formatStat(stats.total)))
    out.push(rule)
    out.push(`${fmtAgo(stats.spiedAt)} (${statsSourceLabel(stats.source)})`)
    if (stats.source === 'torn') out.push('Exact — from their own key')
    return out.join('\n')
  }

  /** The battle stats carried on a war_room_state_v2 row. */
  function rowStats(row) {
    if (!row) return null
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const isTs = row.spy_source === 'tornstats'
    return {
      total: num(row.bsp_total),
      str: num(row.bsp_str),
      spd: num(row.bsp_spd),
      def: num(row.bsp_def),
      dex: num(row.bsp_dex),
      source: row.spy_source ?? null,
      spiedAt: (isTs && row.ts_spy_at) ? row.ts_spy_at : (row.bsp_fetched_at ?? row.ts_spy_at ?? null),
    }
  }

  /** Member ids that are NOT ours. */
  function enemyIds(stateRows, ourFactionId, opponentId) {
    const out = new Set()
    for (const row of stateRows ?? []) {
      if (row.deleted_at) continue
      if (String(row.faction_id) === String(ourFactionId)) continue
      if (opponentId != null && String(row.faction_id) !== String(opponentId)) continue
      out.add(Number(row.member_id))
    }
    return out
  }

  /** The faction our war room is currently pointed at, from the config channel. */
  function opponentFrom(configRows) {
    for (const row of configRows ?? []) {
      if (row?.faction_id !== null && row?.faction_id !== undefined) return String(row.faction_id)
    }
    return null
  }

  /** How long to wait before the next poll. */
  function pollDelay(hidden) {
    return hidden ? POLL_HIDDEN_MS : POLL_MS
  }

  /** The claims carried in our session token. */
  function tokenClaims(token) {
    if (typeof token !== 'string') return {}
    const body = token.split('.')[1]
    if (!body) return {}
    try {
      // base64url → base64, then decode. atob rejects the URL alphabet.
      const b64 = body.replace(/-/g, '+').replace(/_/g, '/')
      return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) ?? {}
    } catch { return {} }
  }

  /** Can this session take a dib off someone else? */
  function sessionIsAdmin(session) {
    return tokenClaims(session?.token).is_admin === true
  }

  /** What the control should say and do, given who holds the target. */
  function buttonState(dib, currentUserId, isAdmin = false) {
    const id = dib?.by ?? dib?.claimed_by
    if (id === null || id === undefined) {
      return { label: 'Dibs', action: 'claim', mine: false, taken: false }
    }
    const name = dib?.name ?? dib?.claimed_name ?? null
    if (String(id) === String(currentUserId)) {
      return { label: 'Yours', action: 'release', mine: true, taken: true }
    }
    return {
      label: name ?? 'Claimed',
      action: isAdmin ? 'release' : 'none',
      mine: false,
      taken: true,
    }
  }

  /** Backoff for the nth consecutive failed read (0-based). */
  function backoffFor(attempt) {
    return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)]
  }

  /** Does the stored session belong to whoever is logged into this tab? */
  function identityMatches(sessionUserId, pageUserId) {
    if (!sessionUserId || !pageUserId) return true
    return String(sessionUserId) === String(pageUserId)
  }

  // ── Roster intelligence (#525, #515) ─────────────────────────────────────

  /** Torn's published flight-time variance: up to ±3%. */
  const TRAVEL_VARIANCE = 0.03

  /** Flight times in seconds, by destination and method. */
  const FLIGHT_SECONDS = {
    'mexico':          { standard: 1440, airstrip: 1020, wlt:  720, business:  420 },
    'cayman islands':  { standard: 1980, airstrip: 1380, wlt: 1020, business:  600 },
    'canada':          { standard: 2340, airstrip: 1620, wlt: 1140, business:  720 },
    'hawaii':          { standard: 7620, airstrip: 5340, wlt: 3780, business: 2280 },
    'united kingdom':  { standard: 9060, airstrip: 6360, wlt: 4500, business: 2700 },
    'argentina':       { standard: 9480, airstrip: 6660, wlt: 4740, business: 2820 },
    'switzerland':     { standard: 9960, airstrip: 6960, wlt: 4980, business: 3000 },
    'japan':           { standard: 12780, airstrip: 8940, wlt: 6420, business: 3840 },
    'china':           { standard: 13740, airstrip: 9600, wlt: 6840, business: 4140 },
    'uae':             { standard: 15420, airstrip: 10800, wlt: 7680, business: 4620 },
    'south africa':    { standard: 16920, airstrip: 11820, wlt: 8460, business: 5100 },
  }

  /** Fastest to slowest — elimination and band-building both rely on this order. */
  const TRAVEL_METHODS = ['business', 'wlt', 'airstrip', 'standard']

  /** `status.plane_image_type` → travel method. */
  const PLANE_TYPE_METHOD = { airliner: 'business', light_aircraft: 'airstrip', private_jet: 'wlt' }

  /** Destination names Torn uses in more than one form. */
  const DESTINATION_ALIASES = {
    'united arab emirates': 'uae',
    'uk': 'united kingdom',
    'great britain': 'united kingdom',
    'cayman': 'cayman islands',
  }

  /** Substring → short code, in match order. */
  const COUNTRY_NEEDLES = [
    ['south africa', 'SA'], ['south african', 'SA'],
    ['china', 'CN'], ['chinese', 'CN'],
    ['japan', 'JP'], ['japanese', 'JP'],
    ['hawaii', 'HAW'], ['hawaiian', 'HAW'],
    ['argentin', 'ARG'],
    ['cayman', 'CAY'],
    ['canad', 'CAN'],
    ['switz', 'SWI'], ['swiss', 'SWI'],
    ['emirat', 'UAE'], ['uae', 'UAE'],
    ['united kingdom', 'UK'], ['british', 'UK'],
    ['mexic', 'MX'],
  ]

  /** The short code for whichever country a status description names, or null. */
  function countryCode(text) {
    const d = String(text ?? '').toLowerCase()
    if (!d) return null
    for (const [needle, code] of COUNTRY_NEEDLES) if (d.includes(needle)) return code
    return null
  }

  function normaliseCountry(name) {
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  }

  /** The country whose flight time applies, or null. */
  function travelDestination(description) {
    const d = String(description ?? '')
    let candidate = null
    const between = d.match(/^Traveling from (.+) to (.+)$/i)
    if (between) {
      const [, from, to] = between
      candidate = normaliseCountry(to) === 'torn' ? from : to
    } else {
      const to = d.match(/^Traveling to (.+)$/i)
      const back = d.match(/^Returning (?:to Torn )?from (.+)$/i)
      candidate = to?.[1] ?? back?.[1] ?? null
    }
    if (candidate == null) return null
    const key = normaliseCountry(candidate)
    const resolved = DESTINATION_ALIASES[key] ?? key
    return FLIGHT_SECONDS[resolved] ? resolved : null
  }

  /** Which way they are pointed: 'out' abroad, 'back' to Torn, 'in' already there. */
  function travelPhase(description) {
    const d = String(description ?? '')
    if (/^Returning/i.test(d) || / to Torn$/i.test(d)) return 'back'
    if (/^Traveling/i.test(d)) return 'out'
    if (/^In /i.test(d)) return 'in'
    return null
  }

  /** Candidate methods for an aircraft type — all four when we can't tell. */
  function methodsForPlaneType(planeType) {
    const known = PLANE_TYPE_METHOD[planeType]
    return known ? [known] : [...TRAVEL_METHODS]
  }

  /** Estimated arrival for a traveller. */
  function travelEta({ description, planeType, departedAt, nowMs = Date.now() } = {}) {
    const destination = travelDestination(description)
    const parsed = departedAt ? parseDbTime(departedAt) : null
    const departed = parsed ? parsed.getTime() : NaN
    if (!destination || !Number.isFinite(departed)) return { state: 'unknown' }

    const times = FLIGHT_SECONDS[destination]
    const elapsed = (nowMs - departed) / 1000
    if (elapsed < 0) return { state: 'unknown' }

    const surviving = methodsForPlaneType(planeType)
      .filter((m) => times[m] * (1 + TRAVEL_VARIANCE) >= elapsed)
    if (surviving.length === 0) return { state: 'overdue' }

    const durations = surviving.map((m) => times[m])
    const earliest = Math.min(...durations) * (1 - TRAVEL_VARIANCE)
    const latest = Math.max(...durations) * (1 + TRAVEL_VARIANCE)
    return {
      state: 'estimate',
      methods: TRAVEL_METHODS.filter((m) => surviving.includes(m)),
      earliestSec: Math.max(0, Math.round(earliest) - Math.round(elapsed)),
      latestSec: Math.max(0, Math.round(latest) - Math.round(elapsed)),
    }
  }

  /** A duration as a countdown: 1h23m over an hour, 45m12s under it, 9s at the end. */
  function fmtCountdown(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    return `${s}s`
  }

  /** An ETA band, compacted for a cell that has room for about six characters. */
  function fmtEtaShort(eta) {
    if (!eta || eta.state === 'unknown') return null
    if (eta.state === 'overdue') return 'land'
    const mid = (eta.earliestSec + eta.latestSec) / 2
    return `~${fmtCountdown(mid)}`
  }

  /** How long since their last action, at a glance: 3m, 2h, 4d. */
  function fmtLastActionShort(lastAction, nowMs = Date.now()) {
    const ts = Number(lastAction?.timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return null
    const diff = Math.max(0, Math.floor(nowMs / 1000 - ts))
    if (diff < 60) return `${diff}s`
    if (diff < 3600) return `${Math.floor(diff / 60)}m`
    if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
    return `${Math.floor(diff / 86_400)}d`
  }

  /** Activity, as a tone name. */
  function activityTone(state) {
    const s = String(state?.last_action?.status ?? '').toLowerCase()
    if (s === 'online') return 'online'
    if (s === 'idle') return 'idle'
    if (s === 'offline') return 'offline'
    return null
  }

  /** Who can actually revive this member right now: 'anyone' | 'friends' | null. */
  function reviveAudience(state) {
    if (!state?.is_revivable) return null
    const setting = state.revive_setting
    if (setting === 'No one') return null
    if (setting === 'Friends & faction') return 'friends'
    return 'anyone'
  }

  /** Everything the Status cell should say for one member, or null when we know nothing and Torn's own… */
  function statusView(entry, nowMs = Date.now()) {
    const st = entry?.status
    const kind = st?.state
    if (!kind) return null

    if (kind === 'Hospital' || kind === 'Jail') {
      const untilSec = Number(st.until)
      if (!Number.isFinite(untilSec) || untilSec <= 0) return null
      const left = untilSec - Math.floor(nowMs / 1000)
      if (left <= 0) return { kind: 'okay', text: 'Okay', tone: 'okay', title: st.description ?? '' }
      const clock = fmtCountdown(left)
      const code = kind === 'Hospital' ? countryCode(st.description) : null
      return {
        kind: kind === 'Jail' ? 'jail' : 'hospital',
        text: code ? `${code}:${clock}` : clock,
        tone: kind === 'Jail' ? 'jail' : 'hospital',
        title: st.description ?? '',
      }
    }

    if (kind === 'Traveling') {
      const code = countryCode(st.description) ?? '??'
      const phase = travelPhase(st.description)
      const eta = fmtEtaShort(travelEta({
        description: st.description,
        planeType: st.plane_image_type ?? st.plane_type,
        departedAt: entry.travel_departed_at,
        nowMs,
      }))
      const label = phase === 'back' ? `${code}>` : `>${code}`
      return {
        kind: 'traveling',
        text: eta ? `${label} ${eta}` : label,
        tone: 'traveling',
        title: eta ? `${st.description ?? 'Traveling'} — landing in about ${eta.replace('~', '')}` : (st.description ?? 'Traveling'),
      }
    }

    if (kind === 'Abroad') {
      const code = countryCode(st.description)
      return { kind: 'abroad', text: code ? `In ${code}` : 'Abroad', tone: 'abroad', title: st.description ?? '' }
    }

    if (kind === 'Okay') {
      const ago = fmtLastActionShort(entry.last_action, nowMs)
      const audience = reviveAudience(entry)
      const glyph = audience === 'anyone' ? ' 💉' : audience === 'friends' ? ' 💉' : ''
      return {
        kind: 'okay',
        text: `${ago ?? 'Okay'}${glyph}`,
        tone: 'okay',
        title: [
          entry.last_action?.status ? `${entry.last_action.status}${ago ? ` — last action ${ago} ago` : ''}` : null,
          audience === 'anyone' ? 'Revivable — a hired reviver can bring them up'
            : audience === 'friends' ? 'Revivable by their friends & faction only' : null,
          entry.is_on_wall ? 'Defending a territory wall' : null,
          entry.has_early_discharge ? 'Early discharge available' : null,
        ].filter(Boolean).join('\n'),
      }
    }
    return null
  }

  /** Sort rank for a status: lower is more attackable. */
  const STATUS_RANK = { okay: 0, hospital: 1, jail: 2, traveling: 3, abroad: 4 }

  function statusSortValue(entry, nowMs = Date.now()) {
    const view = statusView(entry, nowMs)
    if (!view) return null
    const rank = STATUS_RANK[view.kind] ?? 5
    const until = Number(entry?.status?.until)
    return rank * 1e11 + (Number.isFinite(until) && until > 0 ? until : 0)
  }

  /** Order rows for our sort control. */
  function sortEntries(entries, dir) {
    const missing = (v) => v === null || v === undefined || !Number.isFinite(Number(v))
    return [...(entries ?? [])].sort((a, b) => {
      const am = missing(a.value), bm = missing(b.value)
      if (am && bm) return a.pos - b.pos
      if (am) return 1
      if (bm) return -1
      const diff = (Number(a.value) - Number(b.value)) * (dir < 0 ? -1 : 1)
      return diff === 0 ? a.pos - b.pos : diff
    })
  }

  /**
   * Click cycle for a sort header: descending, then ascending, then back.
   *
   * Two states, not three. A third "off" step means two of every three clicks
   * land somewhere you did not want, and Torn's original order is not a thing
   * anyone sorts back to on purpose — you leave a sort by choosing another
   * column.
   */
  function nextSort(current, key) {
    if (current?.key !== key) return { key, dir: -1 }
    return { key, dir: current.dir === -1 ? 1 : -1 }
  }

  /** The war_room_state_v2 fields we keep, flattened. */
  function rowState(row) {
    if (!row) return null
    const s = row.state ?? {}
    return {
      last_action: s.last_action ?? null,
      status: s.status ?? null,
      is_revivable: Boolean(s.is_revivable),
      has_early_discharge: Boolean(s.has_early_discharge),
      is_in_oc: Boolean(s.is_in_oc),
      is_on_wall: Boolean(s.is_on_wall),
      revive_setting: s.revive_setting ?? null,
      travel_departed_at: row.travel_departed_at ?? null,
    }
  }

  // ── Transport ────────────────────────────────────────────────────────────

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      const xhr = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
        || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest)
      if (!xhr) return reject(new Error('GM.xmlHttpRequest unavailable'))
      const started = Date.now()
      const method = opts.method || 'GET'
      log(`→ ${method} ${redactUrl(opts.url)}`)
      xhr({
        method,
        url: opts.url,
        headers: opts.headers || {},
        data: opts.body,
        onload: (res) => {
          let parsed = null
          try { parsed = JSON.parse(res.responseText) } catch { /* not json */ }
          log(`← ${res.status} ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          resolve({ status: res.status, body: parsed })
        },
        onerror: () => {
          log(`✗ failed ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          reject(new Error(`request failed: ${redactUrl(opts.url)}`))
        },
        ontimeout: () => {
          log(`✗ timed out ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          reject(new Error(`request timed out: ${redactUrl(opts.url)}`))
        },
      })
    })
  }

  const store = {
    read() { try { return JSON.parse(GM_getValue(STORE_KEY, 'null')) } catch { return null } },
    write(v) { GM_setValue(STORE_KEY, JSON.stringify(v)) },
    clear() { GM_setValue(STORE_KEY, 'null') },
  }

  /** Key → faction → tenant → JWT. */
  async function establishSession(apiKey) {
    const who = await gmRequest({
      url: `https://api.torn.com/v2/key/info?key=${encodeURIComponent(apiKey)}&comment=TNLDibs`,
    })
    if (who.body?.error) throw new Error(`Torn rejected the key: ${who.body.error.error}`)
    const info = who.body?.info
    if (!info?.user) throw new Error('Torn returned no key info — is the key correct?')
    if (Number(info.access?.level ?? 0) < 3) {
      throw new Error('That is not a Limited Access key. Generate one in Torn and use that.')
    }
    const factionId = info.user.faction_id
    if (!factionId) throw new Error('Torn reports no faction for that key.')

    const tenants = await gmRequest({ url: TENANTS_URL })
    const host = resolveTenant(tenants.body, factionId)
    if (!host) throw new Error(`Faction ${factionId} has no TNL dashboard.`)

    const login = await gmRequest({
      method: 'POST',
      url: `https://${host}/api/auth/login`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey, require_enrolled: true }),
    })
    if (login.status !== 200 || !login.body?.token) {
      throw new Error(login.body?.error || `Login failed (HTTP ${login.status})`)
    }
    // The key goes out of scope here. Only the token is persisted.
    const session = {
      host,
      token: login.body.token,
      expiresAt: login.body.expires_at,
      userId: String(info.user.id ?? ''),
      factionId: String(factionId),
    }
    store.write(session)
    return session
  }

  // ── Runtime ──────────────────────────────────────────────────────────────

  const rt = {
    session: null,
    dibs: new Map(),        // targetId → { by, name }
    enemies: new Set(),     // member ids not in our faction
    nodes: new Map(),       // playerId → Set<HTMLElement> anchors to badge
    ourFactionId: null,
    attempt: 0,          // consecutive failed polls, for backoff
    status: 'idle',
    expanded: false,        // the panel collapses to a dot once signed in
    settingsOpen: false,    // the expanded panel is showing settings (#514)
    painted: -1,            // last counts logged, so render() is not spammy
    attached: -1,
    opponentId: null,       // the faction the war room is pointed at
    since: null,            // delta watermark, always the server's own clock
    polling: false,
    timer: null,            // pending poll, so visibilitychange can pre-empt it
    poke: null,             // runs a poll now; set once the loop is running
    inFlight: false,        // a read is out; a second loop must not start
    pending: false,         // someone asked to read while one was in flight
    stats: new Map(),       // memberId → battle stats, straight off the roster
    mine: null,             // our own stats, so FF needs no second source
    isAdmin: false,         // UI affordance only; the server decides
    state: new Map(),       // memberId → rowState(): status, last action, revive (#525)
    mstats: new Map(),      // memberId → energy + cooldowns. LEAD-ONLY, OURS-ONLY.
    sort: { key: null, dir: 0 },  // our sort control; null means Torn's own order
    sorted: false,          // a sort is currently applied to the DOM
    rowH: null,             // Torn's row height, measured once
    tick: null,             // the 1 Hz countdown timer
  }

  /** The logged-in Torn user, read from the page's own sidebar profile link. */
  function pageUserId() {
    const link = document.querySelector('#sidebarroot a[href*="profiles.php?XID="], .sidebar a[href*="profiles.php?XID="]')
    return link ? parseXid(link.getAttribute('href')) : null
  }

  function rawApi(path, method, body) {
    return gmRequest({
      method,
      url: `https://${rt.session.host}${path}`,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${rt.session.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  /** Trade a stale token for a fresh one. */
  async function refreshToken() {
    log('token is stale — refreshing')
    const res = await gmRequest({
      method: 'POST',
      url: `https://${rt.session.host}/api/auth/refresh`,
      headers: { authorization: `Bearer ${rt.session.token}` },
    })
    if (res.status !== 200 || !res.body?.token) {
      log(`refresh failed (${res.status}) — signing out`)
      store.clear()
      rt.session = null
      setStatus('auth')
      panel()
      return false
    }
    rt.session = { ...rt.session, token: res.body.token, expiresAt: res.body.expires_at }
    store.write(rt.session)
    log('token refreshed')
    return true
  }

  /** An authenticated call, with one automatic retry after a refresh. */
  async function api(path, method, body, retried = false) {
    const res = await rawApi(path, method, body)
    if (res.status === 401 && !retried && rt.session) {
      if (await refreshToken()) return api(path, method, body, true)
    }
    return res
  }

  async function claim(targetId) {
    const res = await api('/api/war-room/dibs', 'POST', { target_id: targetId })
    if (res.status === 409) {
      const owner = res.body?.owner
      if (owner) rt.dibs.set(targetId, { by: owner.id, name: owner.name })
      render()
      return { ok: false, message: res.body?.error || 'Already claimed' }
    }
    if (res.status !== 200) return { ok: false, message: res.body?.error || `HTTP ${res.status}` }

    for (const [target, dib] of rt.dibs) {
      if (String(dib.by) === String(rt.session?.userId)) rt.dibs.delete(target)
    }
    rt.dibs.set(targetId, { by: rt.session?.userId, name: 'You' })
    pokePoll()
    return { ok: true }
  }

  async function release(targetId) {
    const res = await api(`/api/war-room/dibs/${targetId}`, 'DELETE')
    if (res.status !== 200) {
      return { ok: false, message: res.body?.message ?? res.body?.error ?? `HTTP ${res.status}` }
    }
    rt.dibs.delete(targetId)     // optimistic; covers an admin override too
    pokePoll()
    return { ok: true }
  }

  /** Read again immediately instead of waiting out the scheduled poll. */
  function pokePoll() {
    if (!rt.polling || !rt.poke) return
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null }
    rt.poke()
  }

  /** Fold one full set of channels — a socket snapshot or a poll response — into the runtime. */
  function applyChannels(body) {
    const stateRows = frameRows(body?.state)
    const dibRows = frameRows(body?.dibs)
    const opponent = opponentFrom(frameRows(body?.config))

    if (opponent !== null && opponent !== rt.opponentId) {
      log(`opponent is now faction ${opponent} (was ${rt.opponentId ?? 'unknown'}) — resetting`)
      rt.opponentId = opponent
      rt.enemies = new Set()
      rt.dibs = new Map()
    }

    indexDibs(dibRows, rt.dibs)
    for (const id of enemyIds(stateRows, rt.ourFactionId, rt.opponentId)) rt.enemies.add(id)

    for (const row of stateRows) {
      const id = Number(row.member_id)
      if (!Number.isFinite(id) || id <= 0) continue
      const stats = rowStats(row)
      if (stats) {
        rt.stats.set(id, stats)
        if (String(id) === String(rt.session?.userId)) rt.mine = stats
      }
      const st = rowState(row)
      if (st) rt.state.set(id, st)
    }
    for (const row of stateRows) {
      if (!row.deleted_at) continue
      const id = Number(row.member_id)
      rt.enemies.delete(id)
      rt.state.delete(id)
    }

    for (const row of frameRows(body?.memberstats)) {
      const id = Number(row.member_id)
      if (Number.isFinite(id) && id > 0) rt.mstats.set(id, row)
    }
    log(`${stateRows.length} roster rows, ${dibRows.length} dib rows →`,
      `${rt.enemies.size} enemies, ${rt.dibs.size} live claims`,
      `(opponent ${rt.opponentId ?? 'unknown'})`)
    render()
  }

  /** One poll of the REST read path, over the privileged transport. */
  async function pollOnce() {
    const path = rt.since
      ? `/api/war-room/delta?since=${encodeURIComponent(rt.since)}`
      : '/api/war-room/delta'
    const res = await api(path, 'GET')
    if (res.status === 401 || res.status === 403) {
      setStatus('auth')
      return false
    }
    if (res.status !== 200 || !res.body) {
      setStatus('reconnecting')
      log(`read failed: HTTP ${res.status}`)
      throw new Error(`HTTP ${res.status}`)   // transient: caught, backed off, retried
    }
    applyChannels(res.body)
    rt.since = res.body.server_now ?? rt.since
    setStatus('live')
    return true
  }

  function startPolling() {
    if (rt.polling) return
    rt.polling = true
    setStatus('connecting')
    log(`reading ${rt.session.host} every ${POLL_MS}ms`)
    const tick = async () => {
      rt.timer = null
      if (rt.inFlight) { rt.pending = true; return }
      rt.inFlight = true
      let ok = false
      let keepGoing = true
      try {
        keepGoing = await pollOnce()
        ok = keepGoing
      } catch (err) {
        setStatus('reconnecting')
        log('poll failed:', err.message)
      }
      rt.inFlight = false
      if (!keepGoing) { rt.polling = false; return }

      if (rt.pending) { rt.pending = false; rt.timer = setTimeout(tick, 0); return }

      const hidden = typeof document !== 'undefined' && document.hidden
      if (ok) rt.attempt = 0
      const wait = ok ? pollDelay(hidden) : Math.max(backoffFor(rt.attempt++), pollDelay(hidden))
      rt.timer = setTimeout(tick, wait)
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || !rt.polling) return
        log('tab visible again — reading now')
        if (rt.timer) { clearTimeout(rt.timer); rt.timer = null }
        tick()
      })
    }

    rt.poke = tick
    tick()
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  /** The battle-stats cell's own width, in px — enough for a 5-char reading like "21.5B". */
  const BS_WIDTH = 48
  /** The dibs control's own width, fixed so its left edge never moves. */
  const DIBS_WIDTH = 46
  /** Badge cap. Fits "Yours"; longer holder names ellipsis, tooltip has the rest. */
  const BADGE_MAX = 44
  /** Below this the stats column is hidden and only dibs survives. */
  const NARROW_PX = 1000
  /** Shared marker for both of our header cells (bold weight, isOurs() detection). */
  const COL_HEAD_CLASS = 'tnl-col-head'
  const DIBS_CLASS = 'tnl-col-dibs'
  /** Badge state classes — see paintDibs(). */
  const MINE_CLASS = 'tnl-mine'
  const TAKEN_CLASS = 'tnl-taken'
  const BS_CLASS = 'tnl-col-bs'
  const STAT_VALUE_CLASS = 'tnl-col-bsv'
  const STYLE_ID = 'tnl-dibs-style'
  const TIP_ID = 'tnl-dibs-tip'
  const NO_BS_CLASS = 'tnl-no-bs'
  /** Our entry point in Torn's own page-title links, beside Faction Warfare. */
  const LAUNCHER_ID = 'tnl-war-room-link'
  const LAUNCHER_LABEL_ID = 'tnl-war-room-label'
  const LAUNCHER_NAME = 'Torn War Room'
  /** Warline-style online/idle badge on the "Members" header — colour and class. */
  const MEMBER_COUNT_COLOR = '#0b8a0b'
  const MEMBER_COUNT_CLASS = 'tnl-member-count'
  /** Set on a name wrap once we have confirmed a text version exists to show. */
  const PLAIN_NAME_CLASS = 'tnl-plain-name'
  /** Set on <html> while we own activity colour, so Torn's own dot can go. */
  const TINTING_CLASS = 'tnl-tinting'
  /** Column hairline. Semi-transparent grey so it reads on Torn's light and dark. */
  const RULE = 'rgba(128,128,128,.35)'
  /** Marks a name we have tinted, so the tint can be lifted cleanly (#525). */
  const TINT_CLASS = 'tnl-tint'
  /** Marks a Status cell we have taken over (#515). */
  const STATUS_CLASS = 'tnl-status'
  /** A header cell bound to our sort control. */
  const SORT_CLASS = 'tnl-sort'

  /** Activity colours. */
  const TINT_GRADIENTS = {
    online: 'linear-gradient(to bottom, #A3DA00, #648600)',
    idle: 'linear-gradient(to bottom, #FBB904, #B65F01)',
    offline: 'linear-gradient(to bottom, #C6C6C6, #737373)',
  }
  const TINT_COLORS = { online: '#8CBF00', idle: '#D89400', offline: '#9ca3af' }

  /** Status-cell tones. */
  const STATUS_COLORS = {
    okay: '#9ca3af', hospital: '#f87171', jail: '#fb923c',
    traveling: '#60a5fa', abroad: '#22d3ee',
  }

  /** One stylesheet, injected once. */
  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
/* ⚠️ The header, the list AND each row are flex — all three, or none.
   Torn lays rows out with floats (its cells carry a "left" class), but the
   cells we inject are not floated, and non-floated content does not sit in
   DOM order relative to floats — it flows around them. Leave the row on
   floats and our BS cell renders after Score no matter where in the DOM it
   sits, while a flex header honours DOM order and shows it before Score:
   two layout models, two different column orders, same markup. Floats also
   wrap the overflow onto a second line instead of overflowing, which is the
   row-splitting this fixes. Sorting appeared to help only because the sort
   permutation forced the list into flex as a side effect. */
.white-grad, .table-header, [class*="tableHeader"] {
  display: flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  width: 100% !important;
}
ul.members-list, .table-body {
  display: flex !important;
  flex-direction: column !important;
  width: 100% !important;
}
ul.members-list > li, .table-body > .table-row {
  display: flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  width: 100% !important;
  position: relative;
}
/* Torn's float-clearing spacers would each take a flex slot of their own. */
ul.members-list > li > .clear, .white-grad > .clear { display: none !important; }

/* The name column takes whatever the fixed columns leave, and never pushes
   them off the row — min-width:0 is what lets a long name ellipsis instead
   of forcing the row wider than it has. */
.members-cont [class*="member___"], .white-grad > [class*="member___"] {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
}
/* The header's name cell also carries the online/idle badge — keep the label,
   the sort arrow and the badge on one line instead of stacking them. */
.white-grad > [class*="member___"] {
  display: flex !important;
  align-items: center !important;
  white-space: nowrap !important;
}

.members-cont .level {
  width: 27px !important; max-width: 27px !important; flex: 0 0 27px !important;
  margin: 0 !important; padding: 0 2px !important;
  box-sizing: border-box !important; overflow: hidden !important;
}

/* Battle stats sit between Level and Score — a decision column, read before the
   score/status/attack housekeeping to its right. */
.${BS_CLASS} {
  width: ${BS_WIDTH}px; min-width: ${BS_WIDTH}px; max-width: ${BS_WIDTH}px;
  flex: 0 0 ${BS_WIDTH}px;
  display: inline-flex; align-items: center; justify-content: flex-end;
  height: var(--tnl-row-h, 32px);
  box-sizing: border-box; padding: 0 2px;
  border-left: 1px solid ${RULE};
  font-size: 11px; font-weight: 700; text-align: right;
  font-variant-numeric: tabular-nums;
  vertical-align: middle; white-space: nowrap;
  position: relative; z-index: 1;
}
.${COL_HEAD_CLASS} { font-weight: 700; opacity: .85; }
/* "BS" reads as a label and should sit centered, not right-aligned like the
   numbers below it — the header cell carries both classes at once now. */
.${COL_HEAD_CLASS}.${BS_CLASS} { justify-content: center; text-align: center; }
/* The border hugs the number itself, not the full row height — a fixed-height
   box around one line of 11px text read as "wrong size", and any mismatch
   between this height and Torn's real row height clipped it besides. */
.${STAT_VALUE_CLASS} {
  display: inline-block; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 3px;
  box-sizing: border-box;
}

.members-cont .status, .white-grad > .status {
  width: 66px !important; max-width: 66px !important; flex: 0 0 66px !important;
  margin: 0 !important; padding: 0 2px !important;
  border: 0 !important; border-left: 1px solid ${RULE} !important;
  box-sizing: border-box !important; overflow: hidden !important;
}

.${DIBS_CLASS} {
  width: ${DIBS_WIDTH}px; min-width: ${DIBS_WIDTH}px; max-width: ${DIBS_WIDTH}px;
  flex: 0 0 ${DIBS_WIDTH}px;
  display: inline-flex; align-items: center; justify-content: center;
  height: var(--tnl-row-h, 32px);
  box-sizing: border-box; padding: 0 4px;
  border-left: 1px solid ${RULE};
  vertical-align: middle; white-space: nowrap;
  position: relative; z-index: 1;
}

#${TIP_ID} {
  position: fixed; left: 0; top: 0; display: none;
  z-index: 2147483647; pointer-events: none;
  white-space: pre; text-align: left; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; font-weight: 400;
  padding: 8px 10px; border-radius: 8px;
  background: #4b5563; color: #f3f4f6;
  border: 1px solid #6b7280; box-shadow: 0 8px 24px rgba(0,0,0,.5);
}

.${BADGE_CLASS} {
  position: relative; z-index: 2147483000; isolation: isolate; pointer-events: auto;
  display: inline-block; box-sizing: border-box;
  width: auto; min-width: 30px; max-width: ${BADGE_MAX}px;
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 1px solid rgba(255,255,255,.3); border-radius: 10px;
  font-size: 10px; font-weight: 700; line-height: 15px;
  text-align: center; color: #fff; cursor: pointer;
  background: #374151;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background .15s ease;
}
.${BADGE_CLASS}:hover { background: #4b5563; }
.${BADGE_CLASS}.${MINE_CLASS} { background: #1d4ed8; }
.${BADGE_CLASS}.${MINE_CLASS}:hover { background: #2563eb; }
.${BADGE_CLASS}.${TAKEN_CLASS} { background: #c2410c; cursor: default; }
.${BADGE_CLASS}.${TAKEN_CLASS}:hover { background: #c2410c; }

.members-cont [class*="points___"]:not([class*="tab___"]),
.white-grad > [class*="points___"] {
  width: 44px !important; max-width: 44px !important; flex: 0 0 44px !important;
  margin: 0 !important; padding: 0 2px !important;
  border: 0 !important; border-left: 1px solid ${RULE} !important;
  box-sizing: border-box !important; overflow: hidden !important; text-overflow: ellipsis !important;
}

.members-cont .attack, .members-cont [class*="attack___"],
.white-grad > .attack, .white-grad > [class*="attack___"] {
  width: 30px !important; max-width: 30px !important; flex: 0 0 30px !important;
  margin: 0 !important; padding: 0 2px !important;
  border: 0 !important; border-left: 1px solid ${RULE} !important;
  box-sizing: border-box !important; overflow: hidden !important;
}

/* The honor bar is an <img>; the name also ships as a plain <span class="honor-text">
   next to a per-character SVG twin. Hide the image and the twin, show the text. */
.${PLAIN_NAME_CLASS} img { display: none !important; }
.${PLAIN_NAME_CLASS} .honor-text-svg { display: none !important; }
.${PLAIN_NAME_CLASS} .honor-text:not(.honor-text-svg) {
  display: inline !important;
  visibility: visible !important; opacity: 1 !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
  font-size: 11px !important; font-weight: 600 !important;
  line-height: 1.2 !important; text-align: left !important;
  white-space: nowrap !important;
  /* text-fill-color WINS over color, and Torn sets it transparent for the
     honor gradient — setting colour alone leaves the name invisible. */
  background: none !important;
  -webkit-background-clip: border-box !important;
  background-clip: border-box !important;
  color: var(--tnl-tint, #e5e7eb) !important;
  -webkit-text-fill-color: var(--tnl-tint, #e5e7eb) !important;
  text-shadow: none !important;
}
.${PLAIN_NAME_CLASS} {
  width: auto !important; min-width: 0 !important;
  justify-content: flex-start !important; text-align: left !important;
  padding: 0 !important;
}
a.${TINT_CLASS}, .${TINT_CLASS} > a { color: var(--tnl-tint) !important; }

/* The dot and the faction tag both go: the name carries activity now, and in a
   two-faction war view the tag says nothing.
   ⚠️ There is no width-reclaim margin here any more, and there must not be one.
   Hiding the icons used to leave a hole the float layout could not reabsorb, so
   the name column was pulled back over it by a hardcoded -46px. Under flex the
   name column is flex:1 1 auto and simply takes the freed space by itself — and
   a negative margin now does real damage, dragging the next column into an
   overlap rather than closing a gap. */
html.${TINTING_CLASS} [class*="userStatusWrap___"],
html.${TINTING_CLASS} [class*="factionWrap___"] { display: none !important; }

.${STATUS_CLASS} {
  color: var(--tnl-status) !important;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.${SORT_CLASS} { cursor: pointer; user-select: none; }
.${SORT_CLASS}:hover { text-decoration: underline; }

html.${NO_BS_CLASS} .${BS_CLASS} { display: none; }

@media screen and (max-width: ${NARROW_PX}px) {
  .${BS_CLASS} { display: none; }
}

.${MEMBER_COUNT_CLASS} {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 700;
  font-size: 12px;
  vertical-align: middle;
  color: ${MEMBER_COUNT_COLOR};
  background: ${MEMBER_COUNT_COLOR}1f;
}
`
    ;(document.head || document.documentElement).appendChild(el)
    log('stylesheet injected')
  }

  /** The row an anchor belongs to. */
  function rowOf(anchor) {
    return anchor.closest?.('li, tr') ?? anchor.closest?.('[class*="row___"]') ?? null
  }

  /** The Attack cell — the anchor our column is inserted before. */
  function attackCellOf(row) {
    return row?.querySelector?.('.attack, [class*="attack__"], [class*="attack___"]') ?? null
  }

  /** The header row of the table a war row belongs to. */
  function headerFor(row) {
    const list = row.closest('ul, table')
    if (!list) return null
    const prev = list.previousElementSibling
    if (prev && prev.querySelector('.attack, [class*="attack__"]')) return prev
    return list.querySelector('.table-header, [class*="tableHeader"], thead') ?? null
  }

  /** The cell in a header that belongs to the Attack column. */
  function attackHeaderCell(header) {
    if (!header) return null
    const direct = header.querySelector('.attack, [class*="attack__"], [class*="attack___"]')
    if (direct) return direct
    for (const cell of header.children) {
      if ((cell.textContent || '').trim().toLowerCase() === 'attack') return cell
    }
    return null
  }

  /** The row/header's own Score cell — the anchor the BS column is inserted before. */
  function scoreCellOf(scope) {
    return scope?.querySelector?.('[class*="points___"]') ?? null
  }

  /** True for anything this script put on the page — see observe(). */
  function isOurs(node) {
    return Boolean(node?.closest?.(`.${DIBS_CLASS}, .${BS_CLASS}, #${STYLE_ID}, #${LAUNCHER_ID}`))
  }

  function slot(parent, cls, text) {
    let el = parent.querySelector(`.${cls}`)
    if (el) return el
    el = document.createElement('span')
    el.className = cls
    if (text) el.textContent = text
    parent.appendChild(el)
    return el
  }

  /** Replace a header cell's own label text, leaving any child icon (e.g. the
   *  native sort arrow) untouched — a blind `.textContent =` would eat it. */
  function relabelHeaderText(cell, from, to) {
    if (!cell) return
    for (const node of cell.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim() === from) { node.textContent = to; return }
      // "Members" ships wrapped in a <span> of its own, where Level and Attack
      // are bare text — match a leaf element too, never a container.
      if (node.nodeType === 1 && node.children.length === 0
          && (node.textContent || '').trim() === from) {
        node.textContent = to
        return
      }
    }
  }

  /**
   * Both of our cells for one row — dibs (before Attack) and battle stats
   * (before Score) — plus the matching header cells, built once per table.
   */
  function ensureColumns(row) {
    let dibsCell = row.querySelector(`.${DIBS_CLASS}`)
    let bsCell = row.querySelector(`.${BS_CLASS}`)
    if (dibsCell && bsCell) return { dibsCell, bsCell }

    const header = headerFor(row)
    if (header && !header.querySelector(`.${COL_HEAD_CLASS}`)) {
      const attackHead = attackHeaderCell(header)
      const bsHead = document.createElement(header.tagName.toLowerCase() === 'ul' ? 'li' : 'div')
      bsHead.className = `table-cell ${COL_HEAD_CLASS} ${BS_CLASS}`
      bindSort(bsHead, 'bs', 'BS')
      const scoreHead = scoreCellOf(header)
      if (scoreHead) scoreHead.parentNode.insertBefore(bsHead, scoreHead)
      else header.appendChild(bsHead)

      const dibsHead = document.createElement(header.tagName.toLowerCase() === 'ul' ? 'li' : 'div')
      dibsHead.className = `table-cell ${COL_HEAD_CLASS} ${DIBS_CLASS}`
      dibsHead.textContent = 'DIBS'
      if (attackHead) attackHead.parentNode.insertBefore(dibsHead, attackHead)
      else header.appendChild(dibsHead)
      log('column headers added (BS before Score, Dibs before Attack)')
    }

    if (!bsCell) {
      bsCell = document.createElement(row.tagName.toLowerCase() === 'li' ? 'span' : 'div')
      bsCell.className = `table-cell ${BS_CLASS}`
      slot(bsCell, STAT_VALUE_CLASS)
      const score = scoreCellOf(row)
      if (score) score.parentNode.insertBefore(bsCell, score)
      else row.insertBefore(bsCell, row.querySelector('.clear'))
    }
    if (!dibsCell) {
      dibsCell = document.createElement(row.tagName.toLowerCase() === 'li' ? 'span' : 'div')
      dibsCell.className = `table-cell ${DIBS_CLASS}`
      const attack = attackCellOf(row)
      if (attack) attack.parentNode.insertBefore(dibsCell, attack)
      else row.insertBefore(dibsCell, row.querySelector('.clear'))   // never after the float clear
    }
    return { dibsCell, bsCell }
  }

  function badgeFor(cell, playerId) {
    let badge = cell.querySelector(`.${BADGE_CLASS}`)
    if (badge) return badge

    badge = document.createElement('button')
    badge.type = 'button'
    badge.className = BADGE_CLASS
    badge.dataset.tnlTarget = String(playerId)
    badge.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation()
      const state = buttonState(rt.dibs.get(playerId), rt.session?.userId, rt.isAdmin)
      if (state.action === 'none') return
      badge.disabled = true
      badge.textContent = '…'
      const res = state.action === 'claim' ? await claim(playerId) : await release(playerId)
      badge.disabled = false
      if (!res.ok) badge.title = res.message
      // The signature is stale by definition after a write — force the repaint.
      delete cell.dataset.tnlSig
      render()
    })
    cell.appendChild(badge)
    return badge
  }

  /** Colour for the stat that dominates a build. */
  const STAT_COLORS = { str: '#ef4444', def: '#22c55e', spd: '#60a5fa', dex: '#f59e0b' }

  /** Three states, three readings at a glance, and no lock icon — the colour is the state (#512). */
  function paintDibs(badge, state) {
    if (!badge) return
    badge.textContent = state.label
    badge.classList.toggle(MINE_CLASS, Boolean(state.mine))
    badge.classList.toggle(TAKEN_CLASS, Boolean(state.taken) && !state.mine)
    badge.title = state.mine
      ? 'Yours — click to release'
      : state.taken
        ? `Claimed by ${state.label}${state.action === 'release' ? ' — click to release (admin)' : ''}`
        : 'Claim this target'
  }

  /** Paint one member's stats, the way the War Room paints them. */
  /** Where a cursor-anchored tooltip should sit: below-right, kept on screen. */
  function tipPosition(x, y, tipW, tipH, viewW, viewH, offset = 14) {
    const left = x + offset + tipW > viewW ? Math.max(0, x - offset - tipW) : x + offset
    const top = y + offset + tipH > viewH ? Math.max(0, y - offset - tipH) : y + offset
    return { left, top }
  }

  function tipNode() {
    let el = document.getElementById(TIP_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = TIP_ID
      el.setAttribute('role', 'tooltip')
      document.body.appendChild(el)
    }
    return el
  }

  function showTip(text, x, y) {
    const el = tipNode()
    if (el.textContent !== text) el.textContent = text
    el.style.display = 'block'
    const { left, top } = tipPosition(
      x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight
    )
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }

  function hideTip() {
    const el = document.getElementById(TIP_ID)
    if (el) el.style.display = 'none'
  }

  function statValueOf(slotEl, playerId) {
    let v = slotEl.querySelector(`.${STAT_VALUE_CLASS}`)
    if (!v) {
      v = document.createElement('span')
      v.className = STAT_VALUE_CLASS
      slotEl.appendChild(v)
    }
    // Bound once per row, never per poll.
    if (!v.dataset.tnlAtk) {
      v.dataset.tnlAtk = '1'
      // Clicking the total opens the attack page, as Wall Battlestats does.
      v.addEventListener('click', (e) => {
        const url = attackUrl(Number(v.dataset.tnlTarget))
        if (!url) return
        e.preventDefault(); e.stopPropagation()
        window.open(url, '_blank', 'noopener')
      })
      const move = (e) => {
        const tip = slotEl.dataset.tnlTip
        if (tip) showTip(tip, e.clientX, e.clientY)
      }
      v.addEventListener('mouseenter', move)
      v.addEventListener('mousemove', move)
      v.addEventListener('mouseleave', hideTip)
    }
    v.dataset.tnlTarget = String(playerId)
    return v
  }

  function paintStats(slotEl, playerId) {
    if (!slotEl) return
    const cell = statValueOf(slotEl, playerId)
    if (!settings.on(SETTING_STATS)) {
      cell.textContent = ''
      slotEl.removeAttribute('data-tnl-tip')
      cell.style.border = '1px solid transparent'
      return
    }
    const stats = rt.stats.get(playerId)
    const ff = fairFight(rt.mine, stats)
    slotEl.dataset.tnlTip = statsTip(stats, ff)

    if (!stats || stats.total === null) {
      cell.textContent = '???'
      cell.style.color = '#6b7280'
      cell.style.fontStyle = 'italic'
      cell.style.textDecoration = 'none'
      cell.style.border = '1px solid transparent'
      return
    }

    cell.style.fontStyle = 'normal'
    cell.textContent = formatStatShort(stats.total)
    const dominant = dominantStat(stats)
    cell.style.color = dominant ? STAT_COLORS[dominant] : '#e5e7eb'

    const exact = stats.source === 'torn'
    cell.style.textDecoration = 'underline'
    cell.style.textDecorationStyle = exact ? 'solid' : 'dotted'
    cell.style.textUnderlineOffset = '2px'
    cell.style.textDecorationColor = exact ? 'rgba(16,185,129,.7)' : 'rgba(148,163,184,.7)'

    cell.style.border = settings.on(SETTING_FF_BOX) && ff !== null && ff >= FF_HIGHLIGHT
      ? '1px solid #86efac'
      : '1px solid transparent'
  }

  /** Relabel Torn's Attack button to "Atk" — it buys about 30px per row. */
  function shrinkAttack(row) {
    if (row._tnlAtk) return
    row._tnlAtk = true
    const attack = attackCellOf(row)
    if (!attack || attack.dataset.tnlAtk) return
    for (const el of [attack, ...attack.querySelectorAll('span, a')]) {
      if ((el.textContent || '').trim() === 'Attack' && el.children.length === 0) {
        el.textContent = 'Atk'
        attack.dataset.tnlAtk = '1'
        return
      }
    }
  }

  /** A row we are willing to touch. */
  function isMemberRow(row) {
    const tag = row?.tagName?.toLowerCase?.()
    if (tag !== 'li' && tag !== 'tr') return false
    return Boolean(row.querySelector(
      '.status, [class*="status___"], [class*="status__"], .level, [class*="level___"]'
    ))
  }

  /** Torn's own Status cell for a row. */
  function statusCellOf(row) {
    const cached = row?._tnlStatusCell
    if (cached && cached.isConnected) return cached
    const el = row?.querySelector?.('.status, [class*="status___"], [class*="status__"]') ?? null
    if (row) row._tnlStatusCell = el
    return el
  }

  /** What TORN says this member's status is — the authority (#515). */
  function tornStatusKind(cell) {
    const c = String(cell?.className ?? '').toLowerCase()
    const t = String(cell?.dataset?.tnlTorn ?? '').toLowerCase().trim()
    const has = (w) => c.includes(w) || t.includes(w)
    if (has('hospital') || has('hosp')) return 'hospital'
    if (has('federal') || has('jail')) return 'jail'
    if (has('travel')) return 'traveling'
    if (has('abroad') || /^in [a-z]/.test(t)) return 'abroad'
    if (has('okay')) return 'okay'
    return null
  }

  /** Remember what Torn had in the cell before we touched it. */
  function rememberTornStatus(cell) {
    const shown = (cell.textContent ?? '').trim()
    if (shown !== cell.dataset.tnlWrote) cell.dataset.tnlTorn = shown
    return cell.dataset.tnlTorn ?? ''
  }

  /** Hand the cell back to Torn, exactly as we found it. */
  function releaseStatusCell(cell) {
    if (!cell || !cell.dataset.tnlWrote) return
    if ((cell.textContent ?? '').trim() === cell.dataset.tnlWrote) {
      cell.textContent = cell.dataset.tnlTorn ?? ''
    }
    cell.classList.remove(STATUS_CLASS)
    cell.style.removeProperty('--tnl-status')
    delete cell.dataset.tnlWrote
    delete cell.dataset.tnlStatusSig
  }

  /** Energy and cooldowns, for the tooltip only. */
  function memberStatsNote(playerId) {
    const m = rt.mstats.get(playerId)
    if (!m) return []
    const out = []
    if (m.energy_current !== null && m.energy_current !== undefined) {
      out.push(`Energy ${m.energy_current}/${m.energy_maximum ?? '?'}`)
    }
    const cd = (label, secs) => {
      const n = Number(secs)
      if (!Number.isFinite(n) || n <= 0) return
      out.push(`${label} ${fmtCountdown(n)}`)
    }
    cd('Drug CD', m.cooldown_drug)
    cd('Medical CD', m.cooldown_medical)
    cd('Booster CD', m.cooldown_booster)
    const od = parseDbTime(m.overdose_until)
    if (od && od.getTime() > Date.now()) out.push('☠ Overdosed')
    return out
  }

  /** Rewrite Torn's Status cell with the live countdown / ETA / last action. */
  function paintStatus(row, playerId, nowMs) {
    const cell = statusCellOf(row)
    if (!cell) return false
    if (!settings.on(SETTING_STATUS)) { releaseStatusCell(cell); return false }

    rememberTornStatus(cell)
    const entry = rt.state.get(playerId)
    const view = entry ? statusView(entry, nowMs) : null
    if (!view) { releaseStatusCell(cell); return false }

    const theirs = tornStatusKind(cell)
    if (theirs && theirs !== view.kind) { releaseStatusCell(cell); return false }

    const extra = memberStatsNote(playerId)
    const title = [view.title, ...extra].filter(Boolean).join('\n')
    const sig = `${view.text}|${title}`
    if (cell.dataset.tnlStatusSig === sig) return true
    cell.dataset.tnlStatusSig = sig

    cell.textContent = view.text
    cell.dataset.tnlWrote = view.text
    cell.classList.add(STATUS_CLASS)
    cell.style.setProperty('--tnl-status', STATUS_COLORS[view.tone] ?? '#9ca3af')
    if (title) cell.title = title
    return true
  }

  /** Tint the member's name by activity — the one signal that costs no width. */
  /**
   * The element that actually carries the name's colour.
   *
   * Torn paints war-list names with a gradient clipped to the glyphs
   * (`background-clip: text; color: transparent`) inside `.honor-text`, so
   * setting `color` on the anchor changes nothing visible. The gradient has to
   * be replaced instead — which means finding the honor wrap, not the link.
   * Falls back to the anchor on pages that render a plain name.
   */
  function nameTargetOf(row, anchor) {
    let el = row._tnlName
    if (el && el.isConnected) return el
    el = row.querySelector('.honor-text-wrap, [class*="honorWrap___"]') ?? anchor
    row._tnlName = el
    return el
  }

  /**
   * Is there a NON-EMPTY text twin we can show in place of the honor image?
   *
   * ⚠️ Non-empty is the whole point. Testing that the element merely exists is
   * what blanked every name on the page: the node is present but carries no
   * text, so hiding the image left nothing behind it.
   */
  function hasPlainName(wrap) {
    const t = wrap?.querySelector?.('.honor-text:not(.honor-text-svg)')
    return Boolean(t && (t.textContent || '').trim())
  }

  /**
   * Torn's row height, measured once — the rows are a FLOAT layout, so there is
   * nothing to align our column against otherwise.
   */
  function measureRow(row) {
    if (rt.rowH !== null) return
    const h = Math.round(row.getBoundingClientRect().height)
    if (h > 0) {
      rt.rowH = h
      document.documentElement.style.setProperty('--tnl-row-h', `${h}px`)
    }
  }

  function paintName(row, anchor, playerId) {
    const el = nameTargetOf(row, anchor)
    const tone = settings.on(SETTING_TINT) ? activityTone(rt.state.get(playerId)) : null
    if ((el.dataset.tnlTint ?? '') === (tone ?? '')) return
    if (!tone) {
      // Hand the row back exactly as Torn built it: honor bar, dot and all.
      delete el.dataset.tnlTint
      el.removeAttribute('data-tnl-activity')
      el.style.removeProperty('--tnl-tint')
      el.style.removeProperty('--tnl-tint-bg')
      el.classList.remove(TINT_CLASS)
      el.classList.remove(PLAIN_NAME_CLASS)
      return
    }
    el.dataset.tnlTint = tone
    el.dataset.tnlActivity = tone
    el.style.setProperty('--tnl-tint', TINT_COLORS[tone])
    el.style.setProperty('--tnl-tint-bg', TINT_GRADIENTS[tone])
    el.classList.add(TINT_CLASS)
    // Swap the honor bar for text ONLY where there is text to swap to.
    if (hasPlainName(el)) el.classList.add(PLAIN_NAME_CLASS)
  }

  // ── Sorting ──────────────────────────────────────────────────────────────

  /** The member a row is about, or null for a header / spacer / advert. */
  function idOfRow(row) {
    const a = row?.querySelector?.('a[href*="profiles.php?XID="]')
    return a ? parseXid(a.getAttribute('href')) : null
  }

  /** The number our current sort key ranks a member by, or null when unknown. */
  function sortValueFor(playerId, nowMs) {
    switch (rt.sort.key) {
      case 'bs': {
        const total = rt.stats.get(playerId)?.total
        return total === null || total === undefined ? null : Number(total)
      }
      case 'status': return statusSortValue(rt.state.get(playerId), nowMs)
      default: return null
    }
  }

  /** Permute one list's rows into sorted order using flex `order` — the list
   *  is a permanent flex column (see injectStyles()), so no display toggling
   *  is needed here, only the order values themselves. */
  function orderList(list, nowMs) {
    const children = Array.from(list.children)
    if (!rt.sort.key) {
      if (!list.dataset.tnlOrderSig) return
      for (const c of children) c.style.order = ''
      delete list.dataset.tnlOrderSig
      return
    }

    const rows = []
    children.forEach((c, i) => {
      const id = idOfRow(c)
      if (id !== null) rows.push({ id, row: c, pos: i, slot: i + 1, value: sortValueFor(id, nowMs) })
    })
    if (rows.length < 2) return

    const ordered = sortEntries(rows, rt.sort.dir)
    const sig = `${rt.sort.key}:${rt.sort.dir}:${ordered.map((e) => e.id).join(',')}`
    if (list.dataset.tnlOrderSig === sig && rows[0].row.style.order !== '') return
    list.dataset.tnlOrderSig = sig

    children.forEach((c, i) => { c.style.order = String(i + 1) })
    const slots = rows.map((r) => r.slot).sort((a, b) => a - b)
    ordered.forEach((e, i) => { e.row.style.order = String(slots[i]) })
  }

  /** Apply the current sort to every member list we have rows on. */
  function applySort(nowMs = Date.now()) {
    // Nothing to do, and nothing to undo — skip the whole walk.
    if (!rt.sort.key && !rt.sorted) return
    rt.sorted = Boolean(rt.sort.key)
    const lists = new Set()
    eachRow((_id, _anchor, row) => { if (row.parentNode) lists.add(row.parentNode) })
    for (const list of lists) orderList(list, nowMs)
  }

  /** Turn a header cell into a sort control. */
  function bindSort(el, key, label) {
    if (!el || el.dataset.tnlSortKey) return
    el.dataset.tnlSortKey = key
    el.dataset.tnlSortLabel = label
    el.classList.add(SORT_CLASS)
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      rt.sort = nextSort(rt.sort, key)
      log(`sort ${rt.sort.key ?? 'off'} ${rt.sort.dir === -1 ? 'desc' : rt.sort.dir === 1 ? 'asc' : ''}`)
      paintSortHeaders()
      applySort()
    })
  }

  /** Keep every bound header's arrow in step with the one active sort. */
  function paintSortHeaders() {
    if (typeof document === 'undefined') return
    for (const el of document.querySelectorAll(`.${SORT_CLASS}`)) {
      const key = el.dataset.tnlSortKey
      const label = el.dataset.tnlSortLabel ?? ''
      const arrow = rt.sort.key !== key ? '' : rt.sort.dir === -1 ? ' ▾' : ' ▴'
      const text = `${label}${arrow}`
      if (el.textContent !== text) el.textContent = text
    }
  }

  /** Bind Torn's own Status header, so status sorting lives where it belongs. */
  function bindStatusHeader(row) {
    const list = row.parentNode
    if (!list || list.dataset.tnlHeaderBound) return
    list.dataset.tnlHeaderBound = '1'
    const header = headerFor(row)
    if (!header) return
    const cell = header.querySelector('.status, [class*="status___"], [class*="status__"]')
    if (cell && !cell.dataset.tnlSortKey) {
      bindSort(cell, 'status', (cell.textContent ?? 'Status').trim() || 'Status')
    }
  }

  /** Torn's own header labels, shortened to buy back space — both sides get
   *  this (unlike the DIBS/BS columns, which are enemy-only), once per list. */
  function relabelColumnHeaders(row) {
    const list = row.parentNode
    if (!list || list.dataset.tnlLabelsBound) return
    list.dataset.tnlLabelsBound = '1'
    const header = headerFor(row)
    if (!header) return
    relabelHeaderText(attackHeaderCell(header), 'Attack', 'Atk')
    relabelHeaderText(header.querySelector('.level, [class*="level___"]'), 'Level', 'Lv')
    // "Name" is what the column holds, and the width it gives back is what the
    // online/idle badge sits in.
    relabelHeaderText(header.querySelector('.member, [class*="member___"]'), 'Members', 'Name')
  }

  /** Both war member lists currently on the page — enemy and own. */
  function memberLists() {
    return typeof document === 'undefined'
      ? []
      : Array.from(document.querySelectorAll('ul.members-list, ul[class*="membersCont"]'))
  }

  /** Online / idle / offline across a set of member states. */
  function tallyActivity(states) {
    const out = { online: 0, idle: 0, offline: 0 }
    for (const state of states) {
      const tone = activityTone(state)
      if (tone !== null) out[tone] += 1
    }
    return out
  }

  /** The badge's text: online leads, idle only when there is some. */
  function countLabel({ online, idle }) {
    return `${online} online` + (idle ? ` / ${idle} idle` : '')
  }

  /** The full breakdown, including the offline count the badge never shows. */
  function countTooltip({ online, idle, offline }) {
    return `${online} online, ${idle} idle, ${offline} offline`
  }

  /**
   * One side's tally, taken from the ROSTER rather than the rendered rows.
   *
   * ⚠️ Counting `list.children` — the obvious implementation, and the one this
   * replaced — only ever sees what Torn has painted, so it silently undercounts
   * anything paginated, virtualised or collapsed. We already hold every member
   * of both factions in rt.state off the delta poll, so the true number costs
   * nothing extra to compute (#531).
   */
  function sideTally(wantEnemy) {
    const states = []
    for (const [id, state] of rt.state) {
      if (rt.enemies.has(id) !== wantEnemy) continue
      states.push(state)
    }
    return tallyActivity(states)
  }

  /**
   * Which faction a member list belongs to: true enemy, false ours, null when
   * the page does not say. Torn marks the two panels, and each row carries its
   * own side class as a second opinion — which side is ours comes from the
   * roster, never from left/right, since either faction can be on either side.
   */
  function listIsEnemy(list) {
    if (list.closest?.('.enemy-faction')) return true
    if (list.closest?.('.your-faction')) return false
    const row = list.firstElementChild
    if (row?.classList?.contains?.('enemy')) return true
    if (row?.classList?.contains?.('your')) return false
    return null
  }

  /** The header's own "Members" cell for a given member list. */
  function membersHeaderCellOf(list) {
    const anchor = list.firstElementChild
    if (!anchor) return null
    const header = headerFor(anchor)
    return header?.querySelector('.member, [class*="member___"]') ?? null
  }

  /** Warline-style "N online / M idle" badge on each faction's Members header. */
  function paintMemberCounts() {
    if (typeof document === 'undefined') return
    const on = settings.on(SETTING_MEMBER_COUNT)
    for (const list of memberLists()) {
      const cell = membersHeaderCellOf(list)
      if (!cell) continue
      if (!on) { cell.querySelector(`.${MEMBER_COUNT_CLASS}`)?.remove(); continue }
      const side = listIsEnemy(list)
      if (side === null) continue          // unlabelled panel — say nothing rather than guess
      const counts = sideTally(side)
      let badge = cell.querySelector(`.${MEMBER_COUNT_CLASS}`)
      if (!badge) {
        badge = document.createElement('span')
        badge.className = MEMBER_COUNT_CLASS
        cell.appendChild(badge)
      }
      const text = countLabel(counts)
      if (badge.textContent !== text) badge.textContent = text
      badge.title = countTooltip(counts)
      badge.style.display = counts.online + counts.idle === 0 ? 'none' : ''
    }
  }

  /**
   * The member row an anchor belongs to, cached and validated.
   *
   * rowOf() + isMemberRow() are two DOM walks, and three separate loops used to
   * run them per anchor: render() per poll, renderTimers() at 1 Hz, applySort()
   * per poll. On a 200-row table that is thousands of tree walks a second.
   */
  function rowFor(anchor) {
    const cached = anchor._tnlRow
    if (cached !== undefined && (cached === null || cached.isConnected)) return cached
    const row = rowOf(anchor)
    // No row ancestor at all (a sidebar or chat link) is a permanent fact.
    if (!row) { anchor._tnlRow = null; return null }
    if (isMemberRow(row)) { anchor._tnlRow = row; return row }
    // A row without a status or level cell yet may still be mid-build, so this
    // miss is deliberately NOT cached.
    return null
  }

  /**
   * Walk every live (player, anchor, row) on the page, pruning as it goes.
   *
   * ⚠️ The pruning is the point. scan() only ever ADDED anchors, and Torn
   * replaces rows constantly, so rt.nodes accumulated dead nodes for the life
   * of the tab — each one still costing an isConnected check on every pass of
   * all three loops. That is the slowdown.
   */
  function eachRow(fn) {
    for (const [playerId, anchors] of rt.nodes) {
      for (const anchor of anchors) {
        if (!anchor.isConnected) { anchors.delete(anchor); continue }
        const row = rowFor(anchor)
        if (row) fn(playerId, anchor, row)
      }
      if (anchors.size === 0) rt.nodes.delete(playerId)
    }
  }

  function render() {
    if (typeof document === 'undefined') return
    injectStyles()
    // Cheap by-id lookup on the hit; puts the link back after Torn re-renders
    // the page title out from under it.
    ensureLauncher()
    document.documentElement.classList.toggle(NO_BS_CLASS, !settings.on(SETTING_STATS))
    let painted = 0      // enemies we INTENDED to badge
    let attached = 0     // badges that actually exist in the DOM
    let repainted = 0    // rows whose state actually changed — see #516
    const settingsSig = settingsSignature()   // loop-invariant; read once
    const nowMs = Date.now()
    const sigs = new Map()
    eachRow((playerId, anchor, row) => {
      // ⚠️ Before anything is hidden — see measureRow().
      measureRow(row)
      const isEnemy = rt.enemies.has(playerId)
      if (!isEnemy && !rt.state.has(playerId)) return

      paintName(row, anchor, playerId)
      paintStatus(row, playerId, nowMs)
      bindStatusHeader(row)
      relabelColumnHeaders(row)
      shrinkAttack(row)
      if (!isEnemy) return

      painted++
      let entry = sigs.get(playerId)
      if (!entry) {
        const state = buttonState(rt.dibs.get(playerId), rt.session?.userId, rt.isAdmin)
        entry = { state, sig: paintSignature(state, rt.stats.get(playerId), settingsSig, rt.mine?.total) }
        sigs.set(playerId, entry)
      }
      const { dibsCell, bsCell } = ensureColumns(row)
      if (badgeFor(dibsCell, playerId)) attached++
      if (dibsCell.dataset.tnlSig === entry.sig) return
      dibsCell.dataset.tnlSig = entry.sig
      bsCell.dataset.tnlSig = entry.sig
      repainted++
      paintDibs(dibsCell.querySelector(`.${BADGE_CLASS}`), entry.state)
      paintStats(bsCell, playerId)
    })
    if (painted !== rt.painted || attached !== rt.attached) {
      rt.painted = painted
      rt.attached = attached
      log(`${attached} badges attached for ${painted} enemies on this page`,
        `(${rt.nodes.size} linked players, ${rt.enemies.size} known enemies,`,
        `${rt.stats.size} with stats)`)
    }
    if (repainted > 0) log(`repainted ${repainted} of ${attached} rows`)
    // After the loop: measureRow() has to read Torn's geometry before this
    // class hides the elements it is measuring.
    document.documentElement.classList.toggle(TINTING_CLASS, settings.on(SETTING_TINT))
    paintSortHeaders()
    applySort(nowMs)
    paintMemberCounts()
  }

  /** The 1 Hz local tick (#515). Status cells only — dibs cannot change without a poll. */
  function renderTimers() {
    if (typeof document === 'undefined' || document.hidden) return
    const nowMs = Date.now()
    eachRow((playerId, _anchor, row) => {
      if (rt.state.has(playerId)) paintStatus(row, playerId, nowMs)
    })
  }

  function startTimers() {
    if (rt.tick || typeof setInterval !== 'function') return
    rt.tick = setInterval(renderTimers, 1000)
  }

  /** Index the profile anchors under `root`. */
  function scan(root) {
    if (!root || !root.querySelectorAll) return
    const before = rt.nodes.size
    for (const anchor of root.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const id = parseXid(anchor.getAttribute('href'))
      if (id === null) continue
      if (!rt.nodes.has(id)) rt.nodes.set(id, new Set())
      rt.nodes.get(id).add(anchor)
    }
    if (rt.nodes.size !== before) log(`scan: ${rt.nodes.size - before} new players on the page`)
  }

  function observe() {
    const observer = new MutationObserver((mutations) => {
      const touched = new Set()
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && !isOurs(node)) touched.add(node)
        }
      }
      if (touched.size === 0) return
      for (const node of touched) scan(node)
      render()   // ⚠️ ONCE per batch, not once per touched node — see scan().
    })
    observer.observe(document, { childList: true, subtree: true })
    scan(document)
    render()
    startTimers()
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  let panelStatus = null
  let panelBox = null
  let panelDot = null
  let launcher = null

  /**
   * Our entry point, built to look like one of Torn's own page-title links and
   * inserted among them. It replaces the old fixed dot in the bottom-left
   * corner: the connectivity light now rides along as this link's icon, so one
   * element is both "open the panel" and "are we connected".
   *
   * Rebuilt on demand rather than once, because Torn re-renders the page title
   * on navigation and would otherwise drop it.
   */
  function ensureLauncher() {
    if (typeof document === 'undefined') return null
    const found = document.getElementById(LAUNCHER_ID)
    if (found && found.isConnected) { launcher = found; return found }

    const list = document.getElementById('top-page-links-list')
    if (!list) { launcher = null; return null }

    const link = document.createElement('a')
    link.id = LAUNCHER_ID
    link.href = '#'
    // Torn's own classes, so it inherits their type, hover and spacing.
    link.className = 't-clear h c-pointer m-icon line-h24 right'
    link.setAttribute('aria-labelledby', LAUNCHER_LABEL_ID)

    const iconWrap = document.createElement('span')
    iconWrap.className = 'icon-wrap svg-icon-wrap'
    const icon = document.createElement('span')
    icon.className = 'link-icon-svg'
    icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center'

    const dot = document.createElement('span')
    dot.style.cssText = [
      'display:inline-block', 'width:10px', 'height:10px', 'border-radius:50%',
      'border:1px solid rgba(0,0,0,.5)', 'box-shadow:0 1px 3px rgba(0,0,0,.4)',
    ].join(';')
    panelDot = dot
    icon.appendChild(dot)
    iconWrap.appendChild(icon)

    const label = document.createElement('span')
    label.id = LAUNCHER_LABEL_ID
    label.textContent = LAUNCHER_NAME

    link.appendChild(iconWrap)
    link.appendChild(label)
    link.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      rt.expanded = !rt.expanded
      rt.settingsOpen = false
      panel()
    })

    list.insertBefore(link, list.firstChild)
    launcher = link
    setStatus(rt.status)
    log('launcher added to the page-title links')
    return link
  }

  /** Sit the panel under the launcher, or fall back to the corner without one. */
  function placePanel(box) {
    box.style.position = 'fixed'
    box.style.zIndex = '2147483000'
    const anchor = launcher
    if (!anchor || !anchor.isConnected || typeof anchor.getBoundingClientRect !== 'function') {
      box.style.left = '12px'
      box.style.bottom = '12px'
      return
    }
    const r = anchor.getBoundingClientRect()
    const width = 260
    const maxLeft = Math.max(8, (window.innerWidth || width) - width - 8)
    box.style.top = `${Math.round(r.bottom + 6)}px`
    box.style.left = `${Math.round(Math.min(Math.max(8, r.left), maxLeft))}px`
  }

  /** Does the panel need to ask for a key? */
  function panelNeedsKey(session) {
    return !session || !session.token
  }

  /** Should the panel be a full box rather than a dot? */
  function panelExpanded(session, expanded) {
    if (panelNeedsKey(session)) return true
    return expanded === true
  }

  /** Wording for a status, kept pure so the vocabulary itself can be tested. */
  function statusText(state) {
    return {
      live: '● live', connecting: '○ connecting…', reconnecting: '○ reconnecting…',
      auth: '⚠ session expired', idle: '○ not connected', error: '⚠ error',
    }[state] || state
  }

  /** Dot colour for a status — the whole UI when the panel is collapsed. */
  function statusColor(state) {
    if (state === 'live') return '#22c55e'
    if (state === 'connecting' || state === 'reconnecting') return '#f59e0b'
    if (state === 'auth' || state === 'error') return '#ef4444'
    return '#6b7280'
  }

  function setStatus(state) {
    rt.status = state
    if (panelStatus) panelStatus.textContent = statusText(state)
    if (panelDot) panelDot.style.background = statusColor(state)
    if (launcher && launcher.isConnected) {
      launcher.title = `${LAUNCHER_NAME} — ${statusText(state)}`
    }
  }

  /** One labelled checkbox, persisted immediately. */
  function settingToggle(key, label, hint) {
    const wrap = document.createElement('label')
    wrap.style.cssText = 'display:flex;align-items:flex-start;gap:6px;margin-top:8px;cursor:pointer'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = settings.on(key)
    box.style.cssText = 'margin-top:2px'
    box.addEventListener('change', () => {
      settings.set(key, box.checked)
      log(`setting ${key} = ${box.checked}`)
      render()
    })
    const text = document.createElement('span')
    text.textContent = label
    if (hint) {
      const small = document.createElement('div')
      small.textContent = hint
      small.style.cssText = 'opacity:.6;font-size:11px'
      text.appendChild(small)
    }
    wrap.appendChild(box)
    wrap.appendChild(text)
    return wrap
  }

  /** The settings view (#514) — behind the panel, not on top of the war page. */
  function settingsView(box) {
    const title = document.createElement('div')
    title.textContent = 'Settings'
    title.style.cssText = 'font-weight:700;margin-bottom:2px'
    box.appendChild(title)

    box.appendChild(settingToggle(SETTING_STATS, 'Show battle stats', 'Off leaves the dibs control alone.'))
    box.appendChild(settingToggle(SETTING_FF_BOX, 'Highlight high fair fight', `A green box at FF ${FF_HIGHLIGHT} and up.`))
    box.appendChild(settingToggle(SETTING_STATUS, 'Live status column', 'Hospital countdown, travel ETA and last action, in Torn\u2019s own Status cell.'))
    box.appendChild(settingToggle(SETTING_TINT, 'Tint names by activity', 'Green online, amber idle, grey offline.'))
    box.appendChild(settingToggle(SETTING_MEMBER_COUNT, 'Online/idle count', 'A Warline-style count on each Members header.'))
    box.appendChild(settingToggle(DEBUG_KEY, 'Debug log (console)', 'Reload to trace startup.'))

    const back = document.createElement('button')
    back.textContent = 'Back'
    back.style.cssText = 'width:100%;margin-top:10px;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
    back.addEventListener('click', () => { rt.settingsOpen = false; panel() })
    box.appendChild(back)
  }

  function panel() {
    if (typeof document === 'undefined') return
    // The launcher owns the status light, so it is built (and re-built) first
    // and outlives the panel box, which comes and goes with every open/close.
    ensureLauncher()
    if (panelBox && panelBox.isConnected) panelBox.remove()
    panelBox = null
    panelStatus = null

    if (!panelExpanded(rt.session, rt.expanded)) {
      setStatus(rt.status)
      return
    }

    const box = document.createElement('div')
    panelBox = box
    box.style.cssText = [
      'background:#111827', 'color:#e5e7eb', 'border:1px solid #374151',
      'border-radius:10px', 'padding:10px 12px', 'font:12px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'max-width:260px',
    ].join(';')

    if (rt.settingsOpen) {
      settingsView(box)
      placePanel(box)
      document.body.appendChild(box)
      return
    }

    const title = document.createElement('div')
    title.textContent = LAUNCHER_NAME
    title.style.cssText = 'font-weight:700;margin-bottom:4px'
    box.appendChild(title)

    panelStatus = document.createElement('div')
    panelStatus.style.cssText = 'opacity:.8;margin-bottom:6px'
    box.appendChild(panelStatus)
    setStatus(rt.status)

    const note = document.createElement('div')
    note.style.cssText = 'opacity:.7;margin-bottom:6px'
    box.appendChild(note)

    if (panelNeedsKey(rt.session)) {
      const input = document.createElement('input')
      input.type = 'password'
      input.placeholder = 'Limited API key'
      input.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 6px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb'
      const go = document.createElement('button')
      go.textContent = 'Connect'
      go.style.cssText = 'width:100%;padding:5px;border-radius:6px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer'
      go.addEventListener('click', async () => {
        go.disabled = true; note.textContent = 'Connecting…'
        try {
          rt.session = await establishSession(input.value.trim())
          input.value = ''
          await boot()
          rt.expanded = false
          panel()
        } catch (err) {
          note.textContent = err.message
          setStatus('error')
        } finally { go.disabled = false }
      })
      note.textContent = 'Your key is used once and never stored — only the session token is.'
      box.appendChild(input)
      box.appendChild(go)
    } else {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:6px'

      const hide = document.createElement('button')
      hide.textContent = 'Hide'
      hide.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      hide.addEventListener('click', () => { rt.expanded = false; rt.settingsOpen = false; panel() })

      const out = document.createElement('button')
      out.textContent = 'Sign out'
      out.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      out.addEventListener('click', () => {
        store.clear()
        rt.session = null
        location.reload()
      })

      const who = document.createElement('div')
      who.style.cssText = 'opacity:.7;margin-bottom:6px'
      who.textContent = `Signed in as ${rt.session.userId} · ${rt.session.host}`
      box.insertBefore(who, box.lastChild)
      row.appendChild(hide)
      row.appendChild(out)
      box.appendChild(row)

      const gear = document.createElement('button')
      gear.textContent = '⚙ Settings'
      gear.style.cssText = 'width:100%;margin-top:6px;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      gear.addEventListener('click', () => { rt.settingsOpen = true; panel() })
      box.appendChild(gear)
    }

    placePanel(box)
    document.body.appendChild(box)
  }

  async function boot() {
    rt.session = rt.session || store.read()
    if (!rt.session) { log('no stored session — waiting for a key'); return }
    log(`session for ${rt.session.userId} on ${rt.session.host},`,
      `faction ${rt.session.factionId}, expires ${rt.session.expiresAt ?? 'unknown'}`)

    const mine = pageUserId()
    log(`page identity: ${mine ?? 'unreadable'}`)
    if (!identityMatches(rt.session.userId, mine)) {
      setStatus('error')
      // eslint-disable-next-line no-console
      console.warn(`[TNL Dibs] token belongs to ${rt.session.userId}, page is ${mine} — refusing to act.`)
      rt.session = null
      return
    }

    rt.ourFactionId = rt.session.factionId
    rt.isAdmin = sessionIsAdmin(rt.session)
    log(`admin: ${rt.isAdmin}`)
    startPolling()
    observe()
  }

  function main() {
    rt.session = store.read()
    const version = (typeof GM_info !== 'undefined' && GM_info.script?.version) || 'unknown'
    const path = typeof location !== 'undefined' ? location.pathname + location.search : 'unknown'
    log(`v${version} starting on ${path}`)
    panel()
    boot()
      .then(() => panel())   // reflect whatever boot() resolved the session to
      .catch((err) => {
        setStatus('error')
        // eslint-disable-next-line no-console
        console.error('[TNL Dibs]', err)
        panel()
      })
  }

  function setSession(session) { rt.session = session }
  function currentSession() { return rt.session }
  function dibsIndex() { return rt.dibs }

  return {
    setSession, currentSession, api, refreshToken, claim, release, dibsIndex,
    parseXid, resolveTenant, indexDibs, enemyIds, frameRows, buttonState, backoffFor,
    identityMatches, panelNeedsKey, panelExpanded, statusText, statusColor,
    opponentFrom, pollDelay, redactUrl, debugOn, establishSession, store, main,
    formatStat, dominantStat, statScore, fairFight, rowStats,
    parseDbTime, fmtAgo, statsSourceLabel, tokenClaims, sessionIsAdmin,
    settingOn, settings, settingsSignature, paintSignature,
    attackUrl, statsTip, injectStyles, tipPosition, formatStatShort,
    ensureLauncher, LAUNCHER_ID, LAUNCHER_NAME,
    countryCode, travelDestination, travelPhase, methodsForPlaneType, travelEta,
    fmtCountdown, fmtEtaShort, fmtLastActionShort, activityTone, reviveAudience,
    tallyActivity, countLabel, countTooltip,
    statusView, statusSortValue, sortEntries, nextSort, rowState,
    TENANTS_URL, STORE_KEY, BADGE_CLASS,
    SETTING_DEFAULTS, SETTING_STATS, SETTING_FF_BOX, SETTING_STATUS, SETTING_TINT,
    SETTING_MEMBER_COUNT, DEBUG_KEY,
    FLIGHT_SECONDS, PLANE_TYPE_METHOD,
  }
})()

if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
