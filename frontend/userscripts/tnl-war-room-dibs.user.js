// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.13.0
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

/**
 * Dibs, on the Torn war page itself (#487).
 *
 * ── What this must never do ─────────────────────────────────────────────────
 *
 * ⚠️ It does not resolve races. The server already does, in three layers: a row
 * lock, a partial unique index (war_room_dibs_v2_active_target_idx), and a
 * 23505 handler that turns a genuine collision into a 409 naming the owner.
 * #385 proved it with a seeded concurrency harness.
 *
 * Anything decided locally here could only be a stale mirror of state another
 * member is mutating, and the failure mode is the worst available: telling you
 * a target is yours while the server gave it to someone else. So the rule is
 * absolute — paint optimistically, let the server's answer always overwrite,
 * and show the owner a 409 names.
 *
 * ── Transport, and why it is split ──────────────────────────────────────────
 *
 * ⚠️ There is no CORS plugin on the API. A plain fetch() from torn.com is
 * blocked, and a POST with Authorization + JSON triggers a preflight nothing
 * answers. Everything therefore goes through GM.xmlHttpRequest, which is
 * privileged: the extension performs the request, so it is exempt from CORS AND
 * from the page's Content-Security-Policy. Do not "fix" this by allow-listing
 * torn.com on the API.
 *
 * ⚠️ There is NO WebSocket here, and adding one back will not work. Reads were
 * originally socket-only, reasoning that sockets are CORS-exempt. True — but
 * CORS was never the binding constraint. A page's CSP `connect-src` governs
 * WebSockets too, and unlike GM.xmlHttpRequest a socket opened by page script
 * gets no exemption from it. Torn's policy is explicit and we are not on the
 * list:
 *
 *     connect-src blob: 'self' wss://*.torn.com wss://*.torncity.com
 *                 *.torncity.com *.torn.com api.torn.com …
 *
 * Chrome refuses the connection before a packet leaves the browser, which is
 * why nginx logged zero handshakes while the console showed an error on every
 * load. Reads are therefore polls of /api/war-room/delta — the REST twin of the
 * socket snapshot, same `since` watermark, over the privileged transport.
 *
 * ⚠️ Removing the socket also stops a credential leak. The browser's own CSP
 * violation message prints the ENTIRE blocked URL, and the URL carried the
 * session token as a query parameter — so every page load wrote a live 30-day
 * JWT into the console, where a member pasting a screenshot hands it to anyone
 * reading. Our own logging redacts; Chrome's does not, and cannot be asked to.
 * If a socket is ever reintroduced, its token must not travel in the URL.
 *
 * ── The key ─────────────────────────────────────────────────────────────────
 *
 * Only the session JWT is stored. The API key is held in memory just long
 * enough to ask Torn which faction it belongs to and to log in, then dropped.
 * Login is sent with require_enrolled, so this script can never be a member's
 * FIRST key enrolment — that must happen on the dashboard, which shows the
 * disclosure explaining the shared key pool.
 */

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
  /** #525 — tint the member's name by activity. The one signal that costs no width. */
  const SETTING_TINT = 'tnl-dibs-tint'

  /**
   * User settings (#514).
   *
   * ⚠️ One GM key PER setting, never a single JSON blob shared with the
   * session. Sharing a slot has already cost us once: a test passed because the
   * value it read happened to be the session's, not the flag's, and nothing
   * about the assertion said so. Separate keys also mean a corrupt value in one
   * setting cannot take the session down with it.
   *
   * ⚠️ The DEFAULTS matter more than the toggles. Someone installs this, never
   * opens settings, and must still get the useful configuration — so everything
   * that makes the script worth running is ON, and only the developer switch is
   * off.
   */
  const SETTING_DEFAULTS = {
    [SETTING_STATS]: true,
    [SETTING_FF_BOX]: true,
    [SETTING_STATUS]: true,
    [SETTING_TINT]: true,
    [DEBUG_KEY]: false,
  }

  /** Is a setting on? Unknown keys are off — a typo must not enable anything. */
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

  /**
   * The settings that change what a row LOOKS like, as a string.
   *
   * Part of the repaint signature (#516): flipping "show battle stats" has to
   * repaint every row, and without this the dirty check would decide nothing
   * had changed and leave the old paint on screen.
   */
  function settingsSignature() {
    return `${settings.on(SETTING_STATS) ? 1 : 0}${settings.on(SETTING_FF_BOX) ? 1 : 0}`
  }

  /**
   * Everything about a row that is visible, as one short string.
   *
   * ⚠️ Must cover every input to paintDibs and paintStats and nothing else. Too
   * little and a row silently stops updating; too much (a clock, say) and the
   * dirty check never fires and we are back to repainting 200 rows a tick.
   */
  function paintSignature(state, stats, settingsSig, mineTotal) {
    return [
      state?.label, state?.action, state?.mine ? 1 : 0, state?.taken ? 1 : 0,
      stats?.total ?? '', stats?.str ?? '', stats?.def ?? '', stats?.spd ?? '', stats?.dex ?? '',
      stats?.source ?? '', stats?.spiedAt ?? '',
      // ⚠️ Our OWN total belongs here too. The FF highlight is a comparison, so
      // it changes when our stats refresh even though the target's have not —
      // and without this the row would keep a stale green box forever.
      mineTotal ?? '',
      settingsSig,
    ].join('|')
  }
  /** Read cadence — see the transport note above for why this is a poll. */
  const POLL_MS = 3000
  /**
   * ⚠️ Not 30s. A hidden tab should cost the API little, but this is a war
   * tool: the gap is paid on the way BACK, as a stretch of stale badges at
   * exactly the moment someone alt-tabs in to claim a target. A 30s value
   * read, in the console, as the script having stopped. The visibility
   * listener below makes the return instant regardless; this only bounds how
   * stale a background tab gets.
   */
  const POLL_HIDDEN_MS = 10000

  // ── Debug ────────────────────────────────────────────────────────────────

  /**
   * Verbose tracing, off by default. Toggled by the `Debug log` checkbox in the
   * expanded panel — deliberately not a console command, because the script is
   * sandboxed and `TNLDibs` is not reachable from the page's console.
   *
   * ⚠️ Nothing logged here may contain the session token or an API key. This
   * runs on torn.com, where a screenshot of the console is a normal thing for a
   * member to paste into a support chat — see redactUrl(), which every URL goes
   * through on its way to the log.
   */
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

  /**
   * The Torn user id in a profile link, or null.
   *
   * ⚠️ Read from the href, NOT a class name. Torn's markup churns and class
   * selectors break with it, while every player row on these pages carries a
   * `profiles.php?XID=<id>` anchor and has for years. Same approach as the
   * Battle Stats Predictor script.
   */
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

  /**
   * Fold dib rows into "who holds what".
   *
   * ⚠️ `deleted_at` is a tombstone, not an absence. Releases, auto-expiry (#159)
   * and the single-dibs rule all arrive as rows WITH it set; treating those as
   * live claims would leave badges on targets nobody holds.
   */
  function indexDibs(rows, into) {
    const byTarget = into ?? new Map()
    for (const row of rows ?? []) {
      const targetId = Number(row.target_id)
      // ⚠️ `> 0`, not just finite. Number(null) is 0, so a row with a missing
      // target would otherwise be indexed as a claim on player 0 — invisible,
      // permanent, and impossible to release.
      if (!Number.isFinite(targetId) || targetId <= 0) continue
      if (row.deleted_at) byTarget.delete(targetId)
      else byTarget.set(targetId, { by: Number(row.claimed_by), name: row.claimed_name })
    }
    return byTarget
  }

  /**
   * The row array out of one channel of a socket frame.
   *
   * ⚠️ The two frame types disagree about shape and always have. A `delta`
   * carries `rows` at the top level, but a `snapshot` nests every channel as
   * `{ state: { rows }, dibs: { rows } }` — see fullDelta() in warRoom.ts. The
   * first release passed the snapshot's `{ rows }` OBJECT straight into
   * indexDibs, where `for...of` threw "rows is not iterable" inside the message
   * listener. A throw there is silent: the socket stays open and connected, the
   * panel says live, and not one badge ever appears.
   */
  function frameRows(channel) {
    if (Array.isArray(channel)) return channel
    return Array.isArray(channel?.rows) ? channel.rows : []
  }

  /**
   * A stat total, formatted EXACTLY as the War Room formats it.
   *
   * ⚠️ Two decimals, and `???` — not `N/A`, not `0` — for an absent reading.
   * This is a straight copy of formatStats() in frontend/src/utils/statInput.js
   * and must stay one: a member reading 3.99B on the dashboard and 4.0B here
   * has to wonder which screen is lying, and that doubt costs more than the
   * duplication does.
   */
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

  /**
   * A Postgres timestamp, parsed.
   *
   * ⚠️ THE #140 TRAP. Postgres serialises timestamptz with a bare "+00" offset
   * — "2026-08-01T12:00:00+00" — which `new Date()` rejects outright. The
   * userscript's first tooltip said "spied Invalid Date" for every single
   * member because of exactly this, and the dashboard hit it once before.
   * Copied from parseDbTime() in frontend/src/utils/time.js.
   */
  function parseDbTime(ts) {
    if (!ts) return null
    let str = String(ts)
    str = str.replace(/([+-]\d{2})$/, '$1:00')
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) str += 'Z'
    const d = new Date(str)
    return Number.isNaN(d.getTime()) ? null : d
  }

  /** Relative age, or an em dash. Mirrors fmtAgo() in utils/time.js. */
  function fmtAgo(ts, nowMs = Date.now()) {
    const d = parseDbTime(ts)
    if (!d) return '—'
    const diff = Math.floor((nowMs - d.getTime()) / 1000)
    if (diff < 60) return 'just now'
    if (diff < 3_600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86_400) return `${Math.floor(diff / 3_600)}h ago`
    return `${Math.floor(diff / 86_400)}d ago`
  }

  /**
   * Which source a figure came from.
   *
   * ⚠️ An unknown source falls back to the WEAKEST claim, never the strongest.
   * Enemy rows carry no source at all, and calling an estimate "OWN" would
   * have a lead size up a target against a number nobody ever measured.
   */
  function statsSourceLabel(source) {
    return { torn: 'OWN', tornstats: 'TS', bsp: 'BSP' }[source] ?? 'BSP'
  }

  /**
   * Which single stat dominates a build, or null for a balanced one.
   *
   * ⚠️ The threshold is what makes this worth showing. Everyone's largest stat
   * is "largest"; only a stat carrying a THIRD of the whole total says the
   * build is lopsided — a defence wall, or a speed build that cannot take a
   * hit. Below that the colour would fire on every row and mean nothing.
   */
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

  /**
   * Battle-stat score: the sum of square ROOTS, not of the stats.
   *
   * ⚠️ Kept identical to battleStatsScore() in frontend/src/utils/fairFight.js.
   * A userscript cannot import it — one file, no build step — so the maths is
   * duplicated and must stay in step. If the two ever disagree, the script and
   * the War Room show different FF for the same target, and the member with
   * both screens open believes the wrong one.
   *
   * With only a total (a BSP estimate gives one number, not four) an even split
   * is assumed: 4 × √(total/4) = 2√total. That flatters lopsided builds and so
   * overstates FF; the dashboard makes the same trade deliberately.
   */
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

  /**
   * FF for hitting `defender`, given our own stats. Null when either is unknown.
   *
   * Null is load-bearing, exactly as in the dashboard: FF drives target choice,
   * and inventing a number sends someone at a target that pays nothing.
   */
  function fairFight(mine, theirs) {
    const attacker = statScore(mine)
    const defender = statScore(theirs)
    if (attacker === null || defender === null || attacker <= 0) return null
    return Math.min(3, 1 + (8 / 3) * (defender / attacker))
  }

  /**
   * The battle stats carried on a war_room_state_v2 row.
   *
   * Returns a shape even when the total is unknown, so the cell can render the
   * War Room's dim `???` rather than vanishing — an empty cell reads as "this
   * script is broken", a `???` reads as "nobody has spied them".
   */
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
      // ts_spy_at is when the SPY happened; bsp_fetched_at is when we polled.
      // Only a TornStats row has a real spy time; the rest date from the fetch.
      spiedAt: (isTs && row.ts_spy_at) ? row.ts_spy_at : (row.bsp_fetched_at ?? row.ts_spy_at ?? null),
    }
  }

  /**
   * Member ids that are NOT ours.
   *
   * ⚠️ The war page lists both factions and dibs are enemy-only — a claim
   * button beside a teammate is nonsense and a support ticket. The socket's
   * `state` rows carry faction_id, so this comes from data rather than from
   * guessing which part of the DOM a row sits in.
   */
  function enemyIds(stateRows, ourFactionId, opponentId) {
    const out = new Set()
    for (const row of stateRows ?? []) {
      // ⚠️ Roster rows are tombstoned, not removed — 478 of forge's 672 on
      // 2026-08-19 were dead. A tombstoned row is someone who has LEFT, and
      // offering a dib on them is offering a target that is not in the war.
      if (row.deleted_at) continue
      if (String(row.faction_id) === String(ourFactionId)) continue
      // ⚠️ "Not ours" is not the same as "the enemy". war_room_state_v2 is not
      // pruned when a war ends — forge was holding rosters for SIX factions on
      // 2026-08-17, four of them from wars months gone. Without this the script
      // offers dibs on people nobody is fighting. The opponent comes from the
      // config channel, which names exactly one faction.
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

  /**
   * How long to wait before the next poll.
   *
   * A hidden tab is a tab nobody is claiming targets in, and the API is shared
   * by every member of the faction at once during a war.
   */
  function pollDelay(hidden) {
    return hidden ? POLL_HIDDEN_MS : POLL_MS
  }

  /**
   * The claims carried in our session token.
   *
   * ⚠️ Read for UI ONLY. The token is signed and we do not verify it here —
   * we cannot, the secret is server-side — so a member could edit their stored
   * session and hand themselves `is_admin`. That buys nothing: the server's
   * DELETE handler filters to `claimed_by = you` for anyone it does not
   * consider an admin, so the forged click releases nothing. Never promote
   * this to an actual guard.
   */
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

  /** Can this session take a dib off someone else? Mirrors the server's isAdmin. */
  function sessionIsAdmin(session) {
    return tokenClaims(session?.token).is_admin === true
  }

  /**
   * What the control should say and do, given who holds the target.
   *
   * ⚠️ Mirrors dibsButtonState() in frontend/src/utils/dibsButton.js verbatim.
   * A userscript is one file with no build step and cannot import it, so the
   * two copies have to be kept in step by hand — and the failure mode is the
   * War Room and Torn disagreeing about whether a click releases a claim,
   * mid-war, which nobody would think to check.
   */
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

  /**
   * Does the stored session belong to whoever is logged into this tab?
   *
   * ⚠️ Dibs are attributed from the session, not the page. A token left over
   * from another account files claims under the wrong person SILENTLY — the
   * claim succeeds, it is just credited to someone else. Unknown page identity
   * returns true: refusing to work because we could not read the sidebar would
   * be worse than the risk.
   */
  function identityMatches(sessionUserId, pageUserId) {
    if (!sessionUserId || !pageUserId) return true
    return String(sessionUserId) === String(pageUserId)
  }

  // ── Roster intelligence (#525, #515) ─────────────────────────────────────
  //
  // ⚠️ Everything below renders data that ALREADY arrives on the delta poll.
  // war_room_state_v2 rows carry the whole `state` jsonb memberState() writes
  // on every roster sync — last_action, status, is_revivable, revive_setting,
  // is_on_wall — plus travel_departed_at. The script used to read only the
  // battle-stat columns off those rows and discard the rest. No new endpoint,
  // no extra Torn call, no second API key: that is the entire argument for
  // doing this here rather than keeping Wall Battlestats, which re-polls
  // /v2/faction/{id}/members every 15s per faction to learn what we are already
  // told.

  /** Torn's published flight-time variance: up to ±3%. */
  const TRAVEL_VARIANCE = 0.03

  /**
   * Flight times in seconds, by destination and method.
   *
   * ⚠️ A verbatim copy of FLIGHT_SECONDS in frontend/src/utils/warRoomTravel.js,
   * and it must stay one. Same standing rule as statScore(): a userscript is a
   * single file with no build step, so the maths is duplicated rather than
   * imported, and the moment the two drift a member with both screens open sees
   * two different landing times and believes the wrong one.
   */
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

  /**
   * `status.plane_image_type` → travel method.
   *
   * ⚠️ This is where we beat the reference scripts rather than copy them. CAT
   * has four speed tiers but the tier is a GLOBAL USER SETTING — one assumption
   * applied to every traveller on the board, so its ETA is confidently wrong
   * for anyone flying differently. Torn tells us the aircraft per member, so we
   * read it per member.
   */
  const PLANE_TYPE_METHOD = { airliner: 'business', light_aircraft: 'airstrip', private_jet: 'wlt' }

  /** Destination names Torn uses in more than one form. */
  const DESTINATION_ALIASES = {
    'united arab emirates': 'uae',
    'uk': 'united kingdom',
    'great britain': 'united kingdom',
    'cayman': 'cayman islands',
  }

  /**
   * Substring → short code, in match order.
   *
   * Lifted from Wall Battlestats' getCountryCode(): tedious, already correct,
   * and it matches on stems (`argentin`, `canad`, `mexic`) so it survives both
   * the country and the demonym Torn uses in hospital descriptions.
   *
   * ⚠️ Order matters. 'south africa' must be tested before nothing else claims
   * it, and the stems must not be shortened further — 'can' would match
   * "Cayman".
   */
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

  /**
   * The country whose flight time applies, or null.
   *
   * A return leg takes the same time as the outbound, so the answer is
   * whichever end of the route is not Torn. Copied from warRoomTravel.js.
   */
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
    // Unknown destination → null, so the caller shows nothing rather than an
    // estimate built on a duration we invented.
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

  /**
   * Estimated arrival for a traveller. Copied from warRoomTravel.js.
   *
   * Returns { state: 'unknown' } | { state: 'overdue' }
   *       | { state: 'estimate', earliestSec, latestSec, methods }
   */
  function travelEta({ description, planeType, departedAt, nowMs = Date.now() } = {}) {
    const destination = travelDestination(description)
    // ⚠️ parseDbTime, never Date.parse — the #140 bare-offset trap. It shipped
    // in the dashboard's own copy of this and meant the feature never rendered
    // a single estimate in production.
    const parsed = departedAt ? parseDbTime(departedAt) : null
    const departed = parsed ? parsed.getTime() : NaN
    if (!destination || !Number.isFinite(departed)) return { state: 'unknown' }

    const times = FLIGHT_SECONDS[destination]
    const elapsed = (nowMs - departed) / 1000
    if (elapsed < 0) return { state: 'unknown' }

    // Eliminate a method only once its UPPER bound has passed — cutting at the
    // nominal figure rules out a flight legitimately still in the air on the
    // slow side of the variance.
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

  /**
   * A duration as a countdown: 1h23m over an hour, 45m12s under it, 9s at the end.
   *
   * ⚠️ Seconds are dropped above an hour on purpose. The cell is a handful of
   * pixels wide and "1h23m45s" does not fit; nobody planning around an 83-minute
   * hospital stay needs the seconds, and everybody watching the last minute of
   * one does.
   */
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
    // Always prefixed ~: this number is INFERRED and must not read like the
    // exact hospital countdown sitting beside it in the same column.
    return `~${fmtCountdown(mid)}`
  }

  /**
   * How long since their last action, at a glance: 3m, 2h, 4d.
   *
   * Torn's last_action.relative is already a string ("3 minutes ago") but it is
   * far too wide for the cell and stops updating between polls; the timestamp
   * ticks locally.
   */
  function fmtLastActionShort(lastAction, nowMs = Date.now()) {
    const ts = Number(lastAction?.timestamp)
    if (!Number.isFinite(ts) || ts <= 0) return null
    const diff = Math.max(0, Math.floor(nowMs / 1000 - ts))
    if (diff < 60) return `${diff}s`
    if (diff < 3600) return `${Math.floor(diff / 60)}m`
    if (diff < 86_400) return `${Math.floor(diff / 3600)}h`
    return `${Math.floor(diff / 86_400)}d`
  }

  /**
   * Activity, as a tone name. Torn reports Online / Idle / Offline.
   *
   * ⚠️ This is the one signal that costs NO horizontal space, which is why it
   * goes on the name rather than in a cell. Our column is a fixed 132px inside
   * Torn's float layout (#511) and there is no room for another field — a cell
   * that grows overflows the row and drops the enemy list below our own.
   */
  function activityTone(state) {
    const s = String(state?.last_action?.status ?? '').toLowerCase()
    if (s === 'online') return 'online'
    if (s === 'idle') return 'idle'
    if (s === 'offline') return 'offline'
    return null
  }

  /**
   * Who can actually revive this member right now: 'anyone' | 'friends' | null.
   *
   * ⚠️ Kept identical to reviveAudience() in frontend/src/utils/warRoomFlags.js,
   * including the #342 decision that an UNKNOWN setting means 'anyone'. Torn
   * reports Unknown when it will not disclose the preference, which is the
   * normal case for an enemy — i.e. most of the roster. Degrading that to
   * 'friends' paints the whole enemy side muted and buries the real
   * distinction, which is that we hire OUTSIDE revivers: a target set to
   * "Friends & faction" is revivable in Torn's sense but not by anyone we can
   * pay.
   */
  function reviveAudience(state) {
    if (!state?.is_revivable) return null
    const setting = state.revive_setting
    if (setting === 'No one') return null
    if (setting === 'Friends & faction') return 'friends'
    return 'anyone'
  }

  /**
   * Everything the Status cell should say for one member, or null when we know
   * nothing and Torn's own text must stand.
   *
   * Returns { kind, text, tone, title }.
   *
   * ⚠️ `kind` is OUR cached reading and the caller must treat Torn's own status
   * class as authoritative when the two disagree (#515). The roster is up to
   * three seconds stale, and a member who just left hospital must not keep
   * counting down on a page that already knows better.
   */
  function statusView(entry, nowMs = Date.now()) {
    const st = entry?.status
    const kind = st?.state
    if (!kind) return null

    if (kind === 'Hospital' || kind === 'Jail') {
      const untilSec = Number(st.until)
      if (!Number.isFinite(untilSec) || untilSec <= 0) return null
      const left = untilSec - Math.floor(nowMs / 1000)
      // Expired by our clock: say Okay rather than 0s. The next poll will agree
      // within three seconds, and a stuck 0s reads as a frozen script.
      if (left <= 0) return { kind: 'okay', text: 'Okay', tone: 'okay', title: st.description ?? '' }
      const clock = fmtCountdown(left)
      // An abroad hospital stay is a different proposition from a local one —
      // they cannot be hit OR revived by anyone at home until they fly back.
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
      // The cell Torn leaves nearly empty is exactly the cell where last action
      // matters, so this is where it goes — no width added anywhere.
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

  /**
   * Sort rank for a status: lower is more attackable.
   *
   * Folded into ONE number with the release time so the comparator stays a
   * plain subtraction — rank dominates, and members in the same state are
   * ordered by who is out first.
   */
  const STATUS_RANK = { okay: 0, hospital: 1, jail: 2, traveling: 3, abroad: 4 }

  function statusSortValue(entry, nowMs = Date.now()) {
    const view = statusView(entry, nowMs)
    if (!view) return null
    const rank = STATUS_RANK[view.kind] ?? 5
    const until = Number(entry?.status?.until)
    return rank * 1e11 + (Number.isFinite(until) && until > 0 ? until : 0)
  }

  /**
   * Order rows for our sort control. PURE — takes precomputed values.
   *
   * `entries` is [{ id, pos, value }] where `pos` is the row's ORIGINAL index.
   *
   * ⚠️ Unknown values sort LAST in both directions, never first. Half a war
   * roster has no battle stats on record, and an ascending sort that opens with
   * two hundred `???` rows has buried the answer rather than found it.
   *
   * ⚠️ `pos` is the tiebreak, which is what makes this stable across repeated
   * sorts. Without it two members on the same value swap places every repaint
   * and the list visibly churns.
   */
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

  /** Click cycle for a sort header: off → descending → ascending → off. */
  function nextSort(current, key) {
    if (current?.key !== key) return { key, dir: -1 }
    if (current.dir === -1) return { key, dir: 1 }
    return { key: null, dir: 0 }
  }

  /**
   * The war_room_state_v2 fields we keep, flattened.
   *
   * travel_departed_at is a COLUMN, not part of the `state` jsonb — the ticker
   * latches it when the roster poll observes the transition into Traveling
   * (#330), and the ETA is meaningless without it.
   */
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

  /**
   * Key → faction → tenant → JWT.
   *
   * Torn is asked FIRST, deliberately: the tenant cannot be chosen without the
   * faction id, and asking a dashboard which faction a key belongs to would
   * mean posting the key to a server that might not be the right one.
   */
  async function establishSession(apiKey) {
    // ⚠️ /v2/key/info, NOT v1 `user/?selections=basic`. The v1 basic selection
    // returns player_id, name, level, gender and status and NO FACTION — the
    // first version of this script used it and every login failed with "Torn
    // reports no faction for that key", which sounds like a problem with the
    // key rather than with the request.
    //
    // key/info is also what the server's own verifyTornKey calls, so the script
    // and the dashboard agree about a key by construction. faction_id is a FLAT
    // property on info.user there (not nested under a faction object), and the
    // access level comes back in the same call, which is what lets a Public key
    // be named as such below instead of failing later as a vague login error.
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
        // ⚠️ ONLY when there IS a body. Sending `content-type: application/json`
        // on a bodyless request makes Fastify parse a zero-length body as JSON
        // and answer 400 FST_ERR_CTP_EMPTY_JSON_BODY — before the route is ever
        // reached. That is what broke release-from-Torn while release from the
        // War Room kept working: the SPA's apiDelete sends no content-type, and
        // this sent one on every request. GET was unaffected because Fastify
        // does not parse a body it never expects, so the fault looked specific
        // to DELETE and therefore looked like a permissions problem.
        ...(body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${rt.session.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  /**
   * Trade a stale token for a fresh one.
   *
   * ⚠️ A session token LIVES 30 days but only ACTS for 24 hours: the server
   * rejects anything whose `iat` is older than SESSION_FRESH_SECONDS, so that a
   * member removed from the faction loses access within a day (#119). The SPA
   * has always done this exchange silently; this script did not, so it worked
   * beautifully for one day and then answered 401 to everything, with an
   * `expires_at` a month away insisting the session was fine.
   */
  async function refreshToken() {
    log('token is stale — refreshing')
    const res = await gmRequest({
      method: 'POST',
      url: `https://${rt.session.host}/api/auth/refresh`,
      headers: { authorization: `Bearer ${rt.session.token}` },
    })
    if (res.status !== 200 || !res.body?.token) {
      // 401 means even the signature is past saving; 403 means the member lost
      // faction access. Either way there is nothing to refresh into, and
      // holding a dead token would just 401 forever.
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

  /**
   * An authenticated call, with one automatic retry after a refresh.
   *
   * `retried` is what stops a dead session becoming a refresh storm: the second
   * 401 is returned to the caller, which gives up rather than asking again.
   * /api/auth/refresh is rate limited to 10/min, and the poll loop runs every
   * three seconds.
   */
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
      // ⚠️ The server's word is final. Show who actually has it rather than
      // retrying — a retry here is how a client turns a lost race into a storm.
      const owner = res.body?.owner
      if (owner) rt.dibs.set(targetId, { by: owner.id, name: owner.name })
      render()
      return { ok: false, message: res.body?.error || 'Already claimed' }
    }
    if (res.status !== 200) return { ok: false, message: res.body?.error || `HTTP ${res.status}` }

    // ⚠️ Paint it NOW. The file header has always said "paint optimistically,
    // let the server's answer always overwrite" — but nothing here wrote to
    // rt.dibs, so the render() that follows a click repainted from unchanged
    // state and the button snapped straight back to "+ Dibs". It then sat
    // wrong until a poll happened to carry the row: up to POLL_MS plus a round
    // trip, for an action the user had already completed. The claim reached
    // the server in under 300ms; only the button was slow.
    //
    // The single-dibs rule is mirrored too, otherwise you briefly hold two.
    for (const [target, dib] of rt.dibs) {
      if (String(dib.by) === String(rt.session?.userId)) rt.dibs.delete(target)
    }
    rt.dibs.set(targetId, { by: rt.session?.userId, name: 'You' })
    pokePoll()
    return { ok: true }
  }

  async function release(targetId) {
    const res = await api(`/api/war-room/dibs/${targetId}`, 'DELETE')
    // The server's own wording where it gave one — `HTTP 400` on the badge
    // tooltip told us nothing, and the 400 above went unexplained for a release.
    if (res.status !== 200) {
      return { ok: false, message: res.body?.message ?? res.body?.error ?? `HTTP ${res.status}` }
    }
    rt.dibs.delete(targetId)     // optimistic; covers an admin override too
    pokePoll()
    return { ok: true }
  }

  /**
   * Read again immediately instead of waiting out the scheduled poll.
   *
   * Used right after a write: the optimistic paint above is this client's
   * guess, and the sooner the server's version lands the shorter the window in
   * which the guess could be wrong.
   */
  function pokePoll() {
    if (!rt.polling || !rt.poke) return
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null }
    rt.poke()
  }

  /**
   * Fold one full set of channels — a socket snapshot or a poll response — into
   * the runtime. Both transports land here so they cannot drift apart.
   */
  function applyChannels(body) {
    const stateRows = frameRows(body?.state)
    const dibRows = frameRows(body?.dibs)
    const opponent = opponentFrom(frameRows(body?.config))

    // A new opponent invalidates everything we know: the previous war's roster
    // is still in the table and its members must stop being badgeable.
    if (opponent !== null && opponent !== rt.opponentId) {
      log(`opponent is now faction ${opponent} (was ${rt.opponentId ?? 'unknown'}) — resetting`)
      rt.opponentId = opponent
      rt.enemies = new Set()
      rt.dibs = new Map()
    }

    indexDibs(dibRows, rt.dibs)
    for (const id of enemyIds(stateRows, rt.ourFactionId, rt.opponentId)) rt.enemies.add(id)

    // Battle stats ride along on the rows we already have — no extra request,
    // no TornStats key. Our own row is in here too, which is what makes FF
    // computable client-side.
    //
    // ⚠️ And so does everything else (#525). These rows carry the full `state`
    // jsonb; the script used to take the four stat columns and drop the rest on
    // the floor, then Wall Battlestats re-fetched the same facts from Torn.
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
    // A tombstone in a delta means that member left mid-war. Adding is not
    // enough: the set only ever grew, so their badge would outlive them.
    for (const row of stateRows) {
      if (!row.deleted_at) continue
      const id = Number(row.member_id)
      rt.enemies.delete(id)
      // Drop the cached state too, or a departed member keeps a live countdown
      // that nothing will ever update again.
      rt.state.delete(id)
    }

    // ⚠️ Energy and cooldowns, when the server sends them at all. Two hard
    // limits, both upstream of anything we can do here:
    //   • OUR OWN MEMBERS ONLY. Torn's `bars` and `cooldowns` are SELF-only
    //     selections — a teammate's energy needs that teammate's own key, and
    //     an enemy's cannot be read at any price. This can never appear on an
    //     enemy row.
    //   • LEAD-ONLY. `memberstats` is in LEAD_ONLY_CHANNELS (warRoom.ts); for a
    //     non-lead the server does not filter it out, it never reads it. An
    //     empty map here is the correct outcome for most of the faction, not a
    //     failure to render.
    for (const row of frameRows(body?.memberstats)) {
      const id = Number(row.member_id)
      if (Number.isFinite(id) && id > 0) rt.mstats.set(id, row)
    }
    log(`${stateRows.length} roster rows, ${dibRows.length} dib rows →`,
      `${rt.enemies.size} enemies, ${rt.dibs.size} live claims`,
      `(opponent ${rt.opponentId ?? 'unknown'})`)
    render()
  }

  /**
   * One poll of the REST read path, over the privileged transport.
   *
   * `since` is always the server's own `server_now` from the previous response,
   * never a client clock — the endpoint is explicit about that, and a browser
   * running a few seconds fast would silently skip rows forever.
   */
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
      // ⚠️ One read at a time, always. tick() awaits a request, so anything
      // that calls it while one is in flight — the visibility listener, a
      // claim's pokePoll() — starts a SECOND self-scheduling chain, and from
      // then on every poll happens twice, forever. That is exactly what the
      // console showed after the first alt-tab: paired requests all the way
      // down, doubling the load on the tenant for no extra freshness.
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

      // Someone asked to read while we were busy. Honour it once, now, rather
      // than dropping the request or spawning a parallel loop for it.
      if (rt.pending) { rt.pending = false; rt.timer = setTimeout(tick, 0); return }

      // ⚠️ Back off on consecutive failures rather than hammering every 3s.
      // A tenant that is mid-deploy answers 502 for a minute or two, and every
      // member of the faction is running this at once during a war.
      const hidden = typeof document !== 'undefined' && document.hidden
      if (ok) rt.attempt = 0
      const wait = ok ? pollDelay(hidden) : Math.max(backoffFor(rt.attempt++), pollDelay(hidden))
      rt.timer = setTimeout(tick, wait)
    }

    // Coming back to the tab reads immediately rather than waiting out whatever
    // delay was scheduled while it was hidden. Without this, alt-tabbing in
    // during a fight means up to POLL_HIDDEN_MS of badges that are quietly
    // wrong — the worst possible moment for a stale claim.
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

  /**
   * Our column's width, in px. FIXED, and that is the whole point (#511).
   *
   * ⚠️ Torn's war table is a FLOAT layout with fixed per-column widths. A cell
   * that grows with its content overflows the row, the last float wraps, and
   * the enemy list drops BELOW our own faction's list instead of sitting beside
   * it. Room is made by narrowing Torn's own columns in the injected stylesheet
   * — never by adding width here.
   */
  const COL_WIDTH = 104
  /**
   * The dibs control's share of it — also fixed, so its left edge never moves.
   *
   * ⚠️ 50, not 78, and the number is measured rather than chosen: it is exactly
   * CAT's `.call-column`. Their whole control fits in 50px because the button
   * inside it is `width:auto; min-width:28px; max-width:40px` and TRUNCATES the
   * holder's name to an ellipsis, leaning on colour to say whose it is and on
   * the tooltip to say who exactly. Ours was a full-width block sized to keep a
   * name legible, which is what pushed the row over.
   */
  const DIBS_WIDTH = 50
  /** Below this the stats half is hidden and only dibs survives. */
  const NARROW_PX = 1000
  const COL_CLASS = 'tnl-col'
  const COL_HEAD_CLASS = 'tnl-col-head'
  const DIBS_SLOT_CLASS = 'tnl-col-dibs'
  /** Badge state classes — see paintDibs(). */
  const MINE_CLASS = 'tnl-mine'
  const TAKEN_CLASS = 'tnl-taken'
  const STAT_SLOT_CLASS = 'tnl-col-bs'
  const STYLE_ID = 'tnl-dibs-style'
  /** Marks a name we have tinted, so the tint can be lifted cleanly (#525). */
  const TINT_CLASS = 'tnl-tint'
  /** Marks a Status cell we have taken over (#515). */
  const STATUS_CLASS = 'tnl-status'
  /** A header cell bound to our sort control. */
  const SORT_CLASS = 'tnl-sort'

  /**
   * Activity colours. Green / amber / grey is the convention every Torn script
   * uses for Online / Idle / Offline, and matching it means a member does not
   * have to learn ours.
   */
  const TINT_COLORS = { online: '#4ade80', idle: '#facc15', offline: '#9ca3af' }

  /** Status-cell tones. Muted deliberately — the cell is scanned, not read. */
  const STATUS_COLORS = {
    okay: '#9ca3af', hospital: '#f87171', jail: '#fb923c',
    traveling: '#60a5fa', abroad: '#22d3ee',
  }

  /**
   * One stylesheet, injected once.
   *
   * Everything that does not change per row lives here rather than in inline
   * `style.cssText` per element. That is not tidiness: `render()` runs every
   * poll over every row, and each inline style write after a DOM read forces a
   * synchronous layout (#516). A class costs one write, once.
   *
   * ⚠️ The row rules are lifted from `Wall Battlestats Colored`, which has done
   * this correctly through years of Torn's churn. `clear: both` and the
   * `::after` clearfix are what keep a row from collapsing once it holds one
   * more float than Torn designed it for.
   */
  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = `
ul.members-list > li, .table-body > .table-row { clear: both !important; width: 100% !important; position: relative; }
ul.members-list > li::after { content: ""; display: table; clear: both; }

/* Room is made by NARROWING Torn's columns, not by widening the row. */
.members-cont .level { width: 27px !important; }

.${COL_CLASS}, .${COL_HEAD_CLASS} {
  width: ${COL_WIDTH}px; min-width: ${COL_WIDTH}px; max-width: ${COL_WIDTH}px;
  flex: 0 0 ${COL_WIDTH}px;
  display: inline-flex; align-items: center; gap: 6px;
  box-sizing: border-box; padding: 0 4px;
  vertical-align: middle; white-space: nowrap;
  position: relative; z-index: 1;
}
.${COL_HEAD_CLASS} { font-weight: 700; opacity: .85; }

.${DIBS_SLOT_CLASS} {
  width: ${DIBS_WIDTH}px; min-width: ${DIBS_WIDTH}px; max-width: ${DIBS_WIDTH}px;
  flex: 0 0 ${DIBS_WIDTH}px;
  text-align: left;
}
.${STAT_SLOT_CLASS} {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis;
  font-size: 11px; font-weight: 700; text-align: right; cursor: help;
}

/* ⚠️ Lifted from CAT's `.call-button`, dimensions and all. Ours was a
   full-width pill sized so a holder's name stayed legible inside it, and that
   is what kept overflowing Torn's float row. CAT's answer is the opposite
   trade and it is the right one: a small fixed-height chip that truncates hard,
   with COLOUR carrying whose claim it is and the tooltip carrying the name. */
.${BADGE_CLASS} {
  /* ⚠️ position + z-index are load-bearing. Torn's cells paint over anything
     overflowing a neighbour, so a statically-positioned badge ends up UNDER
     the next column: visible, and unclickable. */
  position: relative; z-index: 2147483000; isolation: isolate; pointer-events: auto;
  display: inline-block; box-sizing: border-box;
  width: auto; min-width: 28px; max-width: 40px; height: 22px;
  flex: 0 0 auto;
  padding: 4px 2px;
  border: 1px solid #111; border-radius: 3px;
  font-size: .65em; font-weight: 600; line-height: normal; letter-spacing: .3px;
  text-transform: uppercase; text-align: center; text-shadow: 0 0 5px #000;
  color: #eee; cursor: pointer;
  background: linear-gradient(180deg, #111 0%, #555 25%, #333 60%, #333 78%, #111 100%);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background .15s ease;
}
.${BADGE_CLASS}:hover {
  background: linear-gradient(180deg, #333 0%, #777 25%, #333 59%, #666 78%, #333 100%);
  color: #fff; text-shadow: 0 0 5px rgba(255,255,255,.25);
}
.${BADGE_CLASS}:active { background: linear-gradient(180deg, #000 0%, #333 100%); }

/* ⚠️ State is a CLASS, not an inline style. paintDibs() runs per row per poll,
   and every inline style write after a DOM read forces a synchronous layout —
   the #516 fault. Three class swaps cost nothing. */
.${BADGE_CLASS}.${MINE_CLASS} {
  background: linear-gradient(180deg, #1e4400 0%, #5a9a00 25%, #4a7a00 60%, #4a7a00 78%, #1e4400 100%);
  color: #fff; border-color: #1a3000;
}
.${BADGE_CLASS}.${MINE_CLASS}:hover {
  background: linear-gradient(180deg, #2e5500 0%, #6aaa00 25%, #4a7a00 59%, #5a9a00 78%, #2e5500 100%);
}
.${BADGE_CLASS}.${TAKEN_CLASS} {
  background: linear-gradient(180deg, #2e1008 0%, #6b2e1a 25%, #4d2010 60%, #4d2010 78%, #2e1008 100%);
  color: rgba(243,117,75,.9); border-color: #1a0800; cursor: not-allowed;
}
.${BADGE_CLASS}.${TAKEN_CLASS}:hover {
  background: linear-gradient(180deg, #2e1008 0%, #6b2e1a 25%, #4d2010 60%, #4d2010 78%, #2e1008 100%);
}

/* ⚠️ Room is made by NARROWING Torn's own columns, exactly as CAT does — the
   score column is 50px there and the level column caps at 30px. Widening our
   own cell to fit is the thing that wraps the float and drops the enemy list
   below our own faction's (#511). */
.members-cont [class*="points___"]:not([class*="tab___"]),
.white-grad > [class*="points___"] {
  width: 50px !important; max-width: 50px !important; flex: 0 0 50px !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
}

/* ⚠️ Tinting the NAME, not adding a cell. There is no width left (#511), and
   colour on something already on the row is free. !important because Torn's own
   rules for the name link are more specific than anything we can write here. */
.${TINT_CLASS} { color: var(--tnl-tint) !important; }

/* Our takeover of Torn's Status cell keeps Torn's own box model — we only
   rewrite the text and recolour it, so nothing about the row's geometry moves. */
.${STATUS_CLASS} {
  color: var(--tnl-status) !important;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.${SORT_CLASS} { cursor: pointer; user-select: none; }
.${SORT_CLASS}:hover { text-decoration: underline; }

/* ⚠️ The stats half goes first when space runs out — dibs is the point of the
   script, and a member on a phone still needs to claim a target. */
@media screen and (max-width: ${NARROW_PX}px) {
  .${STAT_SLOT_CLASS}, .${COL_HEAD_CLASS} .${STAT_SLOT_CLASS} { display: none; }
  .${COL_CLASS}, .${COL_HEAD_CLASS} {
    width: ${DIBS_WIDTH + 8}px; min-width: ${DIBS_WIDTH + 8}px; max-width: ${DIBS_WIDTH + 8}px;
    flex-basis: ${DIBS_WIDTH + 8}px;
  }
}
`
    ;(document.head || document.documentElement).appendChild(el)
    log('stylesheet injected')
  }

  /**
   * The row an anchor belongs to.
   *
   * ⚠️ Matched on structure, not on a class name. Torn's class names are
   * hashed per build (`row___a1b2c`) and change without notice; "the ancestor
   * that is a list item or table row" has been true for years. Same reasoning
   * as parseXid reading the href.
   */
  function rowOf(anchor) {
    // ⚠️ NOT [class*="row"]. Torn wraps the name in
    // `<div class="userInfoBox___SpD9F rowSection___wdqaD">`, which that
    // selector matches — so closest() returned the NAME CELL, and every column
    // we inserted landed inside it, on top of the player's name. The war rows
    // really are <li>; `row___` (with Torn's hashed triple underscore) is the
    // fallback for any table that is not a list.
    return anchor.closest?.('li, tr') ?? anchor.closest?.('[class*="row___"]') ?? null
  }

  /** The Attack cell — the anchor our column is inserted before. */
  function attackCellOf(row) {
    return row?.querySelector?.('.attack, [class*="attack__"], [class*="attack___"]') ?? null
  }

  /**
   * The header row of the table a war row belongs to.
   *
   * ⚠️ Torn's war-table header is the element immediately BEFORE the list —
   * `<div class="white-grad c-pointer">` holding .member/.level/.points/
   * .status/.attack. It carries no `table-header` class at all, which is why
   * looking for one found nothing and the columns went unheaded for weeks.
   *
   * ⚠️ There used to be a SECOND copy of this function further down the file,
   * left behind by a bad splice. Later declarations win, so the copy that only
   * looked for `.table-header` was the one that ran, and this one — the correct
   * one — was dead code the whole time.
   */
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
    // Fall back to matching the word, since the header cell is sometimes a
    // plain div with no distinguishing class at all.
    for (const cell of header.children) {
      if ((cell.textContent || '').trim().toLowerCase() === 'attack') return cell
    }
    return null
  }

  /** True for anything this script put on the page — see observe(). */
  function isOurs(node) {
    return Boolean(node?.closest?.(`.${COL_CLASS}, .${COL_HEAD_CLASS}, #${STYLE_ID}`))
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

  /**
   * ONE combined TNL column — dibs and battle stats together — inserted in the
   * row's own flow immediately left of Attack, with a matching header cell.
   *
   * ⚠️ Not two columns, and not nested inside Torn's Attack cell. Both of those
   * were tried. Two columns cost ~140px per row and wrapped the float, which is
   * what pushed the enemy table below our own; nesting inside `.attack` put the
   * control on top of the Attack link and left the header cells missing
   * entirely, because a nested element has no header to align with.
   *
   * Anchored to the Attack cell rather than to a position or a member icon:
   * Attack is the one cell every one of these tables has, and its class is the
   * only name on the row that has stayed put across Torn's builds.
   */
  function tnlCellOf(row) {
    let cell = row.querySelector(`.${COL_CLASS}`)
    if (cell) return cell

    const header = headerFor(row)
    if (header && !header.querySelector(`.${COL_HEAD_CLASS}`)) {
      const before = attackHeaderCell(header)
      const head = document.createElement(header.tagName.toLowerCase() === 'ul' ? 'li' : 'div')
      head.className = `table-cell ${COL_HEAD_CLASS}`
      slot(head, DIBS_SLOT_CLASS, 'DIBS')
      // The BS header is also the sort control — one click to order the whole
      // war table by battle stats, which is the point of showing them.
      bindSort(slot(head, STAT_SLOT_CLASS, 'BS'), 'bs', 'BS')
      if (before) before.parentNode.insertBefore(head, before)
      else header.appendChild(head)
      log(`column header added${before ? ' before Attack' : ' at the end (no Attack header found)'}`)
    }

    cell = document.createElement(row.tagName.toLowerCase() === 'li' ? 'span' : 'div')
    cell.className = `table-cell ${COL_CLASS}`
    slot(cell, DIBS_SLOT_CLASS)
    slot(cell, STAT_SLOT_CLASS)
    const attack = attackCellOf(row)
    if (attack) attack.parentNode.insertBefore(cell, attack)
    else row.insertBefore(cell, row.querySelector('.clear'))   // never after the float clear
    return cell
  }

  function badgeFor(cell, playerId) {
    const host = cell.querySelector(`.${DIBS_SLOT_CLASS}`)
    if (!host) return null
    let badge = host.querySelector(`.${BADGE_CLASS}`)
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
    host.appendChild(badge)
    return badge
  }

  /** Colour for the stat that dominates a build. Matches Wall Battlestats. */
  const STAT_COLORS = { str: '#ef4444', def: '#22c55e', spd: '#60a5fa', dex: '#f59e0b' }

  /**
   * Three states, three readings at a glance, and no lock icon — the colour is
   * the state (#512). Grey: free, take it. Blue: yours, click to release.
   * Orange: someone else's, hands off.
   *
   * ⚠️ A truncated name must stay recoverable. The whole reason for naming the
   * holder is settling a collision in one message in faction chat, so the full
   * name always goes in the tooltip even when the label is clipped.
   */
  function paintDibs(badge, state) {
    if (!badge) return
    badge.textContent = state.label
    badge.classList.toggle(MINE_CLASS, Boolean(state.mine))
    badge.classList.toggle(TAKEN_CLASS, Boolean(state.taken) && !state.mine)
    // ⚠️ The name is now truncated to about five characters, so the tooltip is
    // the ONLY place the holder is fully recoverable — and settling a collision
    // in one message in faction chat is the entire reason for naming them
    // (#512). It has to be set on every state, not just the taken one.
    badge.title = state.mine
      ? 'Yours — click to release'
      : state.taken
        ? `Claimed by ${state.label}${state.action === 'release' ? ' — click to release (admin)' : ''}`
        : 'Claim this target'
  }

  /**
   * Paint one member's stats, the way the War Room paints them.
   *
   * Total in the cell; hover gives the per-stat breakdown when we have one,
   * the total, and "{age} ({SOURCE})" so a lead can see how much to trust it.
   * A BSP row usually has no breakdown, so it shows Total + source alone —
   * the same behaviour as BattleStatsCell rather than four rows of N/A.
   *
   * ⚠️ Exact and estimated readings must not look identical. An own-key figure
   * is measured; TornStats and BSP are guesses of varying age. The dashboard
   * marks that with a solid vs dotted underline, so this does too.
   */
  function paintStats(cell, playerId) {
    if (!cell) return
    if (!settings.on(SETTING_STATS)) {
      cell.textContent = ''
      cell.title = ''
      cell.style.border = '1px solid transparent'
      return
    }
    const stats = rt.stats.get(playerId)
    if (!stats || stats.total === null) {
      cell.textContent = '???'
      cell.style.color = '#6b7280'
      cell.style.fontStyle = 'italic'
      cell.style.textDecoration = 'none'
      cell.style.border = '1px solid transparent'
      cell.title = 'No battle stats on record'
      return
    }

    cell.style.fontStyle = 'normal'
    cell.textContent = formatStat(stats.total)

    const dominant = dominantStat(stats)
    cell.style.color = dominant ? STAT_COLORS[dominant] : '#e5e7eb'

    const exact = stats.source === 'torn'
    cell.style.textDecoration = 'underline'
    cell.style.textDecorationStyle = exact ? 'solid' : 'dotted'
    cell.style.textUnderlineOffset = '2px'
    cell.style.textDecorationColor = exact ? 'rgba(16,185,129,.7)' : 'rgba(148,163,184,.7)'

    const ff = fairFight(rt.mine, stats)
    cell.style.border = settings.on(SETTING_FF_BOX) && ff !== null && ff >= FF_HIGHLIGHT
      ? '1px solid #86efac'
      : '1px solid transparent'

    // Breakdown rows only where we actually have one, exactly as the War Room
    // does — four lines of "N/A" is noise pretending to be data.
    //
    // ⚠️ The dominant stat is MARKED, not bolded (#513). The reference script
    // bolds it, but this is a title attribute — plain text, no markup — so a
    // caret carries the same information rather than pretending we can style it.
    const breakdown = [['str', 'STR', stats.str], ['def', 'DEF', stats.def], ['spd', 'SPD', stats.spd], ['dex', 'DEX', stats.dex]]
      .filter(([, , v]) => v !== null)
      .map(([key, label, v]) => `${label}  ${formatStat(v)}${key === dominant ? '  ◄' : ''}`)

    cell.title = [
      ff === null ? 'FF —' : `FF ${ff.toFixed(2)}`,
      ...breakdown,
      `Total ${formatStat(stats.total)}`,
      `${fmtAgo(stats.spiedAt)} (${statsSourceLabel(stats.source)})`,
      exact ? 'Exact — read from their own key' : '',
    ].filter(Boolean).join('\n')
  }

  /**
   * A row we are willing to touch.
   *
   * ⚠️ rt.nodes indexes EVERY profile link on the page — the sidebar, faction
   * chat, a news item. Tinting those would recolour half of Torn. Matched
   * structurally rather than by class name, for the same reason rowOf() is:
   * a member row is a list item or table row that carries a status or level
   * cell, and that has been true across every one of Torn's rebuilds.
   */
  function isMemberRow(row) {
    const tag = row?.tagName?.toLowerCase?.()
    if (tag !== 'li' && tag !== 'tr') return false
    return Boolean(row.querySelector(
      '.status, [class*="status___"], [class*="status__"], .level, [class*="level___"]'
    ))
  }

  /** Torn's own Status cell for a row. */
  function statusCellOf(row) {
    return row?.querySelector?.('.status, [class*="status___"], [class*="status__"]') ?? null
  }

  /**
   * What TORN says this member's status is — the authority (#515).
   *
   * Read from Torn's class name and from the text Torn last put in the cell,
   * never from what we wrote. Our roster copy is up to three seconds stale, and
   * a member who has just left hospital must not keep counting down on a page
   * that already knows better.
   */
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

  /**
   * Remember what Torn had in the cell before we touched it.
   *
   * ⚠️ Self-healing on purpose. Torn re-renders these rows on its own schedule
   * and will blow our text away; when the text in the cell is not the text WE
   * last wrote, it is fresh from Torn and becomes the new baseline. Stashing it
   * only once would poison the authority check the first time React repainted.
   */
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

  /**
   * Energy and cooldowns, for the tooltip only.
   *
   * ⚠️ Tooltip and nothing else. There is no width for it (#511), it exists for
   * our own members only, and only a lead's poll carries it at all — so a
   * visible column would be blank for most of the faction and misread as broken.
   */
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
    // The #357 latch: cooldown_drug is overwritten every sweep, so an overdose
    // is only recoverable from the absolute expiry the server derived once.
    const od = parseDbTime(m.overdose_until)
    if (od && od.getTime() > Date.now()) out.push('☠ Overdosed')
    return out
  }

  /**
   * Rewrite Torn's Status cell with the live countdown / ETA / last action.
   *
   * Returns true when we own the cell this pass.
   */
  function paintStatus(row, playerId, nowMs) {
    const cell = statusCellOf(row)
    if (!cell) return false
    if (!settings.on(SETTING_STATUS)) { releaseStatusCell(cell); return false }

    rememberTornStatus(cell)
    const entry = rt.state.get(playerId)
    const view = entry ? statusView(entry, nowMs) : null
    if (!view) { releaseStatusCell(cell); return false }

    // ⚠️ Torn wins any disagreement. Our copy is up to a poll old; theirs is the
    // page they just rendered. Deferring costs one stale cell, overriding costs
    // a member queueing a hit on a countdown that already ran out.
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
  function paintName(anchor, playerId) {
    if (!settings.on(SETTING_TINT)) {
      if (anchor.classList.contains(TINT_CLASS)) {
        anchor.classList.remove(TINT_CLASS)
        anchor.style.removeProperty('--tnl-tint')
      }
      return
    }
    const tone = activityTone(rt.state.get(playerId))
    const colour = tone ? TINT_COLORS[tone] : null
    if (!colour) {
      // Guarded, like everything else that runs per row per poll (#516) — an
      // enemy Torn tells us nothing about must not cost two DOM writes a tick.
      if (!anchor.dataset.tnlTint) return
      delete anchor.dataset.tnlTint
      anchor.classList.remove(TINT_CLASS)
      anchor.style.removeProperty('--tnl-tint')
      return
    }
    if (anchor.dataset.tnlTint === tone) return
    anchor.dataset.tnlTint = tone
    anchor.style.setProperty('--tnl-tint', colour)
    anchor.classList.add(TINT_CLASS)
  }

  // ── Sorting ──────────────────────────────────────────────────────────────
  //
  // ⚠️ Nothing here MOVES a DOM node, and that is the whole design. Torn owns
  // these lists and re-renders them on its own schedule; a script that splices
  // rows fights React and loses. Both reference scripts solved it the same way
  // — make the list a flex column and write a CSS `order` onto each row — so
  // the document order Torn maintains is never disturbed and our sort simply
  // survives its next render. Copied deliberately.

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

  /**
   * Permute one list's rows into sorted order using flex `order`.
   *
   * Non-member children (headers, adverts, Torn's own spacers) keep the slot
   * they already occupy; only the member rows are permuted among their OWN
   * slots. Sorting the whole child list instead would drag the header into the
   * middle of the table.
   */
  function orderList(list, nowMs) {
    const children = Array.from(list.children)
    if (!rt.sort.key) {
      if (!list.dataset.tnlFlex) return
      for (const c of children) c.style.order = ''
      list.style.removeProperty('display')
      list.style.removeProperty('flex-direction')
      delete list.dataset.tnlFlex
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
    // ⚠️ THE #516 RULE AGAIN. render() runs every poll and applySort() with it,
    // so writing style.order unconditionally would touch every child of every
    // list every three seconds — the exact synchronous-layout storm the dirty
    // check was added to stop. A settled sort must cost one string compare.
    //
    // ⚠️ …but the signature alone is not enough. When Torn re-renders the list
    // the rows are NEW elements carrying no order at all, while the id sequence
    // is unchanged — so the signature matches, we skip, and the sort silently
    // vanishes on the next thing that touches the table. Checking that the
    // first row still carries an order catches exactly that case.
    if (list.dataset.tnlOrderSig === sig && rows[0].row.style.order !== '') return
    list.dataset.tnlOrderSig = sig

    list.style.display = 'flex'
    list.style.flexDirection = 'column'
    list.dataset.tnlFlex = '1'
    // Document order is the original order — permanently, because we never move
    // a node. That is what makes `pos` a stable tiebreak with nothing to store.
    children.forEach((c, i) => { c.style.order = String(i + 1) })
    const slots = rows.map((r) => r.slot).sort((a, b) => a - b)
    ordered.forEach((e, i) => { e.row.style.order = String(slots[i]) })
  }

  /** Apply the current sort to every member list we have rows on. */
  function applySort(nowMs = Date.now()) {
    const lists = new Set()
    for (const anchors of rt.nodes.values()) {
      for (const anchor of anchors) {
        if (!anchor.isConnected) continue
        const row = rowOf(anchor)
        if (row && isMemberRow(row) && row.parentNode) lists.add(row.parentNode)
      }
    }
    for (const list of lists) orderList(list, nowMs)
  }

  /** Turn a header cell into a sort control. Idempotent. */
  function bindSort(el, key, label) {
    if (!el || el.dataset.tnlSortKey) return
    el.dataset.tnlSortKey = key
    el.dataset.tnlSortLabel = label
    el.classList.add(SORT_CLASS)
    el.addEventListener('click', (e) => {
      // ⚠️ Both, and in this order. Torn's own sort handler is bound by React at
      // the root container, not on this cell, so stopPropagation is what stops
      // it — otherwise every click sorts the table twice, once each way, and
      // the result looks random. stopImmediatePropagation covers a listener
      // bound directly to the cell by another script.
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
    // ⚠️ Once per list, not once per row per poll. headerFor() walks up to the
    // table and back out to its previous sibling; running that 200 times every
    // three seconds to re-discover the same header is the kind of cost #516 was
    // about.
    if (!list || list.dataset.tnlHeaderBound) return
    list.dataset.tnlHeaderBound = '1'
    const header = headerFor(row)
    if (!header) return
    const cell = header.querySelector('.status, [class*="status___"], [class*="status__"]')
    if (cell && !cell.dataset.tnlSortKey) {
      bindSort(cell, 'status', (cell.textContent ?? 'Status').trim() || 'Status')
    }
  }

  function render() {
    injectStyles()
    let painted = 0      // enemies we INTENDED to badge
    let attached = 0     // badges that actually exist in the DOM
    let repainted = 0    // rows whose state actually changed — see #516
    const settingsSig = settingsSignature()   // loop-invariant; read once
    const nowMs = Date.now()
    for (const [playerId, anchors] of rt.nodes) {
      const isEnemy = rt.enemies.has(playerId)
      // ⚠️ Roster intelligence is for BOTH sides (#525). Dibs is enemy-only —
      // a claim button beside a teammate is nonsense — but a hospital
      // countdown, a travel ETA and an activity tint are worth as much on our
      // own faction page as on the war page, and energy/cooldowns only ever
      // exist for our own members.
      const known = rt.state.has(playerId)
      if (!isEnemy && !known) continue
      if (isEnemy) painted++
      const state = buttonState(rt.dibs.get(playerId), rt.session?.userId, rt.isAdmin)
      const sig = paintSignature(state, rt.stats.get(playerId), settingsSig, rt.mine?.total)
      for (const anchor of anchors) {
        if (!anchor.isConnected) continue
        const row = rowOf(anchor)
        if (!row || !isMemberRow(row)) continue

        // Free of the dibs column and free of its width budget, so these run
        // for every row we recognise.
        paintName(anchor, playerId)
        paintStatus(row, playerId, nowMs)
        bindStatusHeader(row)

        if (!isEnemy) continue
        const cell = tnlCellOf(row)
        if (badgeFor(cell, playerId)) attached++
        // ⚠️ THE #516 FIX, half of it. render() used to rewrite ~10 style
        // properties on every one of ~200 rows every 3 seconds, each write
        // landing after a DOM read and so forcing a synchronous layout. Almost
        // none of those rows had changed. Skipping the unchanged ones takes a
        // full-table repaint down to the handful of rows that actually moved.
        if (cell.dataset.tnlSig === sig) continue
        cell.dataset.tnlSig = sig
        repainted++
        paintDibs(cell.querySelector(`.${BADGE_CLASS}`), state)
        paintStats(cell.querySelector(`.${STAT_SLOT_CLASS}`), playerId)
      }
    }
    // ⚠️ The single most useful line when "no badges appeared". It separates
    // the three ways that happens: no profile links found on the page at all,
    // links found but none of them enemies (an empty or mismatched roster), or
    // enemies matched and painted — in which case the problem is CSS, not us.
    // ⚠️ Report BOTH numbers. The old line counted enemies we meant to badge
    // and called it "painted", so a run where every badge failed to attach —
    // rowOf() finding no row, say — still logged a confident "painted 100" and
    // sent us looking at the data instead of at the DOM.
    if (painted !== rt.painted || attached !== rt.attached) {
      rt.painted = painted
      rt.attached = attached
      log(`${attached} badges attached for ${painted} enemies on this page`,
        `(${rt.nodes.size} linked players, ${rt.enemies.size} known enemies,`,
        `${rt.stats.size} with stats)`)
    }
    // Cheap to log and the only way to confirm the dirty check is working on a
    // live page: a steady war room should print single digits, not 200.
    if (repainted > 0) log(`repainted ${repainted} of ${attached} rows`)
    paintSortHeaders()
    applySort(nowMs)
  }

  /**
   * The 1 Hz local tick (#515).
   *
   * ⚠️ Countdowns tick locally rather than by polling. The roster poll is every
   * three seconds and the API is shared by the whole faction during a war; a
   * hospital timer that only moved on a poll would visibly stutter, and moving
   * the poll to 1 Hz to fix that would triple the load on the tenant for a
   * number we can compute ourselves.
   *
   * Only the status cells are repainted here — never the dibs column, whose
   * state cannot change without a poll — and each cell's own signature means an
   * unchanged one costs a string compare.
   */
  function renderTimers() {
    if (typeof document === 'undefined' || document.hidden) return
    const nowMs = Date.now()
    for (const [playerId, anchors] of rt.nodes) {
      if (!rt.state.has(playerId)) continue
      for (const anchor of anchors) {
        if (!anchor.isConnected) continue
        const row = rowOf(anchor)
        if (row && isMemberRow(row)) paintStatus(row, playerId, nowMs)
      }
    }
  }

  function startTimers() {
    if (rt.tick || typeof setInterval !== 'function') return
    rt.tick = setInterval(renderTimers, 1000)
  }

  /**
   * Index the profile anchors under `root`.
   *
   * ⚠️ Does NOT render. It used to, and that was the other half of #516:
   * sorting a column re-adds every row at once, the observer batches those into
   * ~200 touched nodes, and scan() was called once per node — so ONE sort ran
   * render() two hundred times, each pass walking all two hundred rows. The
   * observer now scans each node and renders once, at the end.
   */
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
    // ⚠️ Torn renders these views dynamically, so a single pass at document-end
    // finds an empty page. Same shape as the Battle Stats Predictor observer.
    const observer = new MutationObserver((mutations) => {
      const touched = new Set()
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          // ⚠️ Skip our own insertions. Every column and badge we add is itself
          // a mutation, so without this the observer answers its own work —
          // and on a page that is still rendering, that is a feedback loop
          // running a full scan per element we create.
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
    // ⚠️ Safe to start alongside the observer: our own writes here are text
    // nodes and attributes, and the observer only watches childList for
    // ELEMENT additions — so the countdown cannot answer its own mutations the
    // way scan() once did (#516).
    startTimers()
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  let panelStatus = null
  let panelBox = null
  let panelDot = null

  /**
   * Does the panel need to ask for a key?
   *
   * ⚠️ Pure, exported and tested, because getting this wrong is invisible in
   * review and obvious to a user. The first release asked on EVERY page load,
   * including when a perfectly good session was already stored, because the
   * panel was built before anything had read the store — so the answer was
   * always "no session yet". A saved key looked like it had not saved.
   */
  function panelNeedsKey(session) {
    return !session || !session.token
  }

  /**
   * Should the panel be a full box rather than a dot?
   *
   * Only when it has something to ask for, or when the user opened it. Note the
   * asymmetry: `expanded` cannot suppress the key form. A collapsed dot with no
   * session would be a script that silently does nothing and gives you no way
   * to fix it.
   */
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
    if (panelDot) {
      panelDot.style.background = statusColor(state)
      panelDot.title = `TNL Dibs — ${statusText(state)}`
    }
  }

  /**
   * One labelled checkbox, persisted immediately.
   *
   * Persisted rather than held in memory because the tracing that matters most
   * — the whole startup sequence — happens before any panel exists. Asking a
   * member to type a console command on torn.com is also a worse thing to teach
   * than a checkbox.
   */
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
      // ⚠️ Repaint, do not reload. The setting is in the paint signature, so
      // the dirty check picks up the change on the next pass — but waiting up
      // to a full poll for a checkbox to do anything reads as a broken toggle.
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
    box.appendChild(settingToggle(DEBUG_KEY, 'Debug log (console)', 'Reload to trace startup.'))

    const back = document.createElement('button')
    back.textContent = 'Back'
    back.style.cssText = 'width:100%;margin-top:10px;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
    back.addEventListener('click', () => { rt.settingsOpen = false; panel() })
    box.appendChild(back)
  }

  function panel() {
    // No DOM (unit tests evaluate this file with document undefined): nothing
    // to draw, and the caller should not have to know that.
    if (typeof document === 'undefined') return
    // Rebuildable: the panel changes shape when a session appears or goes away,
    // and the first release never re-rendered it — so after a successful
    // connect the key field stayed on screen next to the word "Connected".
    if (panelBox && panelBox.isConnected) panelBox.remove()
    panelStatus = null
    panelDot = null

    // Signed in? Get out of the way. The panel exists to collect a key and to
    // offer a way out; once there is a session it is a permanent box sitting on
    // top of the war page, which is exactly where you least want one. Collapsed
    // is a status dot and nothing else — click it for the full panel back.
    if (!panelExpanded(rt.session, rt.expanded)) {
      const dot = document.createElement('button')
      panelBox = dot
      panelDot = dot
      dot.type = 'button'
      dot.setAttribute('aria-label', 'TNL Dibs')
      // ⚠️ LEFT, not right. Torn anchors its own chat window to the
      // bottom-right, so that corner is the one place on the page guaranteed
      // to already be occupied — the dot sat on top of the chat tabs (#514).
      dot.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
        'width:14px', 'height:14px', 'padding:0', 'border-radius:50%',
        'border:1px solid rgba(0,0,0,.5)', 'cursor:pointer', 'opacity:.75',
        'box-shadow:0 1px 4px rgba(0,0,0,.5)',
      ].join(';')
      dot.addEventListener('click', () => { rt.expanded = true; panel() })
      setStatus(rt.status)
      document.body.appendChild(dot)
      return
    }

    const box = document.createElement('div')
    panelBox = box
    box.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483000',
      'background:#111827', 'color:#e5e7eb', 'border:1px solid #374151',
      'border-radius:10px', 'padding:10px 12px', 'font:12px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'max-width:260px',
    ].join(';')

    if (rt.settingsOpen) {
      settingsView(box)
      document.body.appendChild(box)
      return
    }

    const title = document.createElement('div')
    title.textContent = 'TNL Dibs'
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
          // Re-render so the key field is replaced by the signed-in panel.
          // Without this the input stayed on screen and the whole thing looked
          // like it had not saved anything. Collapsed, because entering a key
          // is the one moment we can be sure the user is done with this box.
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

    // ⚠️ Nothing may be awaited between here and the first read. The faction id
    // comes from the session, which Torn already told us at login — an early
    // version fetched /api/bootstrap first purely to confirm it, and made the
    // read path hostage to an HTTP round-trip it did not need. When that
    // request hung, so did boot(): no reads, no throw, no status change, and a
    // panel stuck reading "not connected" with nothing to explain it.
    rt.ourFactionId = rt.session.factionId
    rt.isAdmin = sessionIsAdmin(rt.session)
    log(`admin: ${rt.isAdmin}`)
    startPolling()
    observe()
  }

  function main() {
    // ⚠️ Read the stored session BEFORE building the panel. The first release
    // called panel() first, so rt.session was always null at render time and
    // the panel asked for a key on every single load — a saved session looked
    // like it had never saved.
    rt.session = store.read()
    // Version from GM_info, never a constant of our own: a hand-kept copy of
    // @version is exactly the thing that drifts, and the drift is invisible.
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

  // Test seam: the request sequences (401 → refresh → retry) cannot be reached
  // through the pure helpers, and they are exactly where the bugs have been.
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
    countryCode, travelDestination, travelPhase, methodsForPlaneType, travelEta,
    fmtCountdown, fmtEtaShort, fmtLastActionShort, activityTone, reviveAudience,
    statusView, statusSortValue, sortEntries, nextSort, rowState,
    TENANTS_URL, STORE_KEY, BADGE_CLASS,
    SETTING_DEFAULTS, SETTING_STATS, SETTING_FF_BOX, SETTING_STATUS, SETTING_TINT, DEBUG_KEY,
    FLIGHT_SECONDS, PLANE_TYPE_METHOD,
  }
})()

// Bootstrap only in a real browser. Guarded so the unit tests can evaluate this
// file and pull the pure helpers out with no DOM work running.
if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
