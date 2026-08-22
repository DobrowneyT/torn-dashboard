// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.36.1
// @description  War Room dibs, battle stats, live status, roster intel and assist requests on the Torn faction and attack pages.
// @author       TNL
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/page.php?sid=attack*
// @run-at       document-end
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.torn.com
// @connect      monchoon.me
// @updateURL    https://files.monchoon.me/scripts/tnl-war-room-dibs.user.js
// @downloadURL  https://files.monchoon.me/scripts/tnl-war-room-dibs.user.js
// ==/UserScript==

const TNLDibs = (function () {
  'use strict'

  const TENANTS_URL = 'https://files.monchoon.me/scripts/tenants.json'
  const STORE_KEY = 'tnl-dibs-session'
  const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
  const BADGE_CLASS = 'tnl-dibs-badge'
  const FF_THRESHOLD_DEFAULT = 2.5
  const DEBUG_KEY = 'tnl-dibs-debug'
  const SETTING_STATS = 'tnl-dibs-show-stats'
  const SETTING_FF_BOX = 'tnl-dibs-ff-box'
  const SETTING_FF_THRESHOLD = 'tnl-dibs-ff-threshold'
  const SETTING_STATUS = 'tnl-dibs-status'
  const SETTING_TINT = 'tnl-dibs-tint'
  /** Warline-style online/idle count on the Members header. */
  const SETTING_MEMBER_COUNT = 'tnl-dibs-member-count'
  const SETTING_CHAIN = 'tnl-dibs-chain'
  const SETTING_DIBS_HOSPITAL_ALERT = 'tnl-dibs-hosp-alert'

  const SETTING_DEFAULTS = {
    [SETTING_STATS]: true,
    [SETTING_FF_BOX]: true,
    [SETTING_STATUS]: true,
    [SETTING_TINT]: true,
    [SETTING_MEMBER_COUNT]: true,
    [SETTING_CHAIN]: true,
    [SETTING_DIBS_HOSPITAL_ALERT]: true,
    [DEBUG_KEY]: false,
  }

  const SETTING_NUM_DEFAULTS = {
    [SETTING_FF_THRESHOLD]: FF_THRESHOLD_DEFAULT,
  }

  function settingOn(raw, key) {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return SETTING_DEFAULTS[key] ?? false
  }

  function settingNum(raw, key) {
    const dflt = SETTING_NUM_DEFAULTS[key] ?? 0
    if (raw === null || raw === undefined || raw === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? n : dflt
  }

  const settings = {
    on(key) {
      try { return settingOn(GM_getValue(key, null), key) } catch { return SETTING_DEFAULTS[key] ?? false }
    },
    set(key, value) { GM_setValue(key, value ? 'true' : 'false') },
    num(key) {
      try { return settingNum(GM_getValue(key, null), key) } catch { return SETTING_NUM_DEFAULTS[key] ?? 0 }
    },
    setNum(key, value) { GM_setValue(key, String(value)) },
  }

  function settingsSignature() {
    return `${settings.on(SETTING_STATS) ? 1 : 0}${settings.on(SETTING_FF_BOX) ? 1 : 0}${settings.num(SETTING_FF_THRESHOLD)}`
  }

  function paintSignature(state, stats, settingsSig, mineTotal) {
    return [
      // #523: mode/title distinguish an assist badge from a dibs badge that
      // happens to render the same icon/action shape (label alone is not
      // enough — two different requesters raising the same kind against the
      // same target look identical without it).
      state?.mode ?? '', state?.title ?? '',
      state?.label, state?.action, state?.mine ? 1 : 0, state?.taken ? 1 : 0,
      stats?.total ?? '', stats?.str ?? '', stats?.def ?? '', stats?.spd ?? '', stats?.dex ?? '',
      stats?.source ?? '', stats?.spiedAt ?? '',
      mineTotal ?? '',
      settingsSig,
    ].join('|')
  }
  const POLL_MS = 3000
  const POLL_HIDDEN_MS = 10000

  function debugOn() {
    return settings.on(DEBUG_KEY)
  }

  function redactUrl(url) {
    if (typeof url !== 'string') return String(url)
    return url.replace(/([?&](?:token|key|apiKey)=)[^&]*/gi, '$1REDACTED')
  }

  function log(...args) {
    if (!debugOn()) return
    // eslint-disable-next-line no-console
    console.log('[TNL Dibs]', ...args)
  }

  function parseXid(href) {
    if (typeof href !== 'string') return null
    const parts = href.split('?XID=')
    if (parts.length !== 2) return null
    const id = parseInt(parts[1], 10)
    return Number.isFinite(id) && id > 0 ? id : null
  }

  function resolveTenant(map, factionId) {
    if (!map || factionId === null || factionId === undefined) return null
    const host = map[String(factionId)]
    return typeof host === 'string' && host.length > 0 ? host : null
  }

  // ── Two @match surfaces, one script (#523) ────────────────────────────────
  //
  // The pathname/search parsing is split from the `location` read so it is
  // testable with no DOM — the same shape as everything else pure in this
  // file. Everything that assumes faction-page DOM (the MutationObserver
  // scan, injectStyles' layout overrides, the launcher/panel) MUST gate on
  // isFactionPage(); the attack-page overlay MUST gate on isAttackPage(). A
  // page that matches neither (a future @match, or a URL shape that changed
  // under us) gets NEITHER — degrade to nothing rather than guess.
  function factionPageMatch(pathname) {
    return pathname === '/factions.php'
  }

  function attackPageMatch(pathname, search) {
    // Torn retired loader.php for attacks (attackUrl() already builds a
    // page.php link, below) — this was left checking the dead path, so
    // isAttackPage() was always false and the overlay never rendered.
    if (pathname !== '/page.php') return false
    return new URLSearchParams(search ?? '').get('sid') === 'attack'
  }

  /** `user2ID` off the attack-page query string — the fight's target. */
  function attackTargetId(search) {
    const id = Number(new URLSearchParams(search ?? '').get('user2ID'))
    return Number.isFinite(id) && id > 0 ? id : null
  }

  function isFactionPage() {
    return typeof location !== 'undefined' && factionPageMatch(location.pathname)
  }

  function isAttackPage() {
    return typeof location !== 'undefined' && attackPageMatch(location.pathname, location.search)
  }

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

  /**
   * Same shape of index as indexDibs, for war_room_assists_v2 (#523) — with
   * one wrinkle dibs never has: unlike a claim, MULTIPLE requesters can hold
   * a live assist on the SAME target at once, but the badge shows only one.
   * The newest live request wins the slot, mirroring the dashboard's
   * publishAssist (frontend/src/hooks/useWarRoomSocket.js).
   *
   * ⚠️ Known first-cut gap: because this map holds only the WINNING row per
   * target (not every live row, unlike the dashboard's full versioned map),
   * a tombstone for the currently-shown requester blanks the target even if
   * a second requester's assist is still live underneath — it resurfaces on
   * the next full snapshot/reconnect, not immediately. Rare (two people
   * raising a hand on the same enemy at once) and not worth a bigger index
   * for a badge that is already expected to get a visual pass later.
   */
  function indexAssists(rows, into) {
    const byTarget = into ?? new Map()
    for (const row of rows ?? []) {
      const targetId = Number(row.target_id)
      if (!Number.isFinite(targetId) || targetId <= 0) continue
      if (row.deleted_at) {
        const cur = byTarget.get(targetId)
        if (cur && String(cur.by) === String(row.requester_id)) byTarget.delete(targetId)
        continue
      }
      const cur = byTarget.get(targetId)
      const curAt = cur ? parseDbTime(cur.at) : null
      const rowAt = parseDbTime(row.created_at)
      if (!cur || !curAt || (rowAt && rowAt > curAt)) {
        byTarget.set(targetId, {
          kind: row.kind, by: Number(row.requester_id), name: row.requester_name, at: row.created_at,
        })
      }
    }
    return byTarget
  }

  function frameRows(channel) {
    if (Array.isArray(channel)) return channel
    return Array.isArray(channel?.rows) ? channel.rows : []
  }

  /** Kept byte-identical to the dashboard's formatStats() so the two never disagree. */
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

  function parseDbTime(ts) {
    if (!ts) return null
    let str = String(ts)
    str = str.replace(/([+-]\d{2})$/, '$1:00')
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) str += 'Z'
    const d = new Date(str)
    return Number.isNaN(d.getTime()) ? null : d
  }

  function fmtAgo(ts, nowMs = Date.now()) {
    const d = parseDbTime(ts)
    if (!d) return '—'
    const diff = Math.floor((nowMs - d.getTime()) / 1000)
    if (diff < 60) return 'just now'
    if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
    return `${Math.floor(diff / 86_400)}d ago`
  }

  function statsSourceLabel(source) {
    return { torn: 'OWN', tornstats: 'TS', bsp: 'BSP' }[source] ?? 'BSP'
  }

  /** 0.33 is Wall Battlestats' whore_threshold, so our colouring matches theirs. */
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

  /** Torn's stat score: the sum of the square ROOTS, not of the stats. */
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

  /** Torn's fair-fight formula, capped at 3. */
  function fairFight(mine, theirs) {
    const attacker = statScore(mine)
    const defender = statScore(theirs)
    if (attacker === null || defender === null || attacker <= 0) return null
    return Math.min(3, 1 + (8 / 3) * (defender / attacker))
  }

  /**
   * Three significant digits, so a total is always 5 characters: 1.23B, 12.3B, 123B.
   * Not a replacement for formatStat() — that one has to keep matching the dashboard.
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
      // Rounding can carry into the next unit: 999.6M is 1.00B, not 1000M.
      if (Math.abs(rounded) >= 1000 && i > 0) {
        const [upScale, upSuffix] = units[i - 1]
        return Number((v / upScale).toFixed(2)).toFixed(2) + upSuffix
      }
      return suffix === '' ? String(Math.round(v)) : rounded.toFixed(digits) + suffix
    }
    return String(Math.round(v))
  }

  function attackUrl(playerId) {
    const id = Number(playerId)
    if (!Number.isFinite(id) || id <= 0) return null
    return `https://www.torn.com/page.php?sid=attack&user2ID=${id}`
  }

  function statsTip(stats, ff) {
    if (!stats || stats.total === null) return 'No battle stats on record'
    // padEnd/padStart plus `white-space: pre` is what aligns the columns.
    // padEnd(5) pads to 5 either way, so prefixing the dominant stat's label
    // marks it without moving the number column.
    const line = (label, value) => `${label.padEnd(5)}${String(value).padStart(9)}`
    const rule = '─'.repeat(14)
    const out = [line('FF', ff === null || ff === undefined ? '—' : ff.toFixed(2)), rule]
    const dominant = dominantStat(stats)
    for (const [key, label, v] of [['str', 'STR', stats.str], ['def', 'DEF', stats.def], ['spd', 'SPD', stats.spd], ['dex', 'DEX', stats.dex]]) {
      if (v !== null && v !== undefined) out.push(line(key === dominant ? `▸${label}` : label, formatStat(v)))
    }
    if (out.length > 2) out.push(rule)
    out.push(line('Total', formatStat(stats.total)))
    out.push(rule)
    out.push(`${fmtAgo(stats.spiedAt)} (${statsSourceLabel(stats.source)})`)
    if (stats.source === 'torn') out.push('Exact — from their own key')
    return out.join('\n')
  }

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

  function opponentFrom(configRows) {
    for (const row of configRows ?? []) {
      if (row?.faction_id !== null && row?.faction_id !== undefined) return String(row.faction_id)
    }
    return null
  }

  function pollDelay(hidden) {
    return hidden ? POLL_HIDDEN_MS : POLL_MS
  }

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

  function sessionIsAdmin(session) {
    return tokenClaims(session?.token).is_admin === true
  }

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

  /** Icon + label per assist kind (#523) — kept short, the badge is width-constrained. */
  const ASSIST_KIND_META = {
    smoke: { icon: '🚬', label: 'Smoke' },
    tear: { icon: '💨', label: 'Tear gas' },
    help: { icon: '🆘', label: 'Help' },
  }

  /**
   * Dibs badge view-model, folding in an active assist request (#523).
   *
   * MonChoon's call (2026-08-21): don't add a second indicator — conserve the
   * row's horizontal space and let the SAME badge morph. While `assist` is
   * live the badge shows the kind (icon only; who/how-long-ago lives in the
   * title) and becomes a link straight to the target's attack page instead of
   * the claim/release control. Dibs underneath is untouched — see the
   * dashboard's assistBadgeState (frontend/src/utils/assistBadge.js), which
   * this mirrors verbatim for the reason buttonState always has: a userscript
   * is one file with no build step and cannot import it.
   *
   * One seam, deliberately: this is the state→view-model half; paintDibs()
   * stays the pure paint half. A follow-up visual-only pass on the assist
   * badge is meant to touch paintDibs() alone.
   */
  function badgeState(dib, assist, targetId, currentUserId, isAdmin = false) {
    if (assist) {
      const meta = ASSIST_KIND_META[assist.kind] ?? { icon: '🆘', label: assist.kind ?? 'Assist' }
      const mine = String(assist.by) === String(currentUserId)
      const who = mine ? 'you' : (assist.name ?? 'someone')
      return {
        mode: 'assist',
        label: meta.icon,
        href: attackUrl(targetId),
        action: null,
        mine,
        taken: true,
        title: `${meta.label} requested by ${who} · ${fmtAgo(assist.at)}`,
      }
    }
    return { mode: 'dibs', href: null, ...buttonState(dib, currentUserId, isAdmin) }
  }

  function backoffFor(attempt) {
    return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)]
  }

  function identityMatches(sessionUserId, pageUserId) {
    if (!sessionUserId || !pageUserId) return true
    return String(sessionUserId) === String(pageUserId)
  }

  /** Torn's published flight-time variance: up to ±3%. */
  const TRAVEL_VARIANCE = 0.03

  /** Seconds, by destination and travel method. */
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

  const DESTINATION_ALIASES = {
    'united arab emirates': 'uae',
    'uk': 'united kingdom',
    'great britain': 'united kingdom',
    'cayman': 'cayman islands',
  }

  /** Substring → code, in match order. */
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

  function countryCode(text) {
    const d = String(text ?? '').toLowerCase()
    if (!d) return null
    for (const [needle, code] of COUNTRY_NEEDLES) if (d.includes(needle)) return code
    return null
  }

  function normaliseCountry(name) {
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  }

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

  function methodsForPlaneType(planeType) {
    const known = PLANE_TYPE_METHOD[planeType]
    return known ? [known] : [...TRAVEL_METHODS]
  }

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

  function fmtCountdown(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0))
    if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    if (s >= 60) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    return `${s}s`
  }

  function fmtEtaShort(eta) {
    if (!eta || eta.state === 'unknown') return null
    if (eta.state === 'overdue') return 'land'
    const mid = (eta.earliestSec + eta.latestSec) / 2
    return `~${fmtCountdown(mid)}`
  }

  function fmtLastActionShort(lastAction, nowMs = Date.now()) {
    const ts = Number(lastAction?.timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return null
    const diff = Math.max(0, Math.floor(nowMs / 1000 - ts))
    if (diff < 60) return `${diff}s`
    if (diff < 3600) return `${Math.floor(diff / 60)}m`
    if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
    return `${Math.floor(diff / 86_400)}d`
  }

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

  function sortEntries(entries, dir) {
    // A string value (name) is missing only when it's empty — Number('') is 0,
    // not NaN, so the numeric branch below would wrongly treat "" as sortable.
    const missing = (v) => {
      if (v === null || v === undefined) return true
      if (typeof v === 'string') return v.length === 0
      return !Number.isFinite(Number(v))
    }
    return [...(entries ?? [])].sort((a, b) => {
      const am = missing(a.value), bm = missing(b.value)
      if (am && bm) return a.pos - b.pos
      if (am) return 1
      if (bm) return -1
      const diff = typeof a.value === 'string' || typeof b.value === 'string'
        ? String(a.value).localeCompare(String(b.value)) * (dir < 0 ? -1 : 1)
        : (Number(a.value) - Number(b.value)) * (dir < 0 ? -1 : 1)
      return diff === 0 ? a.pos - b.pos : diff
    })
  }

  /** Two states, not three: a third "off" step wastes two clicks in every cycle. */
  function nextSort(current, key) {
    if (current?.key !== key) return { key, dir: -1 }
    return { key, dir: current.dir === -1 ? 1 : -1 }
  }

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

  function isHospital(entry) {
    return entry?.status?.state === 'Hospital'
  }

  function hospitalExits(myDibTargetIds, prevHospital, state) {
    const out = []
    for (const id of myDibTargetIds) {
      if (!state.has(id)) continue
      const was = prevHospital.get(id) === true
      const isNow = isHospital(state.get(id))
      if (was && !isNow) out.push(id)
    }
    return out
  }

  /** Torn's chain-bonus milestones. */
  const BONUS_HITS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]

  function nextBonusHit(current) {
    const n = Number(current)
    if (!Number.isFinite(n) || n < 0) return null
    for (const h of BONUS_HITS) if (h > n) return h
    return null
  }

  // war_room_chain_v2's timeout/cooldown are absolute epoch seconds already
  // (converted server-side in warRoomChain.ts), not Torn's raw relative ones.
  function chainSecondsLeft(chain, nowSec) {
    if (!chain) return null
    if (chain.cooldown && Number(chain.cooldown) > nowSec) return null
    const timeout = Number(chain.timeout)
    if (!Number.isFinite(timeout) || timeout <= nowSec) return null
    if ((Number(chain.current) || 0) <= 0) return null
    return timeout - nowSec
  }

  function chainDropDue(chain, nowSec, thresholdSec) {
    const left = chainSecondsLeft(chain, nowSec)
    return left != null && left > 0 && left <= thresholdSec
  }

  function chainBadgeText(chain, nowSec) {
    const current = Number(chain?.current) || 0
    if (current <= 0) return null
    const left = chainSecondsLeft(chain, nowSec)
    return `⛓${current}${left != null ? ` · ${fmtCountdown(left)}` : ''}`
  }

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

  const rt = {
    session: null,
    dibs: new Map(),        // targetId → { by, name }
    assists: new Map(),     // targetId → { kind, by, name, at } (#523)
    enemies: new Set(),     // member ids not in our faction
    nodes: new Map(),       // playerId → Set<HTMLElement> anchors to badge
    ourFactionId: null,
    attempt: 0,             // consecutive failed polls, for backoff
    status: 'idle',
    expanded: false,
    settingsOpen: false,
    painted: -1,            // last counts logged, so render() is not spammy
    attached: -1,
    opponentId: null,
    since: null,            // delta watermark, always the server's own clock
    polling: false,
    timer: null,            // pending poll, so visibilitychange can pre-empt it
    poke: null,             // runs a poll now; set once the loop is running
    inFlight: false,
    pending: false,         // someone asked to read while one was in flight
    stats: new Map(),       // memberId → battle stats
    mine: null,
    isAdmin: false,         // UI affordance only; the server decides
    state: new Map(),       // memberId → rowState()
    mstats: new Map(),      // memberId → energy + cooldowns. Lead-only, ours-only.
    sortState: new Map(),  // list element -> { key, dir } — each table sorts independently (#547)
    sorted: false,
    rowH: null,
    tick: null,
    hospitalSeen: new Map(),  // dibbed targetId → was-in-hospital, previous poll only (#526)
    chain: null,              // latest war_room_chain_v2 row, or null before the first poll (#524)
    chainOpen: false,         // the chain popover, independent of the main panel
    chainWarnedTimeout: null, // the chain.timeout we last toasted for — re-arms on a new timeout
    feedbackOpen: false,
  }

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
    rt.dibs.delete(targetId)   // optimistic; covers an admin override too
    pokePoll()
    return { ok: true }
  }

  // ── Assist requests (#523) ─────────────────────────────────────────────
  // Written from the attack-page overlay; read on both surfaces.
  async function requestAssist(targetId, kind) {
    const res = await api('/api/war-room/assist', 'POST', { target_id: targetId, kind })
    if (res.status !== 200) return { ok: false, message: res.body?.error || `HTTP ${res.status}` }
    // One live assist per requester, same rule the server enforces — mirror it
    // optimistically so a switch from one kind/target to another does not
    // flash the old badge before the next poll lands.
    for (const [target, a] of rt.assists) {
      if (String(a.by) === String(rt.session?.userId)) rt.assists.delete(target)
    }
    rt.assists.set(targetId, { kind, by: rt.session?.userId, name: 'You', at: new Date().toISOString() })
    pokePoll()
    return { ok: true }
  }

  async function clearAssist(targetId) {
    const res = await api(`/api/war-room/assist/${targetId}`, 'DELETE')
    if (res.status !== 200) {
      return { ok: false, message: res.body?.message ?? res.body?.error ?? `HTTP ${res.status}` }
    }
    rt.assists.delete(targetId)   // optimistic; covers an admin override too
    pokePoll()
    return { ok: true }
  }

  async function claimChainSave() {
    const res = await api('/api/war-room/chain-save', 'POST')
    if (res.status === 409) {
      const owner = res.body?.owner
      if (owner && rt.chain) rt.chain = { ...rt.chain, save_claimed_by: owner.id, save_claimed_name: owner.name }
      paintChainUi()
      return { ok: false, message: res.body?.error || 'Already claimed' }
    }
    if (res.status !== 200) return { ok: false, message: res.body?.error || `HTTP ${res.status}` }
    if (rt.chain) rt.chain = { ...rt.chain, save_claimed_by: rt.session?.userId, save_claimed_name: 'You' }
    pokePoll()
    paintChainUi()
    return { ok: true }
  }

  async function releaseChainSave() {
    const res = await api('/api/war-room/chain-save', 'DELETE')
    if (res.status !== 200) {
      return { ok: false, message: res.body?.message ?? res.body?.error ?? `HTTP ${res.status}` }
    }
    if (rt.chain) rt.chain = { ...rt.chain, save_claimed_by: null, save_claimed_name: null }
    pokePoll()
    paintChainUi()
    return { ok: true }
  }

  const FEEDBACK_TITLE_MAX = 200
  const FEEDBACK_DESC_MAX = 5000

  /** Same endpoint the dashboard's own Feedback modal posts to (#547). */
  async function submitFeedback(category, title, description) {
    const trimmedTitle = String(title ?? '').trim()
    if (!trimmedTitle) return { ok: false, message: 'A title is required.' }
    if (trimmedTitle.length > FEEDBACK_TITLE_MAX) {
      return { ok: false, message: `Title too long (max ${FEEDBACK_TITLE_MAX} chars).` }
    }
    if (String(description ?? '').length > FEEDBACK_DESC_MAX) {
      return { ok: false, message: `Description too long (max ${FEEDBACK_DESC_MAX} chars).` }
    }
    const res = await api('/api/feedback', 'POST', {
      category, title: trimmedTitle, description: description ?? '', app_version: scriptVersion(),
    })
    if (res.status !== 200) {
      return { ok: false, message: res.body?.error || `HTTP ${res.status}` }
    }
    return { ok: true, url: res.body?.url, number: res.body?.number }
  }

  function pokePoll() {
    if (!rt.polling || !rt.poke) return
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null }
    rt.poke()
  }

  function applyChannels(body) {
    const stateRows = frameRows(body?.state)
    const dibRows = frameRows(body?.dibs)
    const assistRows = frameRows(body?.assist)
    const opponent = opponentFrom(frameRows(body?.config))
    // Single-row table; an empty frame means "unchanged", not "gone".
    const chainRows = frameRows(body?.chain)
    if (chainRows.length > 0) rt.chain = chainRows[chainRows.length - 1]

    if (opponent !== null && opponent !== rt.opponentId) {
      log(`opponent is now faction ${opponent} (was ${rt.opponentId ?? 'unknown'}) — resetting`)
      rt.opponentId = opponent
      rt.enemies = new Set()
      rt.dibs = new Map()
      rt.assists = new Map()
    }

    indexDibs(dibRows, rt.dibs)
    indexAssists(assistRows, rt.assists)
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
    log(`${stateRows.length} roster rows, ${dibRows.length} dib rows, ${assistRows.length} assist rows →`,
      `${rt.enemies.size} enemies, ${rt.dibs.size} live claims, ${rt.assists.size} live assists`,
      `(opponent ${rt.opponentId ?? 'unknown'})`)
    // Faction-page-only UI (toasts) — the attack page has neither the dibs
    // targets nor the chain state these read, and would just be noise mid-fight.
    if (isFactionPage()) {
      checkDibsHospitalAlerts()
      checkChainAlert()
    }
    render()   // render() itself repaints the chain UI at the end of its pass (faction page only)
  }

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

  /** Enough for a 5-character reading like "21.5B". */
  const BS_WIDTH = 48
  const DIBS_WIDTH = 46
  /** Fits "Yours"; longer holder names ellipsis, and the tooltip has the rest. */
  const BADGE_MAX = 44
  const NARROW_PX = 1000
  const COL_HEAD_CLASS = 'tnl-col-head'
  const DIBS_CLASS = 'tnl-col-dibs'
  const MINE_CLASS = 'tnl-mine'
  const TAKEN_CLASS = 'tnl-taken'
  /** The Dibs badge morphed into a live assist request (#523) — see badgeState(). */
  const ASSIST_CLASS = 'tnl-assist'
  const BS_CLASS = 'tnl-col-bs'
  const STAT_VALUE_CLASS = 'tnl-col-bsv'
  const STYLE_ID = 'tnl-dibs-style'
  const TIP_ID = 'tnl-dibs-tip'
  const NO_BS_CLASS = 'tnl-no-bs'
  const LAUNCHER_ID = 'tnl-war-room-link'
  const LAUNCHER_LABEL_ID = 'tnl-war-room-label'
  const LAUNCHER_NAME = 'Torn War Room'
  /** Warline-style online/idle badge on the "Members" header. */
  const MEMBER_COUNT_COLOR = '#0b8a0b'
  const MEMBER_COUNT_CLASS = 'tnl-member-count'
  const MC_ONLINE_CLASS = 'tnl-mc-on'
  const MC_IDLE_CLASS = 'tnl-mc-idle'
  const MC_WORD_CLASS = 'tnl-mc-word'
  const PLAIN_NAME_CLASS = 'tnl-plain-name'
  const TINTING_CLASS = 'tnl-tinting'
  /** TornTools' own "row is filtered out" marker. We read it, never set it. */
  const TT_HIDDEN_CLASS = 'tt-hidden'
  /** Semi-transparent, so the hairline reads on Torn's light theme and its dark one. */
  const RULE = 'rgba(128,128,128,.35)'
  const TINT_CLASS = 'tnl-tint'
  const STATUS_CLASS = 'tnl-status'
  const SORT_CLASS = 'tnl-sort'
  const TOAST_HOST_ID = 'tnl-dibs-toast-host'
  const TOAST_CLASS = 'tnl-toast'
  const TOAST_MS = 7000
  const CHAIN_BADGE_ID = 'tnl-chain-badge'
  const CHAIN_BADGE_LABEL_ID = 'tnl-chain-badge-label'
  const CHAIN_DANGER_CLASS = 'tnl-chain-danger'
  // Matches the board's own default (warRoomAlerts.js ALERT_PREF_DEFAULTS.chain).
  const CHAIN_ALERT_THRESHOLD_SEC = 60

  const TINT_GRADIENTS = {
    online: 'linear-gradient(to bottom, #A3DA00, #648600)',
    idle: 'linear-gradient(to bottom, #FBB904, #B65F01)',
    offline: 'linear-gradient(to bottom, #C6C6C6, #737373)',
  }
  const TINT_COLORS = { online: '#8CBF00', idle: '#D89400', offline: '#9ca3af' }

  const STATUS_COLORS = {
    okay: '#9ca3af', hospital: '#f87171', jail: '#fb923c',
    traveling: '#60a5fa', abroad: '#22d3ee',
  }

  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
/* The header, the list AND each row are flex — all three, or none. Torn lays
   rows out with floats, but the cells we inject are not floated, and non-floated
   content does not sit in DOM order relative to floats. Mixing the two models
   gives the header and the rows two different column orders. */
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
/* :not(.tt-hidden) is not optional. The TornTools extension hides filtered rows
   with .tt-hidden (specificity 0,1,0) on the same <li> we lay out here (0,1,2),
   so unqualified our display:flex out-specifies theirs and un-hides every row
   they filtered. Any future third-party hider goes in the same :not() list. */
ul.members-list > li:not(.${TT_HIDDEN_CLASS}),
.table-body > .table-row:not(.${TT_HIDDEN_CLASS}) {
  display: flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  width: 100% !important;
  position: relative;
}
/* Torn's float-clearing spacers would each take a flex slot of their own. */
ul.members-list > li > .clear, .white-grad > .clear { display: none !important; }

/* min-width:0 is what lets a long name ellipsis instead of widening the row. */
.members-cont [class*="member___"], .white-grad > [class*="member___"] {
  flex: 1 1 auto !important;
  min-width: 0 !important;
  overflow: hidden !important;
}
/* This cell carries the label, the sort arrow and the online/idle badge. */
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

/* Battle stats sit between Level and Score. */
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
/* The label centres; the numbers below it stay right-aligned. */
.${COL_HEAD_CLASS}.${BS_CLASS} { justify-content: center; text-align: center; }
/* The FF border hugs the number, not the row height, or it clips.
   This is an <a>, so it starts from Torn's link colour and underline until
   paintStats writes the real ones inline — these keep that off the screen. */
.${STAT_VALUE_CLASS} {
  color: inherit; text-decoration: none;
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
/* #523 first cut — a live assist request morphs this same badge; a visual
   pass is expected once this has been seen live. */
.${BADGE_CLASS}.${ASSIST_CLASS} { background: #ea580c; font-weight: 700; cursor: pointer; }
.${BADGE_CLASS}.${ASSIST_CLASS}:hover { background: #f97316; }

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

/* Torn ships the name three ways: an honor-bar <img>, a per-character SVG twin,
   and a plain .honor-text span. Hide the first two, show the third. */
.${PLAIN_NAME_CLASS} img { display: none !important; }
.${PLAIN_NAME_CLASS} .honor-text-svg { display: none !important; }
/* Torn's plain .honor-text span is position:absolute (it normally sits as an
   invisible backdrop under the honor-bar image/SVG), and an absolutely
   positioned element is blockified by the CSS spec regardless of any
   display:inline we set — so it never contributed to its wrapping <a>'s size.
   With the <img> hidden, that <a> had nothing left to size itself on and
   collapsed to 0×0: the text still painted (absolute escapes a 0-size
   ancestor) but there was no box left to hover or click. position:static
   pulls it back into normal flow so the link sizes around the visible text. */
.${PLAIN_NAME_CLASS} .honor-text-wrap,
.${PLAIN_NAME_CLASS} > a {
  position: static !important;
  width: auto !important; height: auto !important;
  overflow: visible !important;
}
.${PLAIN_NAME_CLASS} .honor-text:not(.honor-text-svg) {
  display: inline !important;
  position: static !important;
  visibility: visible !important; opacity: 1 !important;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
  font-size: 11px !important; font-weight: 600 !important;
  line-height: 1.2 !important; text-align: left !important;
  white-space: nowrap !important;
  /* text-fill-color WINS over color, and Torn sets it transparent for the honor
     gradient, so setting colour alone leaves the name invisible. */
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
   two-faction view the tag says nothing. No negative margin to reclaim the space
   — under flex the name column takes it, and a negative one causes an overlap. */
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

/* Narrow screens lose no column and no badge — the name column absorbs the
   squeeze. The badge cannot shrink (nowrap), so instead "3 online / 8 idle"
   becomes "3 / 8" and colour carries what the words did. */
@media screen and (max-width: ${NARROW_PX}px) {
  .${MEMBER_COUNT_CLASS} .${MC_WORD_CLASS} { display: none; }
  .${MEMBER_COUNT_CLASS} .${MC_ONLINE_CLASS} { color: ${TINT_COLORS.online}; }
  .${MEMBER_COUNT_CLASS} .${MC_IDLE_CLASS} { color: ${TINT_COLORS.idle}; }
  .${MEMBER_COUNT_CLASS} { margin-left: 5px; padding: 1px 6px; font-size: 11px; }

  /* A few px off each fixed column — the name column takes the difference. */
  .members-cont .level { width: 24px !important; max-width: 24px !important; flex: 0 0 24px !important; }
  .${BS_CLASS} { width: 46px; min-width: 46px; max-width: 46px; flex: 0 0 46px; }
  .members-cont [class*="points___"]:not([class*="tab___"]),
  .white-grad > [class*="points___"] {
    width: 38px !important; max-width: 38px !important; flex: 0 0 38px !important;
  }
  .members-cont .status, .white-grad > .status {
    width: 58px !important; max-width: 58px !important; flex: 0 0 58px !important;
  }
  .${DIBS_CLASS} { width: 42px; min-width: 42px; max-width: 42px; flex: 0 0 42px; }
}

#${TOAST_HOST_ID} {
  position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
  display: flex; flex-direction: column-reverse; gap: 6px;
  pointer-events: none;
}
.${TOAST_CLASS} {
  pointer-events: auto; cursor: pointer;
  max-width: 320px; padding: 8px 12px; border-radius: 8px;
  font: 12px/1.4 system-ui, sans-serif; color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,.4);
  background: #374151; border: 1px solid rgba(255,255,255,.15);
  animation: tnl-toast-in .15s ease-out;
}
.${TOAST_CLASS}-hospital { background: #b45309; border-color: rgba(255,255,255,.25); }
.${TOAST_CLASS}-chain { background: #b91c1c; border-color: rgba(255,255,255,.25); }
@keyframes tnl-toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

#${CHAIN_BADGE_ID}.${CHAIN_DANGER_CLASS} {
  color: #ef4444; font-weight: 700;
  animation: tnl-chain-pulse 1s ease-in-out infinite;
}
@keyframes tnl-chain-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}

`
    ;(document.head || document.documentElement).appendChild(el)
    log('stylesheet injected')
  }

  function rowOf(anchor) {
    return anchor.closest?.('li, tr') ?? anchor.closest?.('[class*="row___"]') ?? null
  }

  function attackCellOf(row) {
    return row?.querySelector?.('.attack, [class*="attack__"], [class*="attack___"]') ?? null
  }

  function headerFor(row) {
    const list = row.closest('ul, table')
    if (!list) return null
    const prev = list.previousElementSibling
    if (prev && prev.querySelector('.attack, [class*="attack__"]')) return prev
    return list.querySelector('.table-header, [class*="tableHeader"], thead') ?? null
  }

  function attackHeaderCell(header) {
    if (!header) return null
    const direct = header.querySelector('.attack, [class*="attack__"], [class*="attack___"]')
    if (direct) return direct
    for (const cell of header.children) {
      if ((cell.textContent || '').trim().toLowerCase() === 'attack') return cell
    }
    return null
  }

  function scoreCellOf(scope) {
    return scope?.querySelector?.('[class*="points___"]') ?? null
  }

  function isOurs(node) {
    return Boolean(node?.closest?.(
      `.${DIBS_CLASS}, .${BS_CLASS}, #${STYLE_ID}, #${LAUNCHER_ID}, #${CHAIN_BADGE_ID}, #${TOAST_HOST_ID}`
    ))
  }

  function slot(parent, cls, tag = 'span') {
    let el = parent.querySelector(`.${cls}`)
    if (el) return el
    el = document.createElement(tag)
    el.className = cls
    parent.appendChild(el)
    return el
  }

  /** Leaves any child icon alone — a blind `.textContent =` would eat the arrow. */
  function relabelHeaderText(cell, from, to) {
    if (!cell) return
    for (const node of cell.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim() === from) { node.textContent = to; return }
      // "Members" ships wrapped in a span, where Level and Attack are bare
      // text — match a leaf element too, never a container.
      if (node.nodeType === 1 && node.children.length === 0
          && (node.textContent || '').trim() === from) {
        node.textContent = to
        return
      }
    }
  }

  function ensureColumns(row) {
    let dibsCell = row.querySelector(`.${DIBS_CLASS}`)
    let bsCell = row.querySelector(`.${BS_CLASS}`)
    if (dibsCell && bsCell) return { dibsCell, bsCell }

    const header = headerFor(row)
    if (header && !header.querySelector(`.${COL_HEAD_CLASS}`)) {
      const attackHead = attackHeaderCell(header)
      const bsHead = document.createElement(header.tagName.toLowerCase() === 'ul' ? 'li' : 'div')
      bsHead.className = `table-cell ${COL_HEAD_CLASS} ${BS_CLASS}`
      bindSort(bsHead, 'bs', 'BS', row.parentNode)
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
      slot(bsCell, STAT_VALUE_CLASS, 'a')
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
      const state = badgeState(rt.dibs.get(playerId), rt.assists.get(playerId), playerId, rt.session?.userId, rt.isAdmin)
      // #523 first cut: a click-through, not a real <a> — see paintDibs()'s
      // own note on why, and the follow-up this is meant to make small.
      if (state.mode === 'assist') {
        if (state.href) window.open(state.href, '_blank', 'noopener,noreferrer')
        return
      }
      if (state.action === 'none') return
      badge.disabled = true
      badge.textContent = '…'
      const res = state.action === 'claim' ? await claim(playerId) : await release(playerId)
      badge.disabled = false
      if (!res.ok) badge.title = res.message
      // Stale by definition after a write — force the repaint.
      delete cell.dataset.tnlSig
      render()
    })
    cell.appendChild(badge)
    return badge
  }

  const STAT_COLORS = { str: '#ef4444', def: '#22c55e', spd: '#60a5fa', dex: '#f59e0b' }

  // #523 first cut, flagged for the visual pass MonChoon expects to want
  // after testing live: the assist branch is a plain colour/title change on
  // the SAME <button>, not a real <a> — see the click handler in badgeFor()
  // for the click-through itself. Isolated to this one branch on purpose, so
  // swapping it for a real anchor later is a small, contained diff.
  function paintDibs(badge, state) {
    if (!badge) return
    badge.textContent = state.label
    badge.classList.toggle(ASSIST_CLASS, state.mode === 'assist')
    if (state.mode === 'assist') {
      badge.classList.remove(MINE_CLASS, TAKEN_CLASS)
      badge.title = state.title
      return
    }
    badge.classList.toggle(MINE_CLASS, Boolean(state.mine))
    badge.classList.toggle(TAKEN_CLASS, Boolean(state.taken) && !state.mine)
    badge.title = state.mine
      ? 'Yours — click to release'
      : state.taken
        ? `Claimed by ${state.label}${state.action === 'release' ? ' — click to release (admin)' : ''}`
        : 'Claim this target'
  }

  /** Below-right of the cursor, flipped when it would leave the viewport. */
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

  function toastHost() {
    let el = document.getElementById(TOAST_HOST_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = TOAST_HOST_ID
      document.body.appendChild(el)
    }
    return el
  }

  function showToast(text, tone = 'info') {
    if (typeof document === 'undefined') return
    const host = toastHost()
    const el = document.createElement('div')
    el.className = `${TOAST_CLASS} ${TOAST_CLASS}-${tone}`
    el.textContent = text
    el.addEventListener('click', () => el.remove())
    host.appendChild(el)
    setTimeout(() => el.remove(), TOAST_MS)
  }

  function anchorNameFor(playerId) {
    const anchors = rt.nodes.get(playerId)
    if (!anchors) return null
    for (const anchor of anchors) {
      const t = (anchor.textContent || '').trim()
      if (t) return t
    }
    return null
  }

  // rt.state is up to 3s stale; Torn's own rendered cell is not, so it wins
  // on disagreement. No row on screen is not a disagreement — trust the poll.
  function rowConfirmsOutOfHospital(playerId) {
    const anchors = rt.nodes.get(playerId)
    if (!anchors) return true
    for (const anchor of anchors) {
      const row = rowFor(anchor)
      if (!row) continue
      if (tornStatusKind(statusCellOf(row)) === 'hospital') return false
      return true
    }
    return true
  }

  function checkDibsHospitalAlerts() {
    const myId = rt.session?.userId
    if (myId === null || myId === undefined) return
    const mine = []
    for (const [targetId, dib] of rt.dibs) {
      if (String(dib.by) === String(myId)) mine.push(targetId)
    }
    const on = settings.on(SETTING_DIBS_HOSPITAL_ALERT)
    if (on && typeof document !== 'undefined') {
      for (const id of hospitalExits(mine, rt.hospitalSeen, rt.state)) {
        if (!rowConfirmsOutOfHospital(id)) continue
        const name = anchorNameFor(id) ?? `#${id}`
        showToast(`${name} left the hospital — your dibs target is up`, 'hospital')
        log(`dibs hospital-exit alert: ${name} (${id})`)
      }
    }
    // Rebuilt regardless of the setting, so re-enabling starts from a clean
    // baseline instead of replaying what happened while it was off.
    const next = new Map()
    for (const id of mine) next.set(id, isHospital(rt.state.get(id)))
    rt.hospitalSeen = next
  }

  function checkChainAlert() {
    if (!settings.on(SETTING_CHAIN)) return
    const nowSec = Math.floor(Date.now() / 1000)
    const due = chainDropDue(rt.chain, nowSec, CHAIN_ALERT_THRESHOLD_SEC)
    const timeout = Number(rt.chain?.timeout)
    if (due && rt.chainWarnedTimeout !== timeout) {
      rt.chainWarnedTimeout = timeout
      if (typeof document !== 'undefined') {
        showToast(`Chain drops in under a minute — ${Number(rt.chain.current) || 0} hits`, 'chain')
      }
    }
    if (!due) rt.chainWarnedTimeout = null   // re-arm for the next window
  }

  /**
   * What makes the total a real link rather than a click handler.
   *
   * No target — a plain left click opens the attack page in this same tab,
   * same as any other link on the row. rel stays regardless: middle-click
   * and ctrl/cmd-click already open a new tab on their own (a real <a> gives
   * the browser that for free), and noopener/noreferrer are worth having
   * whenever a new tab is possible, not only when target forces one.
   */
  function attackLinkAttrs(playerId) {
    const href = attackUrl(playerId)
    return href ? { href, rel: 'noopener noreferrer' } : null
  }

  function statValueOf(slotEl, playerId) {
    let v = slotEl.querySelector(`.${STAT_VALUE_CLASS}`)
    if (!v) {
      // An <a>, never a <span>. Middle-click, ctrl/cmd-click, "open in new tab"
      // and the status-bar URL preview are all the browser's to give, and it
      // only offers them on a real link — a span with a click handler gets
      // middle-click autoscroll instead, which is the wrong gesture entirely.
      v = document.createElement('a')
      v.className = STAT_VALUE_CLASS
      slotEl.appendChild(v)
    }
    // Bound once per row, never per poll.
    if (!v.dataset.tnlAtk) {
      v.dataset.tnlAtk = '1'
      // Only to keep the click off Torn's row handler. Opening the page is the
      // anchor's own default action and is deliberately left alone — calling
      // preventDefault here is what would take middle-click away again.
      v.addEventListener('click', (e) => e.stopPropagation())
      const move = (e) => {
        const tip = slotEl.dataset.tnlTip
        if (tip) showTip(tip, e.clientX, e.clientY)
      }
      v.addEventListener('mouseenter', move)
      v.addEventListener('mousemove', move)
      v.addEventListener('mouseleave', hideTip)
    }
    const id = String(playerId)
    if (v.dataset.tnlTarget !== id) {
      v.dataset.tnlTarget = id
      const attrs = attackLinkAttrs(playerId)
      if (attrs) Object.assign(v, attrs)
      else v.removeAttribute('href')
    }
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

    cell.style.border = settings.on(SETTING_FF_BOX) && ff !== null && ff >= settings.num(SETTING_FF_THRESHOLD)
      ? '1px solid #86efac'
      : '1px solid transparent'
  }

  /**
   * "Atk" buys about 30px per row. Torn does not always render this cell as
   * a real link — outside an active war it ships a plain, unstyled span with
   * no href at all, script or no script. `playerId` (enemy rows only — never
   * hand this a teammate) lets us give it the same working attack link the
   * BS column already has, rather than a relabelled dead end.
   */
  function shrinkAttack(row, playerId) {
    if (row._tnlAtk) return
    row._tnlAtk = true
    const attack = attackCellOf(row)
    if (!attack || attack.dataset.tnlAtk) return
    for (const el of [attack, ...attack.querySelectorAll('span, a')]) {
      if ((el.textContent || '').trim() === 'Attack' && el.children.length === 0) {
        attack.dataset.tnlAtk = '1'
        if (el.tagName === 'A' && el.getAttribute('href')) {
          el.textContent = 'Atk'
          return
        }
        const href = playerId === null || playerId === undefined ? null : attackUrl(playerId)
        if (!href) { el.textContent = 'Atk'; return }
        const link = document.createElement('a')
        link.className = 't-blue h c-pointer'
        link.textContent = 'Atk'
        link.href = href
        link.rel = 'noopener noreferrer'
        el.replaceWith(link)
        return
      }
    }
  }

  function isMemberRow(row) {
    const tag = row?.tagName?.toLowerCase?.()
    if (tag !== 'li' && tag !== 'tr') return false
    return Boolean(row.querySelector(
      '.status, [class*="status___"], [class*="status__"], .level, [class*="level___"]'
    ))
  }

  function statusCellOf(row) {
    const cached = row?._tnlStatusCell
    if (cached && cached.isConnected) return cached
    const el = row?.querySelector?.('.status, [class*="status___"], [class*="status__"]') ?? null
    if (row) row._tnlStatusCell = el
    return el
  }

  /** What Torn says the status is. Torn is the authority; we only reformat. */
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

  function rememberTornStatus(cell) {
    const shown = (cell.textContent ?? '').trim()
    if (shown !== cell.dataset.tnlWrote) cell.dataset.tnlTorn = shown
    return cell.dataset.tnlTorn ?? ''
  }

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

  /**
   * Torn clips a gradient to the glyphs inside .honor-text, so setting `color`
   * on the anchor changes nothing visible — the gradient itself has to go, which
   * means finding the honor wrap rather than the link.
   */
  function nameTargetOf(row, anchor) {
    let el = row._tnlName
    if (el && el.isConnected) return el
    el = row.querySelector('.honor-text-wrap, [class*="honorWrap___"]') ?? anchor
    row._tnlName = el
    return el
  }

  /** Non-empty is the point: the node exists even when it carries no text. */
  function hasPlainName(wrap) {
    const t = wrap?.querySelector?.('.honor-text:not(.honor-text-svg)')
    return Boolean(t && (t.textContent || '').trim())
  }

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
    // Swap the honor bar for text only where there is text to swap to.
    if (hasPlainName(el)) el.classList.add(PLAIN_NAME_CLASS)
  }

  function idOfRow(row) {
    const a = row?.querySelector?.('a[href*="profiles.php?XID="]')
    return a ? parseXid(a.getAttribute('href')) : null
  }

  function sortStateFor(list) {
    return rt.sortState.get(list) ?? { key: null, dir: 0 }
  }

  function anySortActive() {
    for (const state of rt.sortState.values()) if (state.key) return true
    return false
  }

  // Torn's own text for these three columns, read straight off the row — we
  // took the sort over from Torn (see relabelColumnHeaders), so there is no
  // war-room state to read; the DOM already has the answer.
  function nameSortValue(row) {
    const t = row.querySelector('a[href*="profiles.php?XID="]')?.textContent
    return t ? t.trim() : ''
  }

  function levelSortValue(row) {
    const n = Number(row.querySelector('.level, [class*="level___"]')?.textContent)
    return Number.isFinite(n) ? n : null
  }

  function scoreSortValue(row) {
    const n = Number(scoreCellOf(row)?.textContent)
    return Number.isFinite(n) ? n : null
  }

  function sortValueFor(sortKey, playerId, row, nowMs) {
    switch (sortKey) {
      case 'bs': {
        const total = rt.stats.get(playerId)?.total
        return total === null || total === undefined ? null : Number(total)
      }
      case 'status': return statusSortValue(rt.state.get(playerId), nowMs)
      case 'name': return nameSortValue(row)
      case 'level': return levelSortValue(row)
      case 'score': return scoreSortValue(row)
      default: return null
    }
  }

  /** Permutes with flex `order`, never by moving nodes — Torn owns the DOM order. */
  function orderList(list, nowMs) {
    const state = sortStateFor(list)
    const children = Array.from(list.children)
    if (!state.key) {
      if (!list.dataset.tnlOrderSig) return
      for (const c of children) c.style.order = ''
      delete list.dataset.tnlOrderSig
      return
    }

    const rows = []
    children.forEach((c, i) => {
      const id = idOfRow(c)
      if (id !== null) rows.push({ id, row: c, pos: i, slot: i + 1, value: sortValueFor(state.key, id, c, nowMs) })
    })
    if (rows.length < 2) return

    const ordered = sortEntries(rows, state.dir)
    const sig = `${state.key}:${state.dir}:${ordered.map((e) => e.id).join(',')}`
    if (list.dataset.tnlOrderSig === sig && rows[0].row.style.order !== '') return
    list.dataset.tnlOrderSig = sig

    children.forEach((c, i) => { c.style.order = String(i + 1) })
    const slots = rows.map((r) => r.slot).sort((a, b) => a - b)
    ordered.forEach((e, i) => { e.row.style.order = String(slots[i]) })
  }

  function applySort(nowMs = Date.now()) {
    // Nothing to do, and nothing to undo — skip the whole walk.
    if (!anySortActive() && !rt.sorted) return
    rt.sorted = anySortActive()
    const lists = new Set()
    eachRow((_id, _anchor, row) => { if (row.parentNode) lists.add(row.parentNode) })
    for (const list of lists) orderList(list, nowMs)
  }

  function bindSort(el, key, label, list) {
    if (!el || el.dataset.tnlSortKey) return
    el.dataset.tnlSortKey = key
    el.dataset.tnlSortLabel = label
    el._tnlSortList = list
    el.classList.add(SORT_CLASS)
    // A dedicated child for the label text, not the whole cell — the Name
    // header also hosts the online/idle count badge as a sibling child, and
    // paintSortHeaders() must never touch it.
    const labelEl = document.createElement('span')
    el.textContent = ''
    el.appendChild(labelEl)
    el._tnlSortLabelEl = labelEl
    el.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      const next = nextSort(sortStateFor(list), key)
      rt.sortState.set(list, next)
      rt.sorted = true
      log(`sort ${next.key ?? 'off'} ${next.dir === -1 ? 'desc' : next.dir === 1 ? 'asc' : ''}`)
      paintSortHeaders()
      applySort()
    })
  }

  /**
   * Is this header cell one of Torn's own sort controls?
   *
   * Torn marks a sortable header with a sortIcon child; ours carry SORT_CLASS
   * instead. The Attack header has neither and sorts nothing.
   */
  function isTornSortHeader(cell) {
    if (!cell || cell.classList?.contains?.(SORT_CLASS)) return false
    return Boolean(cell.querySelector?.('[class*="sortIcon___"]'))
  }

  /** The direct child of `header` that contains `node`. */
  function headerCellOf(header, node) {
    let el = node
    while (el && el.parentNode && el.parentNode !== header) el = el.parentNode
    return el?.parentNode === header ? el : null
  }

  /**
   * Hand the list back to Torn when one of its own sort headers is clicked.
   *
   * We permute with flex `order`, which overrides DOM order outright, so a list
   * still carrying our order values ignores Torn's reordering completely — its
   * header arrow moves and not one row does. Clearing our sort here drops those
   * values before Torn's own handler runs.
   */
  function releaseSortOnTornHeader(header, list) {
    if (header.dataset.tnlReleaseBound) return
    header.dataset.tnlReleaseBound = '1'
    header.addEventListener('click', (e) => {
      if (!sortStateFor(list).key) return
      if (!isTornSortHeader(headerCellOf(header, e.target))) return
      log('Torn header clicked — releasing our sort')
      rt.sortState.set(list, { key: null, dir: 0 })
      paintSortHeaders()
      applySort()
    }, true)
  }

  function paintSortHeaders() {
    if (typeof document === 'undefined') return
    for (const el of document.querySelectorAll(`.${SORT_CLASS}`)) {
      const key = el.dataset.tnlSortKey
      const label = el.dataset.tnlSortLabel ?? ''
      const state = sortStateFor(el._tnlSortList)
      const arrow = state.key !== key ? '' : state.dir === -1 ? ' ▾' : ' ▴'
      const text = `${label}${arrow}`
      const target = el._tnlSortLabelEl ?? el
      if (target.textContent !== text) target.textContent = text
    }
  }

  function bindStatusHeader(row) {
    const list = row.parentNode
    if (!list || list.dataset.tnlHeaderBound) return
    list.dataset.tnlHeaderBound = '1'
    const header = headerFor(row)
    if (!header) return
    const cell = header.querySelector('.status, [class*="status___"], [class*="status__"]')
    if (cell && !cell.dataset.tnlSortKey) {
      bindSort(cell, 'status', (cell.textContent ?? 'Status').trim() || 'Status', list)
    }
    releaseSortOnTornHeader(header, list)
  }

  /**
   * Unlike the DIBS/BS columns, both sides get this. Also takes Name/Lv/Score
   * sorting over from Torn entirely (bindSort's existing preventDefault +
   * stopPropagation, proven on the Status header, keeps Torn's own handler
   * from ever seeing the click) — Torn's own sort is shared across both
   * tables at once, which a userscript cannot scope; ours is per list.
   */
  function relabelColumnHeaders(row) {
    const list = row.parentNode
    if (!list || list.dataset.tnlLabelsBound) return
    list.dataset.tnlLabelsBound = '1'
    const header = headerFor(row)
    if (!header) return
    relabelHeaderText(attackHeaderCell(header), 'Attack', 'Atk')
    relabelHeaderText(header.querySelector('.level, [class*="level___"]'), 'Level', 'Lv')
    // The width "Name" gives back is what the online/idle badge sits in.
    relabelHeaderText(header.querySelector('.member, [class*="member___"]'), 'Members', 'Name')

    bindSort(header.querySelector('.member, [class*="member___"]'), 'name', 'Name', list)
    bindSort(header.querySelector('.level, [class*="level___"]'), 'level', 'Lv', list)
    bindSort(scoreCellOf(header), 'score', 'Score', list)
  }

  function memberLists() {
    return typeof document === 'undefined'
      ? []
      : Array.from(document.querySelectorAll('ul.members-list, ul[class*="membersCont"]'))
  }

  function tallyActivity(states) {
    const out = { online: 0, idle: 0, offline: 0 }
    for (const state of states) {
      const tone = activityTone(state)
      if (tone !== null) out[tone] += 1
    }
    return out
  }

  function countLabel({ online, idle }) {
    return `${online} online` + (idle ? ` / ${idle} idle` : '')
  }

  function countTooltip({ online, idle, offline }) {
    return `${online} online, ${idle} idle, ${offline} offline`
  }

  /**
   * Counted off the roster, not the rendered rows: list.children only ever sees
   * what Torn has painted, and undercounts anything paginated or collapsed.
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
   * True enemy, false ours, null when the page does not say. Which side is ours
   * comes from the roster, never from left/right — either faction can be either.
   */
  function listIsEnemy(list) {
    if (list.closest?.('.enemy-faction')) return true
    if (list.closest?.('.your-faction')) return false
    const row = list.firstElementChild
    if (row?.classList?.contains?.('enemy')) return true
    if (row?.classList?.contains?.('your')) return false
    return null
  }

  function membersHeaderCellOf(list) {
    const anchor = list.firstElementChild
    if (!anchor) return null
    const header = headerFor(anchor)
    return header?.querySelector('.member, [class*="member___"]') ?? null
  }

  /** The words live in their own spans so a narrow screen can hide them. */
  function paintCountBadge(badge, counts) {
    const sig = `${counts.online}|${counts.idle}`
    if (badge.dataset.tnlCount === sig) return
    badge.dataset.tnlCount = sig
    badge.textContent = ''
    const part = (cls, text) => {
      const el = document.createElement('span')
      el.className = cls
      el.textContent = text
      badge.appendChild(el)
    }
    part(MC_ONLINE_CLASS, String(counts.online))
    part(MC_WORD_CLASS, ' online')
    if (counts.idle) {
      part('', ' / ')
      part(MC_IDLE_CLASS, String(counts.idle))
      part(MC_WORD_CLASS, ' idle')
    }
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
      if (side === null) continue   // unlabelled panel — say nothing rather than guess
      const counts = sideTally(side)
      let badge = cell.querySelector(`.${MEMBER_COUNT_CLASS}`)
      if (!badge) {
        badge = document.createElement('span')
        badge.className = MEMBER_COUNT_CLASS
        cell.appendChild(badge)
      }
      paintCountBadge(badge, counts)
      badge.title = countTooltip(counts)
      badge.style.display = counts.online + counts.idle === 0 ? 'none' : ''
    }
  }

  /** Cached: three loops ask per anchor, per poll, across every row on the page. */
  function rowFor(anchor) {
    const cached = anchor._tnlRow
    if (cached !== undefined && (cached === null || cached.isConnected)) return cached
    const row = rowOf(anchor)
    // No row ancestor at all (a sidebar or chat link) is a permanent fact.
    if (!row) { anchor._tnlRow = null; return null }
    if (isMemberRow(row)) { anchor._tnlRow = row; return row }
    // A row with no status or level cell yet may be mid-build — do not cache.
    return null
  }

  /** Prunes as it walks — scan() only adds, and Torn replaces rows constantly. */
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

  const ASSIST_OVERLAY_ID = 'tnl-assist-overlay'
  const ASSIST_OVERLAY_STYLE_ID = 'tnl-assist-overlay-style'
  const ASSIST_BTN_ACTIVE_CLASS = 'tnl-assist-btn-active'

  /**
   * Attack-page overlay (#523) — small, fixed-position, self-contained.
   *
   * ⚠️ Strictly additive, per the issue's own warning: this never queries,
   * wraps or reparents anything Torn already rendered — it is one <div>
   * appended once to <body>, positioned with `position: fixed` (out of
   * document flow, so it cannot push Torn's own layout around) and its own
   * z-index stacking context. Verify with the script off vs on and diff
   * what's clickable (the issue's own acceptance check) before relying on
   * this corner being clear of Torn's own controls on every screen size —
   * that part cannot be confirmed outside a real torn.com session.
   */
  function injectAssistOverlayStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(ASSIST_OVERLAY_STYLE_ID)) return
    const el = document.createElement('style')
    el.id = ASSIST_OVERLAY_STYLE_ID
    el.textContent = `
#${ASSIST_OVERLAY_ID} {
  position: fixed; z-index: 2147483000;
  top: 70px; right: 10px;
  display: flex; gap: 6px;
  background: rgba(17,24,39,.92); border: 1px solid #374151; border-radius: 8px;
  padding: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.4);
  pointer-events: auto;
}
#${ASSIST_OVERLAY_ID} button {
  font: 16px/1 system-ui, sans-serif; width: 30px; height: 30px;
  border-radius: 6px; border: 1px solid #4b5563; background: #1f2937;
  color: #e5e7eb; cursor: pointer; line-height: 28px; text-align: center; padding: 0;
}
#${ASSIST_OVERLAY_ID} button:hover { background: #374151; }
#${ASSIST_OVERLAY_ID} button.${ASSIST_BTN_ACTIVE_CLASS} { background: #ea580c; border-color: #ea580c; }
`
    document.head.appendChild(el)
  }

  function ensureAssistOverlay() {
    if (typeof document === 'undefined') return null
    let box = document.getElementById(ASSIST_OVERLAY_ID)
    if (box && box.isConnected) return box
    box = document.createElement('div')
    box.id = ASSIST_OVERLAY_ID
    for (const kind of Object.keys(ASSIST_KIND_META)) {
      const meta = ASSIST_KIND_META[kind]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.tnlKind = kind
      btn.title = meta.label
      btn.textContent = meta.icon
      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation()
        const targetId = attackTargetId(typeof location !== 'undefined' ? location.search : '')
        if (!targetId) return
        const mine = rt.assists.get(targetId)
        const isMine = mine && String(mine.by) === String(rt.session?.userId)
        // Same kind, clicked again: toggle off — the requester clearing
        // their own marker (#523's own acceptance criterion).
        btn.disabled = true
        const res = (isMine && mine.kind === kind) ? await clearAssist(targetId) : await requestAssist(targetId, kind)
        btn.disabled = false
        // Not showToast(): that relies on injectStyles()' faction-page-only
        // stylesheet for its look, which never runs on the attack page — an
        // unstyled floating div is worse than the same failure surfacing the
        // way a failed dibs claim already does elsewhere in this file, on
        // the control itself.
        if (!res.ok) btn.title = res.message
        renderAssistOverlay()
      })
      box.appendChild(btn)
    }
    document.body.appendChild(box)
    return box
  }

  function renderAssistOverlay() {
    if (typeof document === 'undefined') return
    const targetId = attackTargetId(typeof location !== 'undefined' ? location.search : '')
    // No target id we can read, or no session (sign-in happens on the
    // faction page) — nothing to show. Degrades to nothing, per #523's own
    // acceptance criterion, rather than a dead panel with buttons that 401.
    if (!targetId || !rt.session) {
      document.getElementById(ASSIST_OVERLAY_ID)?.remove()
      return
    }
    injectAssistOverlayStyles()
    const box = ensureAssistOverlay()
    if (!box) return
    const mine = rt.assists.get(targetId)
    const isMine = mine && String(mine.by) === String(rt.session?.userId)
    for (const btn of box.querySelectorAll('button')) {
      btn.classList.toggle(ASSIST_BTN_ACTIVE_CLASS, Boolean(isMine && mine.kind === btn.dataset.tnlKind))
    }
  }

  function render() {
    if (typeof document === 'undefined') return
    // #523: two @match surfaces, two render paths — never both. The attack
    // page gets ONLY the assist overlay; injectStyles() below carries layout
    // overrides (`.white-grad`, `[class*="tableHeader"]`, …) that are Torn
    // component classes reused across pages, so running the faction-page body
    // there risks breaking Torn's own attack-page layout, not just no-op.
    if (isAttackPage()) { renderAssistOverlay(); return }
    if (!isFactionPage()) return   // unrecognised page: degrade to nothing
    injectStyles()
    // Puts the link back after Torn re-renders the page title out from under it.
    ensureLauncher()
    document.documentElement.classList.toggle(NO_BS_CLASS, !settings.on(SETTING_STATS))
    let painted = 0      // enemies we intended to badge
    let attached = 0     // badges that actually exist in the DOM
    let repainted = 0    // rows whose state actually changed
    const settingsSig = settingsSignature()   // loop-invariant; read once
    const nowMs = Date.now()
    const sigs = new Map()
    eachRow((playerId, anchor, row) => {
      measureRow(row)   // before anything below hides what it measures
      const isEnemy = rt.enemies.has(playerId)
      if (!isEnemy && !rt.state.has(playerId)) return

      paintName(row, anchor, playerId)
      paintStatus(row, playerId, nowMs)
      bindStatusHeader(row)
      relabelColumnHeaders(row)
      shrinkAttack(row, isEnemy ? playerId : null)
      if (!isEnemy) return

      painted++
      let entry = sigs.get(playerId)
      if (!entry) {
        const state = badgeState(rt.dibs.get(playerId), rt.assists.get(playerId), playerId, rt.session?.userId, rt.isAdmin)
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
    // After the loop: measureRow() reads Torn's geometry before this hides it.
    document.documentElement.classList.toggle(TINTING_CLASS, settings.on(SETTING_TINT))
    paintSortHeaders()
    applySort(nowMs)
    paintMemberCounts()
    paintChainUi()
  }

  function renderTimers() {
    if (typeof document === 'undefined' || document.hidden) return
    const nowMs = Date.now()
    eachRow((playerId, _anchor, row) => {
      if (rt.state.has(playerId)) paintStatus(row, playerId, nowMs)
    })
    checkChainAlert()
    paintChainUi()
  }

  function startTimers() {
    if (rt.tick || typeof setInterval !== 'function') return
    rt.tick = setInterval(renderTimers, 1000)
  }

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
      render()   // once per batch, not once per touched node
    })
    observer.observe(document, { childList: true, subtree: true })
    scan(document)
    render()
    startTimers()
  }

  let panelStatus = null
  let panelBox = null
  let panelDot = null
  let launcher = null

  /**
   * Our entry point among Torn's own page-title links, doubling as the
   * connectivity light. Rebuilt on demand: Torn re-renders the page title on
   * navigation and would otherwise drop it.
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
      rt.feedbackOpen = false
      rt.chainOpen = false   // one popover at a time
      panel()
      chainPanel()
    })

    list.insertBefore(link, list.firstChild)
    launcher = link
    setStatus(rt.status)
    log('launcher added to the page-title links')
    return link
  }

  function placePanel(box, anchorEl = launcher) {
    box.style.position = 'fixed'
    box.style.zIndex = '2147483000'
    const anchor = anchorEl
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

  let chainBadge = null
  let chainPanelBox = null

  function ensureChainBadge() {
    if (typeof document === 'undefined') return null
    const found = document.getElementById(CHAIN_BADGE_ID)
    if (found && found.isConnected) { chainBadge = found; return found }

    const list = document.getElementById('top-page-links-list')
    if (!list) { chainBadge = null; return null }

    const link = document.createElement('a')
    link.id = CHAIN_BADGE_ID
    link.href = '#'
    link.className = 't-clear h c-pointer line-h24 right'
    link.title = 'Chain — click for the bonus-hit ladder and the save claim'

    const label = document.createElement('span')
    label.id = CHAIN_BADGE_LABEL_ID
    link.appendChild(label)

    link.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation()
      rt.chainOpen = !rt.chainOpen
      rt.expanded = false
      rt.settingsOpen = false
      rt.feedbackOpen = false
      panel()
      chainPanel()
    })

    const before = document.getElementById(LAUNCHER_ID)
    if (before) list.insertBefore(link, before)
    else list.insertBefore(link, list.firstChild)
    chainBadge = link
    return link
  }

  function paintChainBadge() {
    if (typeof document === 'undefined') return
    if (!settings.on(SETTING_CHAIN)) { document.getElementById(CHAIN_BADGE_ID)?.remove(); chainBadge = null; return }
    const nowSec = Math.floor(Date.now() / 1000)
    const text = chainBadgeText(rt.chain, nowSec)
    if (!text) { document.getElementById(CHAIN_BADGE_ID)?.remove(); chainBadge = null; return }
    const link = ensureChainBadge()
    if (!link) return
    const label = document.getElementById(CHAIN_BADGE_LABEL_ID)
    if (label && label.textContent !== text) label.textContent = text
    link.classList.toggle(CHAIN_DANGER_CLASS, chainDropDue(rt.chain, nowSec, CHAIN_ALERT_THRESHOLD_SEC))
  }

  function chainSaveButtonState(chain, currentUserId, isAdmin) {
    const holder = chain?.save_claimed_by
    if (holder === null || holder === undefined) {
      return { label: 'Claim save', action: 'claim', mine: false, taken: false }
    }
    if (String(holder) === String(currentUserId)) {
      return { label: 'Release save', action: 'release', mine: true, taken: true }
    }
    return {
      label: `Held by ${chain.save_claimed_name ?? 'someone'}`,
      action: isAdmin ? 'release' : 'none',
      mine: false,
      taken: true,
    }
  }

  function chainPanel() {
    if (typeof document === 'undefined') return
    if (chainPanelBox && chainPanelBox.isConnected) chainPanelBox.remove()
    chainPanelBox = null
    if (!rt.chainOpen || !settings.on(SETTING_CHAIN)) return

    const box = document.createElement('div')
    chainPanelBox = box
    box.style.cssText = [
      'background:#111827', 'color:#e5e7eb', 'border:1px solid #374151',
      'border-radius:10px', 'padding:10px 12px', 'font:12px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'max-width:260px',
    ].join(';')

    const title = document.createElement('div')
    title.textContent = 'Chain'
    title.style.cssText = 'font-weight:700;margin-bottom:4px'
    box.appendChild(title)

    const chain = rt.chain
    const current = Number(chain?.current) || 0
    const next = nextBonusHit(current)
    const info = document.createElement('div')
    info.textContent = next ? `${current} hits · next bonus at ${next} (${next - current} to go)` : `${current} hits`
    box.appendChild(info)

    const nowSec = Math.floor(Date.now() / 1000)
    const left = chainSecondsLeft(chain, nowSec)
    const timer = document.createElement('div')
    timer.style.cssText = 'opacity:.8;margin-top:2px'
    timer.textContent = left != null ? `Drops in ${fmtCountdown(left)}` : (current > 0 ? 'On cooldown' : 'No active chain')
    box.appendChild(timer)

    const state = chainSaveButtonState(chain, rt.session?.userId, rt.isAdmin)
    const btn = document.createElement('button')
    btn.textContent = state.label
    btn.disabled = state.action === 'none'
    btn.style.cssText = [
      'width:100%', 'margin-top:8px', 'padding:5px', 'border-radius:6px',
      'border:1px solid #4b5563', 'cursor:' + (state.action === 'none' ? 'default' : 'pointer'),
      state.mine ? 'background:#1d4ed8;color:#fff' : (state.taken ? 'background:#c2410c;color:#fff' : 'background:transparent;color:#e5e7eb'),
    ].join(';')
    btn.addEventListener('click', async () => {
      if (state.action === 'none') return
      btn.disabled = true
      const res = state.action === 'claim' ? await claimChainSave() : await releaseChainSave()
      if (!res.ok) log(`chain save: ${res.message}`)
      chainPanel()
    })
    box.appendChild(btn)

    placePanel(box, chainBadge)
    document.body.appendChild(box)
  }

  function paintChainUi() {
    paintChainBadge()
    if (rt.chainOpen) chainPanel()
  }

  function panelNeedsKey(session) {
    return !session || !session.token
  }

  function panelExpanded(session, expanded) {
    if (panelNeedsKey(session)) return true
    return expanded === true
  }

  /** "v1.32.0", or null when there is no version to show rather than a lie. */
  function versionLabel(version) {
    const v = typeof version === 'string' ? version.trim() : ''
    return v ? `v${v}` : null
  }

  /** What Tampermonkey says it is running us as. */
  function scriptVersion() {
    return (typeof GM_info !== 'undefined' && GM_info.script?.version) || null
  }

  function statusText(state) {
    return {
      live: '● live', connecting: '○ connecting…', reconnecting: '○ reconnecting…',
      auth: '⚠ session expired', idle: '○ not connected', error: '⚠ error',
    }[state] || state
  }

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

  function settingNumber(key, label, hint, { min, max, step } = {}) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'margin-top:8px'
    const row = document.createElement('label')
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer'
    const text = document.createElement('span')
    text.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    if (min !== undefined) input.min = String(min)
    if (max !== undefined) input.max = String(max)
    if (step !== undefined) input.step = String(step)
    input.value = String(settings.num(key))
    input.style.cssText = 'width:60px;padding:2px 4px;border-radius:4px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb'
    input.addEventListener('change', () => {
      const n = Number(input.value)
      if (!Number.isFinite(n)) { input.value = String(settings.num(key)); return }
      const clamped = Math.min(max ?? n, Math.max(min ?? n, n))
      settings.setNum(key, clamped)
      input.value = String(clamped)
      log(`setting ${key} = ${clamped}`)
      render()
    })
    row.appendChild(text)
    row.appendChild(input)
    wrap.appendChild(row)
    if (hint) {
      const small = document.createElement('div')
      small.textContent = hint
      small.style.cssText = 'opacity:.6;font-size:11px'
      wrap.appendChild(small)
    }
    return wrap
  }

  function feedbackView(box) {
    const title = document.createElement('div')
    title.textContent = 'Send feedback'
    title.style.cssText = 'font-weight:700;margin-bottom:6px'
    box.appendChild(title)

    const category = document.createElement('select')
    category.style.cssText = 'width:100%;margin-bottom:6px;padding:4px 6px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb'
    for (const [value, label] of [['bug', 'Bug'], ['suggestion', 'Suggestion']]) {
      const opt = document.createElement('option')
      opt.value = value; opt.textContent = label
      category.appendChild(opt)
    }
    box.appendChild(category)

    const titleInput = document.createElement('input')
    titleInput.type = 'text'
    titleInput.placeholder = 'Short summary'
    titleInput.maxLength = FEEDBACK_TITLE_MAX
    titleInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 6px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb'
    box.appendChild(titleInput)

    const descInput = document.createElement('textarea')
    descInput.placeholder = 'What happened, or what you’d like to see'
    descInput.rows = 4
    descInput.maxLength = FEEDBACK_DESC_MAX
    descInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px;padding:4px 6px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb;resize:vertical;font:inherit'
    box.appendChild(descInput)

    const note = document.createElement('div')
    note.style.cssText = 'opacity:.7;margin-bottom:6px;min-height:14px'
    box.appendChild(note)

    const send = document.createElement('button')
    send.textContent = 'Send'
    send.style.cssText = 'width:100%;padding:5px;border-radius:6px;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer'
    send.addEventListener('click', async () => {
      send.disabled = true
      note.style.color = ''
      note.textContent = 'Sending…'
      const res = await submitFeedback(category.value, titleInput.value, descInput.value)
      send.disabled = false
      if (!res.ok) {
        note.style.color = '#f87171'
        note.textContent = res.message
        return
      }
      titleInput.value = ''; descInput.value = ''
      note.style.color = '#4ade80'
      note.textContent = res.number ? `Filed as #${res.number}` : 'Sent.'
    })
    box.appendChild(send)

    const back = document.createElement('button')
    back.textContent = 'Back'
    back.style.cssText = 'width:100%;margin-top:6px;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
    back.addEventListener('click', () => { rt.feedbackOpen = false; panel() })
    box.appendChild(back)
  }

  function settingsView(box) {
    const title = document.createElement('div')
    title.textContent = 'Settings'
    title.style.cssText = 'font-weight:700;margin-bottom:2px'
    box.appendChild(title)

    box.appendChild(settingToggle(SETTING_STATS, 'Show battle stats', 'Off leaves the dibs control alone.'))
    box.appendChild(settingToggle(SETTING_FF_BOX, 'Highlight high fair fight', 'A green box at or above the threshold below.'))
    box.appendChild(settingNumber(SETTING_FF_THRESHOLD, 'FF highlight threshold', 'FF saturates around 0.75 defender/attacker \u2014 the useful range is below an even fight.', { min: 1, max: 3, step: 0.1 }))
    box.appendChild(settingToggle(SETTING_STATUS, 'Live status column', 'Hospital countdown, travel ETA and last action, in Torn\u2019s own Status cell.'))
    box.appendChild(settingToggle(SETTING_TINT, 'Tint names by activity', 'Green online, amber idle, grey offline.'))
    box.appendChild(settingToggle(SETTING_MEMBER_COUNT, 'Online/idle count', 'A Warline-style count on each Members header.'))
    box.appendChild(settingToggle(SETTING_CHAIN, 'Chain timer on the faction page', 'Live countdown, next bonus hit, and the save claim.'))
    box.appendChild(settingToggle(SETTING_DIBS_HOSPITAL_ALERT, 'Alert when a dibs target leaves hospital', 'A toast when a target you hold dibs on is discharged.'))
    box.appendChild(settingToggle(DEBUG_KEY, 'Debug log (console)', 'Reload to trace startup.'))

    const back = document.createElement('button')
    back.textContent = 'Back'
    back.style.cssText = 'width:100%;margin-top:10px;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
    back.addEventListener('click', () => { rt.settingsOpen = false; panel() })
    box.appendChild(back)
  }

  function panel() {
    if (typeof document === 'undefined') return
    // The launcher owns the status light and outlives the box, which comes and
    // goes with every open and close.
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

    if (rt.feedbackOpen) {
      feedbackView(box)
      placePanel(box)
      document.body.appendChild(box)
      return
    }

    const title = document.createElement('div')
    title.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px'
    const name = document.createElement('span')
    name.textContent = LAUNCHER_NAME
    name.style.cssText = 'font-weight:700'
    title.appendChild(name)
    const version = versionLabel(scriptVersion())
    if (version) {
      const tag = document.createElement('span')
      tag.textContent = version
      // The dashboard's own footer grey, so the two read as one product.
      tag.style.cssText = 'font-weight:400;font-size:11px;color:#9ca3af'
      title.appendChild(tag)
    }
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
      hide.addEventListener('click', () => { rt.expanded = false; rt.settingsOpen = false; rt.feedbackOpen = false; panel() })

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

      const secondRow = document.createElement('div')
      secondRow.style.cssText = 'display:flex;gap:6px;margin-top:6px'

      const gear = document.createElement('button')
      gear.textContent = '⚙ Settings'
      gear.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      gear.addEventListener('click', () => { rt.settingsOpen = true; panel() })
      secondRow.appendChild(gear)

      const feedback = document.createElement('button')
      feedback.textContent = '💬 Feedback'
      feedback.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      feedback.addEventListener('click', () => { rt.feedbackOpen = true; panel() })
      secondRow.appendChild(feedback)

      box.appendChild(secondRow)
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
    // #523: the attack page gets the poll loop (so an assist raised/cleared
    // elsewhere shows up here, and vice versa) but NEVER observe() — that's
    // the faction-page DOM scan (MutationObserver over the whole document,
    // hunting for `profiles.php?XID=` links to badge), and running it here
    // risks matching something on Torn's own attack-page DOM. The overlay
    // itself is DOM-independent (built from the URL, not from a scan), so it
    // paints once immediately rather than waiting on the first poll.
    if (isFactionPage()) observe()
    else if (isAttackPage()) renderAssistOverlay()
  }

  function main() {
    rt.session = store.read()
    const version = scriptVersion() ?? 'unknown'
    const path = typeof location !== 'undefined' ? location.pathname + location.search : 'unknown'
    log(`v${version} starting on ${path}`)
    // The launcher/settings panel is faction-page furniture (its own anchor,
    // `#top-page-links-list`, is what the faction pages' title bar exposes).
    // Skipping it on the attack page keeps that surface to just the overlay.
    if (isFactionPage()) panel()
    boot()
      .then(() => { if (isFactionPage()) panel() })   // reflect whatever boot() resolved the session to
      .catch((err) => {
        setStatus('error')
        // eslint-disable-next-line no-console
        console.error('[TNL Dibs]', err)
        if (isFactionPage()) panel()
      })
  }

  function setSession(session) { rt.session = session }
  function currentSession() { return rt.session }
  function dibsIndex() { return rt.dibs }
  function assistsIndex() { return rt.assists }
  function statsIndex() { return rt.stats }
  function sortStateIndex() { return rt.sortState }

  return {
    setSession, currentSession, api, refreshToken, claim, release, dibsIndex,
    parseXid, resolveTenant, indexDibs, enemyIds, frameRows, buttonState, backoffFor,
    // #523: two-@match-surface helpers, the assist-request state/paint seam,
    // and the write functions the attack-page overlay calls.
    factionPageMatch, attackPageMatch, attackTargetId, isFactionPage, isAttackPage,
    indexAssists, assistsIndex, badgeState, ASSIST_KIND_META, requestAssist, clearAssist,
    identityMatches, panelNeedsKey, panelExpanded, statusText, statusColor,
    opponentFrom, pollDelay, redactUrl, debugOn, establishSession, store, main,
    formatStat, dominantStat, statScore, fairFight, rowStats,
    parseDbTime, fmtAgo, statsSourceLabel, tokenClaims, sessionIsAdmin,
    settingOn, settingNum, settings, settingsSignature, paintSignature,
    FF_THRESHOLD_DEFAULT, SETTING_FF_THRESHOLD, SETTING_CHAIN, SETTING_DIBS_HOSPITAL_ALERT,
    attackUrl, statsTip, injectStyles, tipPosition, formatStatShort,
    ensureLauncher, LAUNCHER_ID, LAUNCHER_NAME,
    countryCode, travelDestination, travelPhase, methodsForPlaneType, travelEta,
    fmtCountdown, fmtEtaShort, fmtLastActionShort, activityTone, reviveAudience,
    tallyActivity, countLabel, countTooltip,
    statusView, statusSortValue, sortEntries, nextSort, rowState, isTornSortHeader,
    versionLabel, scriptVersion, attackLinkAttrs, statValueOf,
    isHospital, hospitalExits, BONUS_HITS, nextBonusHit, chainSecondsLeft, chainDropDue,
    statsIndex, sortStateIndex, orderList, nameSortValue, levelSortValue, scoreSortValue,
    relabelColumnHeaders, paintSortHeaders, shrinkAttack, attackCellOf,
    submitFeedback, FEEDBACK_TITLE_MAX, FEEDBACK_DESC_MAX,
    chainBadgeText, chainSaveButtonState, claimChainSave, releaseChainSave,
    checkDibsHospitalAlerts, checkChainAlert, showToast,
    TENANTS_URL, STORE_KEY, BADGE_CLASS,
    SETTING_DEFAULTS, SETTING_STATS, SETTING_FF_BOX, SETTING_STATUS, SETTING_TINT,
    SETTING_MEMBER_COUNT, DEBUG_KEY,
    FLIGHT_SECONDS, PLANE_TYPE_METHOD,
  }
})()

if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
