// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.49.0
// @description  War Room dibs, battle stats, live status, roster intel, assist requests and passive enemy loadout capture on the Torn faction and attack pages.
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
  /**
   * Deliberately outside SETTING_DEFAULTS/settings.on() and never surfaced in
   * the settings panel — tenants.json is production-only by design (staging
   * is excluded from it, see deploy/update.sh), so there is no ordinary way
   * to point a login at a `*_dev` host for staging QA of a backend-touching
   * change (#523 was the first one). A maintainer sets this with
   * `GM_setValue('tnl-dibs-debug-host', 'dev.monchoon.me')` via Tampermonkey's
   * own Storage panel, never in code — a real member's key never has it set.
   */
  const DEBUG_HOST_KEY = 'tnl-dibs-debug-host'

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

  /**
   * Key/value storage, with a localStorage fallback.
   *
   * GM_getValue/GM_setValue do NOT exist in Torn PDA unless the user has also
   * installed Torn PDA's own GMforPDA.user.js shim — the app ships PDA_storage
   * and the PDA_http* helpers instead. Every call site here used to name the
   * GM globals directly, so on PDA the writes threw ReferenceError (the reads
   * were already inside try/catch and silently returned defaults, which is its
   * own kind of broken: settings appeared to save and never did).
   *
   * localStorage is scoped to torn.com, which is exactly the scope wanted, and
   * survives reloads. It is not shared with a desktop Tampermonkey install,
   * so a PDA user signs in once on PDA — acceptable, and better than not at all.
   */
  function gmGet(key, fallback) {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback) } catch { /* fall through */ }
    try {
      const v = window.localStorage?.getItem(key)
      return v === null || v === undefined ? fallback : v
    } catch { return fallback }
  }

  function gmSet(key, value) {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return } } catch { /* fall through */ }
    try { window.localStorage?.setItem(key, value) } catch { /* private mode: session-only */ }
  }

  const settings = {
    on(key) {
      return settingOn(gmGet(key, null), key)
    },
    set(key, value) { gmSet(key, value ? 'true' : 'false') },
    num(key) {
      return settingNum(gmGet(key, null), key)
    },
    setNum(key, value) { gmSet(key, String(value)) },
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
  /**
   * OUR faction page — not just any faction page (#619).
   *
   * ⚠️ `factions.php` serves every faction on Torn, and the war route is not
   * ours alone: `factions.php?step=profile&ID=9357#/war/rank` is somebody
   * else's war, with the same hash and the same roster markup. Matching on the
   * path alone lit the whole script up there — badging enemies of a faction we
   * are not fighting, and offering Dibs on a war nobody in our faction is in.
   *
   * `step` is what separates them: `your` is the faction you are a member of,
   * anything else (`profile`, and whatever Torn adds next) is someone
   * observed. Torn redirects a bare `factions.php` to `?step=your&type=1`, so
   * requiring it costs nothing on the page we do want.
   *
   * Deliberately NOT `type=N`: that is a per-faction layout id which differs
   * between factions and moves when a faction reorders its own tabs — the same
   * reason warRankRouteMatch() reads the hash instead.
   */
  function factionPageMatch(pathname, search) {
    if (pathname !== '/factions.php') return false
    return new URLSearchParams(search ?? '').get('step') === 'your'
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

  /**
   * The war page's route, read off the HASH — never the query string.
   *
   * Torn's faction page is a hash-routed SPA: `factions.php?step=your&type=1`
   * serves every tab behind the same path, and that `type=N` is a per-faction
   * layout id — it differs between factions and shifts when a faction reorders
   * its own tabs, so gating on it would work for one faction and silently fail
   * for the next. The part after `#` is the actual route, and it is stable.
   *
   * Deeper war routes are allowed through (`#/war/rank/123`, `#/war/rank?x=1`):
   * a sub-view of the war page is still the war page. Any other section
   * (`#/armory`, `#/crimes`, `#/upgrades`, or no hash at all) is not, and gets
   * nothing — including, critically, none of injectStyles()' layout overrides,
   * which are written against the war roster's markup and visibly wreck the
   * other tabs when they leak onto them.
   */
  function warRankRouteMatch(hash) {
    const route = String(hash ?? '').replace(/^#/, '')
    return /^\/war\/rank(?:[/?#]|$)/.test(route)
  }

  function isFactionPage() {
    return typeof location !== 'undefined' && factionPageMatch(location.pathname, location.search)
  }

  /**
   * The only faction-page view this script may touch.
   *
   * Everything faction-side gates on THIS, not isFactionPage(). The distinction
   * matters because the hash changes without a page load — Torn routes tabs
   * client-side — so a script that only checks the path stays switched on for
   * the rest of the session once the user clicks Armory.
   */
  function isWarRankPage() {
    return isFactionPage() && warRankRouteMatch(location.hash)
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
  /**
   * How many of a thing are still being asked for (#591).
   *
   * ⚠️ Reads 0 as 0 since #617, where the old shape could not. Under #523 the
   * ROW was the request, so a missing count meant a row written before the
   * column existed and 1 was the honest floor. Now the COUNT is the request: a
   * kind at zero is nobody asking, and rounding garbage up to 1 would invent a
   * request nobody made and send someone into a fight that is over.
   *
   * Mirrors assistCount() in frontend/src/utils/assistBadge.js. The two cannot
   * import from each other (this file has no npm imports at all), so they are
   * kept deliberately identical instead.
   */
  function assistCount(raw) {
    const n = Math.floor(Number(raw))
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  /**
   * Which kind the one badge shows when several are outstanding (#617).
   * Mirrors KIND_PRIORITY in frontend/src/utils/assistBadge.js — see there for
   * why help outranks smoke outranks tear.
   */
  const KIND_PRIORITY = ['help', 'smoke', 'tear']

  /**
   * When the oldest still-outstanding kind went up, in ms — or null if none of
   * them carry a timestamp (rows carried over by 0059's backfill do not).
   */
  function earliestRaisedAtMs(assist) {
    const times = liveKinds(assist)
      .map(k => parseDbTime(k.at)?.getTime())
      .filter(t => Number.isFinite(t))
    return times.length ? Math.min(...times) : null
  }

  /** Every kind still outstanding on a counts row, highest-priority first. */
  function liveKinds(assist) {
    if (!assist) return []
    return KIND_PRIORITY
      .map(kind => ({ kind, wanted: assistCount(assist[`${kind}_wanted`]), at: assist[`${kind}_raised_at`] ?? null }))
      .filter(k => k.wanted > 0)
  }

  /** How long a press has to be held before it counts as a hold (#600). */
  const LONG_PRESS_MS = 500

  /**
   * What a press on an assist button means.
   *
   * ⚠️ The short-press row is the whole bug this replaced (#600). A press on
   * your own active kind used to route to `clearAssist` — the #523 toggle-off,
   * written before counting existed and never revisited when #591 added it. So
   * the one gesture that should raise the count was the one that destroyed the
   * request, and the counter was unreachable from the surface built for it.
   *
   * 'request' covers every short-press case on purpose, because the server
   * already decides what it means: since #617 a press always ADDS one to this
   * target's count of this kind, whoever pressed it.
   *
   * ⚠️ #617 widened the hold. It used to be "only ever about YOUR OWN request
   * of THIS kind", which stopped working the moment counts became shared:
   * MonChoon's call was that anyone may take one back, because a dib expires
   * while a long fight runs on and the person best placed to say "we're fine
   * now" is whoever is actually in it. So a hold needs only that THIS KIND is
   * outstanding on this target — no ownership test, because there is no owner.
   * Holding a kind nobody is asking for still does nothing, rather than
   * raising an error the overlay would have to render mid-fight.
   */
  function assistPressAction(assist, kind, gesture) {
    if (gesture !== 'long') return 'request'
    return liveKinds(assist).some(k => k.kind === kind) ? 'decrement' : 'noop'
  }

  /**
   * targetId → the #617 counts row.
   *
   * ⚠️ Far simpler than the #523/#603 version it replaces, and the deletions
   * are the point. That one carried `sameAssistRequest`, a recency race on
   * `created_at`, and an acknowledged gap where a tombstone for the
   * currently-shown requester blanked a target another requester still wanted
   * — all of it machinery for picking ONE row out of several competing for a
   * single badge slot. #617 makes the row per-target, so there is nothing to
   * pick and none of that can go wrong.
   *
   * ⚠️ A row whose counts are all zero is DELETED from the index rather than
   * skipped. The delta ships zeroed rows deliberately — reaching zero is how a
   * client learns to clear a badge — so a zeroed row is not noise to ignore,
   * it is the cancellation of whatever is on screen.
   */
  function indexAssists(rows, into) {
    const byTarget = into ?? new Map()
    for (const row of rows ?? []) {
      const targetId = Number(row.target_id)
      if (!Number.isFinite(targetId) || targetId <= 0) continue
      if (liveKinds(row).length === 0) byTarget.delete(targetId)
      else byTarget.set(targetId, { ...row, target_id: targetId })
    }
    return byTarget
  }

  function frameRows(channel) {
    if (Array.isArray(channel)) return channel
    return Array.isArray(channel?.rows) ? channel.rows : []
  }

  // ── Enemy loadout capture (#528 Part 2) ───────────────────────────────────
  //
  // Torn does NOT reveal a defender's loadout on page load — the weapon slots
  // read `emptySlot` / aria-label "This weapon is not available" and the
  // armour wrap is empty until the fight actually starts (Start fight
  // clicked). Once it starts, both sides' weapon wrappers get
  // `aria-label="Attack with <Weapon Name>"`, and the armour becomes readable
  // independent of any image at all: `#modelLayersContainer map area[title]
  // [alt]` names one BODY SLOT (`alt`) and one ITEM (`title`) per element.
  //
  // Capture is by NAME, never by image `src` id, on purpose: a third-party
  // "hide gear, show text" script can strip `<img src>` at document-start,
  // but it has no reason to touch `aria-label` or `<area title>` — neither is
  // an image. A numeric item id parsed off an intact `<img src>` is stored as
  // a bonus, nullable field; it is never required and never blocks a capture.
  const WEAPON_WRAPPER_SLOTS = {
    weapon_main: 'primary', weapon_second: 'secondary', weapon_melee: 'melee', weapon_temp: 'temporary',
  }
  const ARMOR_ALT_TO_SLOT = {
    Helmet: 'helmet', Chest: 'chest', Pants: 'pants', Boots: 'boots', Gloves: 'gloves',
  }

  /** "Attack with AK-47" → "AK-47". Pre-fight empty slots read "This weapon
   *  is not available" and fall through to null, same as any label this
   *  doesn't recognise — never guess. */
  function parseWeaponAriaLabel(label) {
    const m = /^Attack with (.+)$/.exec(String(label ?? '').trim())
    const name = m?.[1]?.trim()
    return name ? name : null
  }

  /** Bonus-only signal (#528, point 3) — Torn's own weapon image path is
   *  `/images/items/<id>/large.png`. Never required; null on anything else,
   *  including a gear-hiding script's stripped `src`. */
  function weaponItemIdFromSrc(src) {
    const m = /\/images\/items\/(\d+)\//.exec(String(src ?? ''))
    const id = m ? Number(m[1]) : NaN
    return Number.isFinite(id) && id > 0 ? id : null
  }

  /** Torn's armour `<area alt="Chest">` → our slot key, or null for a body
   *  part we don't track (or a future one Torn adds). */
  function mapArmorAltToSlot(alt) {
    return ARMOR_ALT_TO_SLOT[String(alt ?? '').trim()] ?? null
  }

  /** True when neither group captured anything — nothing worth sending. */
  function loadoutIsEmpty(loadout) {
    const weapons = loadout?.weapons ?? {}
    const armor = loadout?.armor ?? {}
    return Object.keys(weapons).length === 0 && Object.keys(armor).length === 0
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
    if (!d) return '\u2014'
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
    const rule = '\u2500'.repeat(14)
    const out = [line('FF', ff === null || ff === undefined ? '\u2014' : ff.toFixed(2)), rule]
    const dominant = dominantStat(stats)
    for (const [key, label, v] of [['str', 'STR', stats.str], ['def', 'DEF', stats.def], ['spd', 'SPD', stats.spd], ['dex', 'DEX', stats.dex]]) {
      if (v !== null && v !== undefined) out.push(line(key === dominant ? `\u25B8${label}` : label, formatStat(v)))
    }
    if (out.length > 2) out.push(rule)
    out.push(line('Total', formatStat(stats.total)))
    out.push(rule)
    out.push(`${fmtAgo(stats.spiedAt)} (${statsSourceLabel(stats.source)})`)
    if (stats.source === 'torn') out.push('Exact \u2014 from their own key')
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

  /** Icon key + label per assist kind (#523) — kept short, the badge is width-constrained. */
  const ASSIST_KIND_META = {
    smoke: { icon: 'cloud-fog', label: 'Smoke' },
    tear: { icon: 'droplet', label: 'Tear gas' },
    help: { icon: 'life-buoy', label: 'Help' },
  }

  /**
   * Lucide's own paths (matching the dashboard's installed lucide-react
   * version, so the two never visually drift), inlined byte-for-byte — this
   * file has no build step and cannot `import` the npm package the dashboard
   * uses (frontend/src/utils/assistBadge.js), so this is the userscript's
   * side of the same icon-name → glyph mapping.
   */
  const ASSIST_ICON_PATHS = {
    'cloud-fog': '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />'
      + '<path d="M16 17H7" /><path d="M17 21H9" />',
    droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />',
    'life-buoy': '<circle cx="12" cy="12" r="10" /><path d="m4.93 4.93 4.24 4.24" />'
      + '<path d="m14.83 9.17 4.24-4.24" /><path d="m14.83 14.83 4.24 4.24" />'
      + '<path d="m9.17 14.83-4.24 4.24" /><circle cx="12" cy="12" r="4" />',
  }

  function assistIconSvg(iconKey, size = 14) {
    const body = ASSIST_ICON_PATHS[iconKey]
    if (!body) return ''
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" `
      + `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" `
      + `style="display:block">${body}</svg>`
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
    const live = liveKinds(assist)
    if (live.length > 0) {
      const [held, ...others] = live
      const meta = ASSIST_KIND_META[held.kind] ?? { icon: 'life-buoy', label: held.kind ?? 'Assist' }
      // A count of one says nothing worth saying — "Smoke ×1" is noise on the
      // overwhelming majority of requests, so the multiple appears only when
      // there is one.
      const phrase = (k) => {
        const m = ASSIST_KIND_META[k.kind] ?? { label: k.kind ?? 'Assist' }
        return k.wanted > 1 ? `${m.label} \u00D7${k.wanted}` : m.label
      }
      // ⚠️ #617: no requester on the row, so no "requested by …". The count is
      // the sum of everyone who asked — there is no one person to name, and
      // picking one would print an arbitrary choice as fact. Several kinds can
      // be live at once now; the badge still shows one (the row has no width
      // for more) and the title carries the rest.
      return {
        mode: 'assist',
        label: phrase(held),
        icon: meta.icon,
        wanted: held.wanted,
        kinds: live,
        href: attackUrl(targetId),
        action: null,
        mine: false,
        taken: true,
        title: [
          `${phrase(held)} requested`,
          ...others.map(k => `also ${phrase(k)}`),
          fmtAgo(held.at),
        ].join(' \u00B7 '),
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
        title: eta ? `${st.description ?? 'Traveling'} \u2014 landing in about ${eta.replace('~', '')}` : (st.description ?? 'Traveling'),
      }
    }

    if (kind === 'Abroad') {
      const code = countryCode(st.description)
      return { kind: 'abroad', text: code ? `In ${code}` : 'Abroad', tone: 'abroad', title: st.description ?? '' }
    }

    if (kind === 'Okay') {
      const ago = fmtLastActionShort(entry.last_action, nowMs)
      const audience = reviveAudience(entry)
      const glyph = audience === 'anyone' ? ' \uD83D\uDC89' : audience === 'friends' ? ' \uD83D\uDC89' : ''
      return {
        kind: 'okay',
        text: `${ago ?? 'Okay'}${glyph}`,
        tone: 'okay',
        title: [
          entry.last_action?.status ? `${entry.last_action.status}${ago ? ` \u2014 last action ${ago} ago` : ''}` : null,
          audience === 'anyone' ? 'Revivable \u2014 a hired reviver can bring them up'
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
    return `\u26D3${current}${left != null ? ` \u00B7 ${fmtCountdown(left)}` : ''}`
  }

  /**
   * Torn PDA's own cross-origin transport, used when no GM one exists.
   *
   * ⚠️ A privileged transport is NOT optional for this script. The dashboard
   * API lives on a different origin from torn.com and serves no CORS headers
   * at all (verified against the live host), so a plain fetch() from the page
   * is blocked outright. Without one of these, every call fails and the script
   * can do nothing but show a red light.
   *
   * PDA exposes `PDA_httpGet(url, headers)` and
   * `PDA_httpPost(url, headers, body)` — promises resolving to
   * `{ status, statusText, responseText, responseHeaders }`. There is no
   * DELETE, so releasing a dib and clearing an assist are the two things that
   * cannot work on PDA without a server-side POST alias; they fail with a
   * message that says so rather than a generic network error.
   */
  function pdaTransport() {
    return (typeof PDA_httpGet === 'function' && typeof PDA_httpPost === 'function')
      ? { get: PDA_httpGet, post: PDA_httpPost }
      : null
  }

  async function pdaRequest(opts, pda) {
    const method = (opts.method || 'GET').toUpperCase()
    const started = Date.now()
    log(`\u2192 ${method} ${redactUrl(opts.url)} (via Torn PDA)`)
    let res
    if (method === 'GET') res = await pda.get(opts.url, opts.headers || {})
    else if (method === 'POST') res = await pda.post(opts.url, opts.headers || {}, opts.body ?? '')
    else throw new Error(`${method} is not supported by Torn PDA's HTTP bridge`)
    let parsed = null
    try { parsed = JSON.parse(res.responseText) } catch { /* not json */ }
    log(`\u2190 ${res.status} ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
    return { status: res.status, body: parsed }
  }

  /** Which transport we resolved to, for the settings panel to report. */
  function transportName() {
    if ((typeof GM !== 'undefined' && GM.xmlHttpRequest) || typeof GM_xmlhttpRequest === 'function') return 'GM'
    if (pdaTransport()) return 'Torn PDA'
    return 'none'
  }

  // ── Fight-log observation (#523 follow-up) ───────────────────────────────
  //
  // Torn's attack page carries a live fight log, and it shows OTHER players'
  // actions, not just yours. That is what makes an assist request verifiable:
  // a raised hand can be answered by observation instead of by someone
  // remembering to press "I'm coming".
  //
  //   <li class="row___MN82U">
  //     <span class="col1___utZk7">
  //       <span class="iconWrap___NQz8E"><span class="attacking-events-attack-join"></span></span>
  //       <span class="message___Tw33z">Onyx joined the fight against 4444444</span>
  //     </span>
  //     <span class="col2___e3KXX">69s</span>
  //   </li>
  //
  // ⚠️ The `attacking-events-*` class is the ONLY stable hook on that row.
  // Everything around it (`row___`, `message___`, `col2___`) is a CSS-module
  // hash that Torn rotates on every site deploy — the sibling mug-bot script
  // has a scar comment about exactly this breaking all of its scraping. So the
  // event TYPE comes from the class, and text is used only for the names and
  // the grenade flavour, which have nowhere else to come from.

  const FIGHT_EVENT_CLASS = {
    'attacking-events-attack-join': 'join',
    'attacking-events-grenade-use': 'grenade',
  }

  /**
   * "26s" / "2m 12s" / "1h" → seconds. Torn writes plain seconds today (the
   * captured sample runs to "132s" rather than "2m 12s"), but a unit it might
   * start using must not silently parse as a much smaller number — an event
   * mis-dated as recent is one that wrongly answers a request.
   */
  function parseFightLogAge(text) {
    const t = String(text ?? '').trim().toLowerCase()
    if (!t) return null
    const m = t.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/)
    if (!m || (!m[1] && !m[2] && !m[3])) return null
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  }

  /**
   * One log row → `{ kind, actor, subject }`, or null for a row we don't act on.
   *
   * `kind` is 'join' | 'smoke' | 'tear'. `subject` is who it was done TO, which
   * is the whole basis of the filtering below: a grenade thrown at one of OUR
   * members by an enemy has the same event class as one thrown at the enemy by
   * us, and only the subject tells them apart.
   *
   * ⚠️ "initiated an attack against" carries the SAME
   * `attacking-events-attack-join` class as "joined the fight against". It is
   * the person who opened the fight, not a responder — counting it would make
   * every requester their own first answer. Returns null on purpose.
   */
  function parseFightLogRow(row) {
    const type = FIGHT_EVENT_CLASS[row?.eventClass]
    if (!type) return null
    const text = String(row?.text ?? '').trim()
    if (!text) return null

    if (type === 'join') {
      const m = text.match(/^(\S+) joined the fight against (\S+)$/)
      return m ? { kind: 'join', actor: m[1], subject: m[2] } : null
    }

    // Tolerant on the phrasing, strict on the shape: Torn words the two
    // grenades differently ("...Grenade near X" vs "...Grenade, smoke clouds
    // around X"), and a third grenade would arrive worded a third way.
    const m = text.match(/^(\S+) threw an? (.+?) Grenade\b.*?\b(?:near|around|at)\s+(\S+)$/i)
    if (!m) return null
    const flavour = m[2].toLowerCase()
    const kind = flavour.includes('smoke') ? 'smoke' : flavour.includes('tear') ? 'tear' : null
    return kind ? { kind, actor: m[1], subject: m[3] } : null
  }

  /**
   * The rows that could answer a request, filtered to the ones that actually
   * concern this fight.
   *
   * Four rules, each from a real way the raw log lies:
   *
   *  1. SUBJECT MUST BE OUR TARGET. Fights chain — once several people are in,
   *     one log carries joins and grenades aimed at several different people,
   *     including at us. "X joined the fight against <someone else>" is not an
   *     answer to our request, and a Tear Gas thrown AT one of ours is an enemy
   *     attacking, not a member helping.
   *  2. ACTOR MUST NOT BE THE TARGET. The target fights back, in the same log.
   *  3. AFTER THE REQUEST ONLY. Ages are relative ("69s"), so an absolute time
   *     is derived and compared to when the hand went up. This is what makes
   *     "smoke first, then ask for help" behave: your own earlier smoke is
   *     older than the request and cannot answer it.
   *  4. A JOIN IS NEVER THE REQUESTER. They are definitionally already in the
   *     fight. Grenades are NOT filtered this way — a smoke you throw yourself
   *     after asking for three is still one of the three.
   *
   * Faction membership is deliberately NOT checked here. The script has no
   * roster on the attack page, and the names are attacker-controlled text; the
   * server holds `war_room_state_v2.member_name` + `faction_id` for both sides
   * and is the only place that can answer it honestly.
   */
  function assistCandidates(rows, { targetName, requesterName, requestedAtMs, nowMs = Date.now() } = {}) {
    // ⚠️ No early return on a missing targetName any more (#618). That single
    // line is what made the whole feature depend on scraping the defender's
    // name off a page that does not reliably render it as a link: when it came
    // back null, not one event was ever reported and a live smoke sat
    // uncounted with every other part of the chain working. Rules 1 and 2 are
    // a prefilter when a name IS available; the server repeats the check on
    // ids either way.
    const out = []
    for (const raw of rows ?? []) {
      const ev = parseFightLogRow(raw)
      if (!ev) continue
      // Rule 1 is now only a cheap CLIENT-SIDE PREFILTER, and the server
      // repeats it authoritatively on ids (#618). It runs only when the page
      // gave us a name to compare against — see reportFightLog() for why that
      // is not something the attack page reliably offers.
      if (targetName && ev.subject !== targetName) continue   // rule 1
      if (targetName && ev.actor === targetName) continue     // rule 2
      const age = parseFightLogAge(raw.age)
      if (age === null) continue
      const atMs = nowMs - age * 1000
      if (requestedAtMs != null && atMs < requestedAtMs) continue   // rule 3
      if (ev.kind === 'join' && requesterName && ev.actor === requesterName) continue  // rule 4
      out.push({ kind: ev.kind, actor: ev.actor, subject: ev.subject, at_ms: atMs })
    }
    return out
  }

  function gmRequest(opts) {
    const pda = pdaTransport()
    const hasGm = (typeof GM !== 'undefined' && GM.xmlHttpRequest)
      || (typeof GM_xmlhttpRequest !== 'undefined' && GM_xmlhttpRequest)
    // GM first where both exist: it carries every method, PDA's bridge does not.
    if (!hasGm && pda) return pdaRequest(opts, pda)
    return new Promise((resolve, reject) => {
      const xhr = hasGm
      if (!xhr) {
        return reject(new Error(
          'No cross-origin transport: this needs GM.xmlHttpRequest (Tampermonkey/Violentmonkey) ' +
          'or Torn PDA\'s PDA_httpGet/PDA_httpPost'
        ))
      }
      const started = Date.now()
      const method = opts.method || 'GET'
      log(`\u2192 ${method} ${redactUrl(opts.url)}`)
      xhr({
        method,
        url: opts.url,
        headers: opts.headers || {},
        data: opts.body,
        onload: (res) => {
          let parsed = null
          try { parsed = JSON.parse(res.responseText) } catch { /* not json */ }
          log(`\u2190 ${res.status} ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          resolve({ status: res.status, body: parsed })
        },
        onerror: () => {
          log(`\u2717 failed ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          reject(new Error(`request failed: ${redactUrl(opts.url)}`))
        },
        ontimeout: () => {
          log(`\u2717 timed out ${redactUrl(opts.url)} (${Date.now() - started}ms)`)
          reject(new Error(`request timed out: ${redactUrl(opts.url)}`))
        },
      })
    })
  }

  const store = {
    read() { try { return JSON.parse(gmGet(STORE_KEY, 'null')) } catch { return null } },
    write(v) { gmSet(STORE_KEY, JSON.stringify(v)) },
    clear() { gmSet(STORE_KEY, 'null') },
  }

  /** Key → faction → tenant → JWT. */
  async function establishSession(apiKey) {
    const who = await gmRequest({
      url: `https://api.torn.com/v2/key/info?key=${encodeURIComponent(apiKey)}&comment=TNLDibs`,
    })
    if (who.body?.error) throw new Error(`Torn rejected the key: ${who.body.error.error}`)
    const info = who.body?.info
    if (!info?.user) throw new Error('Torn returned no key info \u2014 is the key correct?')
    if (Number(info.access?.level ?? 0) < 3) {
      throw new Error('That is not a Limited Access key. Generate one in Torn and use that.')
    }
    const factionId = info.user.faction_id
    if (!factionId) throw new Error('Torn reports no faction for that key.')

    let host = null
    host = gmGet(DEBUG_HOST_KEY, '') || null
    if (!host) {
      const tenants = await gmRequest({ url: TENANTS_URL })
      host = resolveTenant(tenants.body, factionId)
    }
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
    loadoutTarget: null,     // user2ID of the current attack (#528 Part 2)
    loadoutSent: false,      // already POSTed for this target — a loadout can't change mid-fight,
                             // so send at most once per attack, not once per content change; reset
                             // only when loadoutTarget changes (a genuinely new fight)
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
    log('token is stale \u2014 refreshing')
    const res = await gmRequest({
      method: 'POST',
      url: `https://${rt.session.host}/api/auth/refresh`,
      headers: { authorization: `Bearer ${rt.session.token}` },
    })
    if (res.status !== 200 || !res.body?.token) {
      log(`refresh failed (${res.status}) \u2014 signing out`)
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
    // ⚠️ #617 deleted the "clear my other request first" sweep that stood here.
    // It mirrored a server rule — one live assist per requester — that no
    // longer exists: asking for a smoke on this target does not cancel the
    // help you asked for on that one, so wiping them locally would blank
    // badges the server still considers live.
    //
    // The server's own count, not a guess. Painting it here is what makes the
    // pip move on the press rather than on the next poll — the attack page is
    // where the decision to ask for one more is taken, so it cannot be the
    // last surface to know (#603).
    const wanted = Number(res.body?.wanted)
    const cur = rt.assists.get(targetId) ?? { target_id: targetId }
    rt.assists.set(targetId, {
      ...cur,
      [`${kind}_wanted`]: Number.isFinite(wanted) && wanted > 0 ? wanted : 1,
      [`${kind}_raised_at`]: new Date().toISOString(),
    })
    pokePoll()
    return { ok: true, wanted }
  }

  /**
   * Take one off your own request (#600) — the overlay's long press.
   *
   * ⚠️ A POST, not a DELETE: Torn PDA's bridge has no DELETE at all (see
   * pdaTransport()), and this gesture's home is the attack page, which is a
   * phone surface as much as a desktop one. Routing it through DELETE would
   * have made the whole gesture dead on PDA and working everywhere else, which
   * is the hardest kind of bug to have reported.
   *
   * No optimistic local edit. The server owns `wanted` — the fight log
   * decrements it too (#591), so this browser's copy is not the only writer and
   * guessing the new value here would make the pip flicker between our guess
   * and the truth on the next poll.
   */
  async function decrementAssist(targetId, kind) {
    // ⚠️ `kind` is REQUIRED since #617 (the server 400s without it): with a
    // count per kind there is no single "your live request" left for it to
    // infer, and guessing here would take one off the wrong pile.
    const res = await api('/api/war-room/assist/decrement', 'POST', { target_id: targetId, kind })
    if (res.status !== 200) return { ok: false, message: res.body?.error || `HTTP ${res.status}` }
    const wanted = Number(res.body?.wanted)
    const cur = rt.assists.get(targetId)
    if (cur && Number.isFinite(wanted)) {
      // Same reason as requestAssist(): the press has to move the number now.
      //
      // ⚠️ `cleared` means THIS KIND reached zero, not that the target is
      // clear — another kind can still be outstanding, so the row is updated
      // and then dropped only if nothing at all is left. Deleting on `cleared`
      // alone (what #600 did, when a row was one kind) would blank a badge
      // that should have fallen back to showing the kind still wanted.
      const next = { ...cur, [`${kind}_wanted`]: Math.max(wanted, 0) }
      if (liveKinds(next).length === 0) rt.assists.delete(targetId)
      else rt.assists.set(targetId, next)
    }
    pokePoll()
    return { ok: true, wanted: Number.isFinite(wanted) ? wanted : 0, cleared: !!res.body?.cleared }
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
      log(`opponent is now faction ${opponent} (was ${rt.opponentId ?? 'unknown'}) \u2014 resetting`)
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
    log(`${stateRows.length} roster rows, ${dibRows.length} dib rows, ${assistRows.length} assist rows \u2192`,
      `${rt.enemies.size} enemies, ${rt.dibs.size} live claims, ${rt.assists.size} live assists`,
      `(opponent ${rt.opponentId ?? 'unknown'})`)
    // Faction-page-only UI (toasts) — the attack page has neither the dibs
    // targets nor the chain state these read, and would just be noise mid-fight.
    if (isWarRankPage()) {
      checkDibsHospitalAlerts()
      checkChainAlert()
    }
    // #528 Part 2: passive, silent capture check — attack page only (the
    // function itself gates on isAttackPage()). Fire-and-forget: a slow or
    // failed capture must never hold up the poll loop's own render, and the
    // function's own try/catch means there is nothing here to await or catch.
    checkLoadoutCapture()
    // #591: same fire-and-forget shape — a slow or failed report must never
    // hold up the poll loop's own render.
    reportFightLog()
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
        log('tab visible again \u2014 reading now')
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
  /** Matches the `max-width:260px` the panel boxes are built with. */
  const PANEL_WIDTH = 260
  const NARROW_PX = 1000
  const COL_HEAD_CLASS = 'tnl-col-head'
  const DIBS_CLASS = 'tnl-col-dibs'
  const MINE_CLASS = 'tnl-mine'
  const TAKEN_CLASS = 'tnl-taken'
  /** The Dibs badge morphed into a live assist request (#523) — see badgeState(). */
  const ASSIST_CLASS = 'tnl-assist'
  /** The count beside the icon on a roster assist badge (#610). */
  const ASSIST_N_CLASS = 'tnl-assist-n'
  /**
   * ⚠️ TAKING OVER A CELL TORN OWNS — READ THIS BEFORE TOUCHING ANY CELL (#613).
   *
   * Torn's faction page is React 19. React keeps its own references to the DOM
   * nodes it created, and on a later update it calls removeChild on exactly
   * those nodes. If we have destroyed one in the meantime, that call throws
   * inside React's commit phase and React tears down the whole subtree — which
   * is the page going blank after anywhere from two to thirty seconds, caught
   * red-handed by a removeChild trace running through react-dom's own
   * commitDeletionEffects recursion.
   *
   * Every one of these DESTROYS a node React is holding:
   *
   *     el.textContent = 'x'   // replaces the child text node
   *     el.textContent = ''    // removes every child
   *     el.replaceWith(node)   // removes el itself
   *
   * ⚠️ The subtle one is `textContent`: on an ELEMENT it does not edit text,
   * it swaps the text node out for a new one. (On a Text node it edits data in
   * place, which is safe — relabelHeaderText relies on that distinction.)
   *
   * So we never remove anything of Torn's. We APPEND our own element and hide
   * theirs with CSS: `font-size: 0` collapses bare text nodes, which is the
   * only way to hide a text node at all, and `display: none` handles element
   * children. React remains free to update or delete its own nodes whenever it
   * likes; they are simply invisible while we are showing ours.
   */
  const TOOK_CLASS = 'tnl-took'
  const OWN_CLASS = 'tnl-own'
  const BS_CLASS = 'tnl-col-bs'
  const STAT_VALUE_CLASS = 'tnl-col-bsv'
  const STYLE_ID = 'tnl-dibs-style'
  const TIP_ID = 'tnl-dibs-tip'
  const NO_BS_CLASS = 'tnl-no-bs'
  const LAUNCHER_ID = 'tnl-war-room-link'
  const LAUNCHER_LABEL_ID = 'tnl-war-room-label'
  /** Fallback home for the launcher where Torn's page-title links are absent. */
  const LAUNCHER_HOST_ID = 'tnl-war-room-host'
  const LAUNCHER_NAME = 'Torn War Room'
  /** Warline-style online/idle badge on the "Members" header. */
  const MEMBER_COUNT_COLOR = '#0b8a0b'
  const MEMBER_COUNT_CLASS = 'tnl-member-count'
  const MC_ONLINE_CLASS = 'tnl-mc-on'
  const MC_IDLE_CLASS = 'tnl-mc-idle'
  const MC_WORD_CLASS = 'tnl-mc-word'
  const PLAIN_NAME_CLASS = 'tnl-plain-name'
  const TINTING_CLASS = 'tnl-tinting'
  /** On <html> only while the war roster is the active tab (see scopeCss). */
  const WAR_ACTIVE_CLASS = 'tnl-war-active'
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

  /**
   * Prefix every selector so the whole sheet is inert unless <html> carries
   * WAR_ACTIVE_CLASS.
   *
   * Removing the <style> on route change (teardownWarUi) is the intended path,
   * but it is a path that can MISS: it depends on render() being reached, which
   * depends on Torn firing something we listen for. Torn routes faction tabs
   * client-side, and a pushState that changes no hash fires neither
   * `hashchange` nor `popstate`. When that happens the sheet stays applied to a
   * tab it was never written for, and rules like
   * `.white-grad { display:flex; width:100% }` inflate Torn's own section
   * header into an empty full-width bar carrying the tab name.
   *
   * Scoping makes the failure impossible rather than unlikely: with the class
   * off, not one rule matches, whatever went wrong with the teardown.
   */
  function scopeSelector(sel, cls) {
    const s = sel.trim()
    if (!s) return sel
    // `html`-leading selectors get the class added TO that html, not prefixed
    // in front of it — `html.x html.y` can never match, since html is nobody's
    // descendant. The tint and no-battle-stats toggles are written that way.
    if (/^html\b/.test(s)) return s.replace(/^html\b/, `html.${cls}`)
    return `html.${cls} ${s}`
  }

  /** Split a selector list on top-level commas — `:not(.a, .b)` stays whole. */
  function splitSelectorList(list) {
    const out = []
    let depth = 0
    let buf = ''
    for (const ch of list) {
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth--
      if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue }
      buf += ch
    }
    out.push(buf)
    return out
  }

  /**
   * Scope one selector list, preserving the whitespace and comments around it —
   * the sheet is read by people, and a transform that reflows it makes every
   * future diff unreadable.
   */
  function scopeHead(head, cls) {
    const trivia = head.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0]
    const rest = head.slice(trivia.length)
    if (!rest.trim()) return head
    const scoped = splitSelectorList(rest).map((part) => {
      const lead = part.match(/^\s*/)[0]
      const tail = part.match(/\s*$/)[0]
      const body = part.trim()
      return body ? lead + scopeSelector(body, cls) + tail : part
    }).join(',')
    return trivia + scoped
  }

  /** Group at-rules nest real rules; @keyframes nests keyframe steps instead. */
  const AT_GROUP = /^@(media|supports|container|document|layer|scope)\b/
  const AT_KEYFRAMES = /^@(-\w+-)?keyframes\b/

  function scopeCss(css, cls) {
    let out = ''
    let head = ''
    const stack = []            // 'decl' | 'group' | 'raw'
    let i = 0
    while (i < css.length) {
      if (css[i] === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        const stop = end === -1 ? css.length : end + 2
        const top = stack[stack.length - 1]
        if (top === 'decl' || top === 'raw') out += css.slice(i, stop)
        else head += css.slice(i, stop)
        i = stop
        continue
      }
      const ch = css[i]
      const top = stack[stack.length - 1]
      if (top === 'decl') {
        out += ch
        if (ch === '}') stack.pop()
        i++
        continue
      }
      if (top === 'raw') {
        // Inside @keyframes: copy through, tracking depth. A keyframe step
        // (`from`, `to`, `0%`) is NOT a selector and must not be scoped.
        out += ch
        if (ch === '{') stack.push('decl')
        else if (ch === '}') stack.pop()
        i++
        continue
      }
      if (ch === '{') {
        const trimmed = head.trim()
        if (trimmed.startsWith('@')) {
          out += head + '{'
          stack.push(AT_GROUP.test(trimmed) ? 'group' : AT_KEYFRAMES.test(trimmed) ? 'raw' : 'decl')
        } else {
          out += scopeHead(head, cls) + '{'
          stack.push('decl')
        }
        head = ''
        i++
        continue
      }
      if (ch === '}') {          // closes a group at-rule
        out += head + '}'
        head = ''
        stack.pop()
        i++
        continue
      }
      head += ch
      i++
    }
    return out + head
  }

  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = scopeCss(`
/* The header, the list AND each row are flex \u2014 all three, or none. Torn lays
   rows out with floats, but the cells we inject are not floated, and non-floated
   content does not sit in DOM order relative to floats. Mixing the two models
   gives the header and the rows two different column orders. */
/* NO BACKTICKS ANYWHERE IN THIS SHEET -- it is a template literal and one ends
   it. (This has broken the stylesheet twice.)

   The .faction-tabs-title exclusion below is the whole of a reported bug
   (#610). Torn puts .white-grad on two completely different things: the war
   roster's column header, which this rule is written for, and the page's own
   section title -- the bar reading "FACTION" above the tab strip. Given
   display:flex and width:100% that title inflates into an empty full-width
   bar, which is the mystery bar that kept appearing. It was never an element
   we created; it is Torn's, restyled by a selector too broad to tell the two
   apart. */
.white-grad:not(.faction-tabs-title), .table-header, [class*="tableHeader"] {
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
   paintStats writes the real ones inline \u2014 these keep that off the screen. */
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
/* A live assist request morphs this same badge into a small icon-only link
   (#523) \u2014 display:flex centres the inlined SVG the way text-align never
   quite does for a block-level icon. */
.${BADGE_CLASS}.${ASSIST_CLASS} {
  background: #ea580c; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.${BADGE_CLASS}.${ASSIST_CLASS}:hover { background: #f97316; }
/* Sits BESIDE the icon, not over it: on the roster the badge is only ~44px
   wide, so a corner pip like the attack overlay's would overlap the glyph it
   is meant to annotate. The gap is what keeps both readable at 10px. */
.${BADGE_CLASS}.${ASSIST_CLASS} { gap: 3px; }
/* See TOOK_CLASS's own note. font-size:0 is not a trick for its own sake --
   a bare text node cannot be hidden any other way, and Torn's status cell
   holds its value as a bare text node. The member-count badge is exempt
   because it is OURS and lives as a sibling inside a header we have taken. */
.${TOOK_CLASS} { font-size: 0 !important; }
.${TOOK_CLASS} > *:not(.${OWN_CLASS}):not(.${MEMBER_COUNT_CLASS}) { display: none !important; }
.${OWN_CLASS} { font-variant-numeric: inherit; white-space: nowrap; }

.${ASSIST_N_CLASS} {
  /* Centred by LINE-HEIGHT, not by flex. Boxing 9px text in a 14px flex item
     centres the line box, but a glyph does not sit centred within its own line
     box -- the font's ascent and descent are asymmetric, so the digits still
     read high. Setting line-height to the icon's height distributes the
     half-leading using the font's own metrics, which is the thing that
     actually decides where the glyph lands. */
  display: inline-block;
  height: 14px; line-height: 14px;
  font: 700 9px/14px system-ui, sans-serif;
  color: #fff; opacity: .95;
  font-variant-numeric: tabular-nums;
}

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
   display:inline we set \u2014 so it never contributed to its wrapping <a>'s size.
   With the <img> hidden, that <a> had nothing left to size itself on and
   collapsed to 0\u00D70: the text still painted (absolute escapes a 0-size
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
   \u2014 under flex the name column takes it, and a negative one causes an overlap. */
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

/* Narrow screens lose no column and no badge \u2014 the name column absorbs the
   squeeze. The badge cannot shrink (nowrap), so instead "3 online / 8 idle"
   becomes "3 / 8" and colour carries what the words did. */
@media screen and (max-width: ${NARROW_PX}px) {
  .${MEMBER_COUNT_CLASS} .${MC_WORD_CLASS} { display: none; }
  .${MEMBER_COUNT_CLASS} .${MC_ONLINE_CLASS} { color: ${TINT_COLORS.online}; }
  .${MEMBER_COUNT_CLASS} .${MC_IDLE_CLASS} { color: ${TINT_COLORS.idle}; }
  .${MEMBER_COUNT_CLASS} { margin-left: 5px; padding: 1px 6px; font-size: 11px; }

  /* A few px off each fixed column \u2014 the name column takes the difference. */
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

`, WAR_ACTIVE_CLASS)
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

  /**
   * Our own element inside a cell Torn owns, with Torn's content hidden.
   *
   * The font size is MEASURED before the cell is zeroed, not guessed: Torn
   * sizes its columns differently and a hardcoded number would be wrong
   * somewhere. Measuring once, on creation, also keeps this off the hot path.
   *
   * Returns the same element on every later call, so callers can write to it
   * freely — it is ours, so the destructive operations that are forbidden on
   * Torn's nodes are all fine on this one.
   */
  function ownEl(cell, tag = 'span') {
    if (!cell) return null
    let own = cell.querySelector(`:scope > .${OWN_CLASS}`)
    if (own && own.tagName.toLowerCase() === tag) return own
    own?.remove()
    const size = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(cell).fontSize
      : null
    own = document.createElement(tag)
    own.className = OWN_CLASS
    if (size && size !== '0px') own.style.fontSize = size
    cell.appendChild(own)
    // Added AFTER measuring — this is what zeroes the cell's font size.
    cell.classList.add(TOOK_CLASS)
    return own
  }

  function ownText(cell, text) {
    const own = ownEl(cell)
    if (own && own.textContent !== text) own.textContent = text
    return own
  }

  /** Give the cell back to Torn: our node goes, theirs was never touched. */
  function releaseOwn(cell) {
    if (!cell) return
    cell.classList.remove(TOOK_CLASS)
    cell.querySelector(`:scope > .${OWN_CLASS}`)?.remove()
  }

  /**
   * What TORN's own content in this cell says, ignoring ours.
   *
   * Their text is still there — hidden, never destroyed — so this reads the
   * live value rather than a copy squirrelled away in a data attribute before
   * we overwrote it. That copy used to be the only record of what Torn said,
   * and it went stale the moment Torn updated a cell we had taken.
   */
  function tornTextOf(cell) {
    let out = ''
    for (const node of cell?.childNodes ?? []) {
      if (node.nodeType === 1 && node.classList?.contains(OWN_CLASS)) continue
      out += node.textContent || ''
    }
    return out.trim()
  }

  /** Leaves any child icon alone — a blind `.textContent =` would eat the arrow. */
  function relabelHeaderText(cell, from, to) {
    if (!cell) return
    for (const node of cell.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim() === from) { node.textContent = to; return }
      // "Members" ships wrapped in a span, where Level and Attack are bare
      // text — match a leaf element too, never a container.
      //
      // ⚠️ The two branches are NOT the same operation. On the Text node above,
      // `textContent =` edits data in place and React's reference stays valid.
      // On an ELEMENT it swaps the child text node out for a new one, and React
      // is still holding the old one — see TOOK_CLASS. So this branch takes the
      // cell over instead of writing through it.
      if (node.nodeType === 1 && node.children.length === 0
          && (node.textContent || '').trim() === from) {
        ownText(node, to)
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
      badge.textContent = '\u2026'
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
    badge.classList.toggle(ASSIST_CLASS, state.mode === 'assist')
    if (state.mode === 'assist') {
      // A real Lucide-matching icon, not the label text — see
      // assistIconSvg()'s own note on why this file inlines the paths
      // rather than importing the component the dashboard uses.
      //
      // ⚠️ The icon replaced the LABEL, and the count went with it (#610).
      // `state.label` is "Smoke ×3" when three are wanted, so swapping in the
      // glyph left the number readable only in a tooltip — on the roster, the
      // one surface where somebody scanning for who still needs help would
      // look. The icon says WHICH, the count says HOW MANY, and the row needs
      // both; they are rendered side by side rather than one instead of the
      // other. Still nothing at one, where "×1" is noise.
      const svg = assistIconSvg(state.icon)
      const wanted = assistCount(state.wanted)
      if (svg) {
        badge.innerHTML = wanted > 1
          ? `${svg}<span class="${ASSIST_N_CLASS}">\u00D7${wanted}</span>`
          : svg
      } else {
        badge.textContent = state.label
      }
      badge.classList.remove(MINE_CLASS, TAKEN_CLASS)
      badge.title = state.title
      return
    }
    badge.textContent = state.label
    badge.classList.toggle(MINE_CLASS, Boolean(state.mine))
    badge.classList.toggle(TAKEN_CLASS, Boolean(state.taken) && !state.mine)
    badge.title = state.mine
      ? 'Yours \u2014 click to release'
      : state.taken
        ? `Claimed by ${state.label}${state.action === 'release' ? ' \u2014 click to release (admin)' : ''}`
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
        showToast(`${name} left the hospital \u2014 your dibs target is up`, 'hospital')
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
        showToast(`Chain drops in under a minute \u2014 ${Number(rt.chain.current) || 0} hits`, 'chain')
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
        // ⚠️ Both branches used to destroy a node React owns (#613): the first
        // through `el.textContent =`, which swaps the child text node out, and
        // the second through `el.replaceWith()`, which removes el itself. React
        // was still holding both, and the removeChild it tried later is what
        // took the whole roster down with it.
        //
        // Torn's own element stays exactly where it is, hidden, and ours is
        // appended alongside — an <a> when we have a real target to give it,
        // plain text otherwise. Torn does not always ship this cell as a link
        // (outside an active war it is an unstyled span with no href at all),
        // which is why the anchor is built rather than borrowed.
        const href = playerId === null || playerId === undefined ? null : attackUrl(playerId)
        const useLink = href && !(el.tagName === 'A' && el.getAttribute('href'))
        const own = ownEl(el, useLink ? 'a' : 'span')
        if (!own) return
        own.textContent = 'Atk'
        if (useLink) {
          own.className = `${OWN_CLASS} t-blue h c-pointer`
          own.href = href
          own.rel = 'noopener noreferrer'
        }
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
    // Torn's own text, live — it is hidden rather than destroyed now (#613),
    // so this reads what Torn currently says instead of a copy taken before we
    // overwrote it, which went stale the moment Torn updated the cell.
    const t = tornTextOf(cell).toLowerCase()
    const has = (w) => c.includes(w) || t.includes(w)
    if (has('hospital') || has('hosp')) return 'hospital'
    if (has('federal') || has('jail')) return 'jail'
    if (has('travel')) return 'traveling'
    if (has('abroad') || /^in [a-z]/.test(t)) return 'abroad'
    if (has('okay')) return 'okay'
    return null
  }

  /**
   * Hand the status cell back to Torn.
   *
   * ⚠️ There is nothing to restore any more, and that is the point (#613).
   * This used to write Torn's remembered text back with `cell.textContent =`,
   * which destroyed a text node React owned — while trying to undo the damage
   * done by the identical write on the way in. Now Torn's own content was
   * never removed, so releasing is just dropping our node and our classes.
   */
  function releaseStatusCell(cell) {
    if (!cell) return
    releaseOwn(cell)
    cell.classList.remove(STATUS_CLASS)
    cell.style.removeProperty('--tnl-status')
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
    if (od && od.getTime() > Date.now()) out.push('\u2620 Overdosed')
    return out
  }

  function paintStatus(row, playerId, nowMs) {
    const cell = statusCellOf(row)
    if (!cell) return false
    if (!settings.on(SETTING_STATUS)) { releaseStatusCell(cell); return false }

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

    // Ours, appended beside Torn's own text rather than replacing it. This
    // one line ran every second across every row on the page, so it was by far
    // the most frequent way the script destroyed a node React was holding.
    ownText(cell, view.text)
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
    // Torn comma-formats any score ≥ 1,000 ("1,009.26"), and Number() treats
    // a comma as invalid rather than a thousands separator — every such row
    // read as NaN, so a real top score sorted last as "missing" instead of
    // first (#547). No cell stays no cell: optional-chain past the replace
    // rather than defaulting to '', or Number('') is 0, not the null a
    // missing score needs.
    const n = Number(scoreCellOf(row)?.textContent?.replace(/,/g, ''))
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
    // rt.sortState is keyed by the list ELEMENT, so every list Torn re-renders
    // leaves its old node pinned in the Map — and with it that whole detached
    // subtree. On a war page that re-renders for hours this grows without
    // bound, which is the shape of a session that gets slower and then dies.
    // Dropping disconnected keys here costs one pass over a Map that should
    // never hold more than a handful of live lists.
    for (const list of rt.sortState.keys()) {
      if (list && list.isConnected === false) rt.sortState.delete(list)
    }
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
    //
    // ⚠️ This used to be `el.textContent = ''`, which removes EVERY child —
    // including whatever text node React put there and is still holding a
    // reference to (#613). ownEl() appends beside Torn's content and hides it
    // instead, so React's own nodes are never destroyed.
    const labelEl = ownEl(el)
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
      log('Torn header clicked \u2014 releasing our sort')
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
      const arrow = state.key !== key ? '' : state.dir === -1 ? ' \u25BE' : ' \u25B4'
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

  /**
   * Is the war roster actually ON SCREEN right now?
   *
   * ⚠️ The hash is not enough, and believing it was is what let the stylesheet
   * wreck Torn's own page (#610). Torn routes faction tabs client-side and can
   * re-render the content area into a different tab while `#/war/rank` is still
   * in the address bar — no `hashchange`, no `popstate`, nothing we listen for.
   * `isWarRankPage()` then answers "yes" about a page that is showing Armory,
   * so the sheet stayed armed and its deliberately broad rules — `.white-grad`,
   * `.table-header`, `ul.members-list`, `.table-body`, all Torn component
   * classes reused across every tab — forced Torn's own furniture to
   * `display:flex; width:100%` and collapsed the content region. That is the
   * page going blank after anywhere from two to thirty seconds.
   *
   * Asking the DOM instead cannot be wrong in that direction: if there is no
   * roster to lay out, there is nothing our layout rules should be touching,
   * whatever the URL claims. The cost is a possible extra teardown/re-arm cycle
   * before Torn paints the roster, which the MutationObserver resolves on the
   * next batch and which teardownWarUi() makes nearly free with its own
   * bail-out.
   */
  function warRosterPresent() {
    return memberLists().length > 0
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
  /** On a button while it is being held, so the hold is visibly registering. */
  const ASSIST_BTN_HELD_CLASS = 'tnl-assist-btn-held'
  /** The \u00D7N pip on a button whose request is for more than one. */
  const ASSIST_COUNT_CLASS = 'tnl-assist-count'
  const ASSIST_HANDLE_CLASS = 'tnl-assist-handle'
  const ASSIST_COLLAPSED_CLASS = 'tnl-assist-collapsed'
  /** `{left, top}` in viewport px, and the collapsed flag — both per-browser. */
  const ASSIST_POS_KEY = 'tnl-dibs-assist-pos'
  const ASSIST_COLLAPSED_KEY = 'tnl-dibs-assist-collapsed'
  /** Fallback corner when nothing is stored. Bottom-left: Torn's own attack
   *  controls sit centre and top-right, which is what the old fixed
   *  `top:70px; right:10px` was landing on top of. */
  const ASSIST_MARGIN = 12

  /**
   * Keep a remembered position inside the window.
   *
   * Pure so it can be tested without a DOM, and necessary rather than tidy: a
   * position saved on a wide desktop puts the panel off-screen on a phone or
   * after the window is narrowed, and an off-screen panel is unreachable —
   * there would be no way to drag it back.
   */
  function clampAssistPos(pos, size, viewport) {
    const w = Math.max(0, Number(size?.w) || 0)
    const h = Math.max(0, Number(size?.h) || 0)
    const vw = Math.max(0, Number(viewport?.vw) || 0)
    const vh = Math.max(0, Number(viewport?.vh) || 0)
    const maxLeft = Math.max(0, vw - w - ASSIST_MARGIN)
    const maxTop = Math.max(0, vh - h - ASSIST_MARGIN)
    // `== null` on purpose, not Number.isFinite(Number(v)): Number(null) is 0,
    // which is finite, so a null "top" would silently mean the TOP edge rather
    // than "no preference, use the default corner".
    const has = (v) => v != null && Number.isFinite(Number(v))
    const left = has(pos?.left) ? Number(pos.left) : maxLeft
    const top = has(pos?.top) ? Number(pos.top) : maxTop
    return {
      left: Math.min(Math.max(ASSIST_MARGIN, left), Math.max(ASSIST_MARGIN, maxLeft)),
      top: Math.min(Math.max(ASSIST_MARGIN, top), Math.max(ASSIST_MARGIN, maxTop)),
    }
  }

  /** Stored position, or null when unset/corrupt — the caller picks a corner. */
  function parseAssistPos(raw) {
    if (raw === null || raw === undefined || raw === '') return null
    let obj = raw
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw) } catch { return null }
    }
    if (!obj || typeof obj !== 'object') return null
    const left = Number(obj.left)
    const top = Number(obj.top)
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null
    return { left, top }
  }

  function readAssistPos() {
    return parseAssistPos(gmGet(ASSIST_POS_KEY, null))
  }

  function writeAssistPos(pos) {
    gmSet(ASSIST_POS_KEY, JSON.stringify(pos))
  }

  function assistCollapsed() {
    return gmGet(ASSIST_COLLAPSED_KEY, 'false') === 'true'
  }

  function setAssistCollapsed(on) {
    gmSet(ASSIST_COLLAPSED_KEY, on ? 'true' : 'false')
  }

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
  /* left/top are written by placeAssistOverlay(); these are only the values
     that apply for the frame before it runs. The old fixed top-right corner is
     gone: that is where Torn puts its own attack controls, and a pinned panel
     sitting on them cannot be moved out of the way. */
  left: ${ASSIST_MARGIN}px; top: ${ASSIST_MARGIN}px;
  display: flex; gap: 6px; align-items: center;
  background: rgba(17,24,39,.92); border: 1px solid #374151; border-radius: 8px;
  padding: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.4);
  pointer-events: auto;
}
#${ASSIST_OVERLAY_ID} button {
  display: flex; align-items: center; justify-content: center;
  width: 30px; height: 30px;
  border-radius: 6px; border: 1px solid #4b5563; background: #1f2937;
  color: #e5e7eb; cursor: pointer; padding: 0;
}
#${ASSIST_OVERLAY_ID} button:hover { background: #374151; }
#${ASSIST_OVERLAY_ID} button.${ASSIST_BTN_ACTIVE_CLASS} { background: #ea580c; border-color: #ea580c; }
/* Held past the point of being a tap (#600). Half a second is a long time to
   hold something that gives no sign of noticing, so the button shrinks under
   the finger the moment the hold starts and springs back if you let go early —
   which also teaches the gesture without a word of instruction. */
#${ASSIST_OVERLAY_ID} button.${ASSIST_BTN_HELD_CLASS} {
  transform: scale(.88);
  transition: transform ${LONG_PRESS_MS}ms ease-out;
}
/* A hold on a touchscreen otherwise selects the icon and pops the callout,
   both of which land on top of the gesture. The contextmenu half of this is
   handled in JS -- it is an event, not a style, and no backtick may appear
   anywhere in this sheet: it is a template literal, and one ends it. */
#${ASSIST_OVERLAY_ID} button {
  touch-action: manipulation;
  user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
/* The count rides in the button's own corner rather than replacing the icon:
   which KIND you asked for still has to be readable at a glance. */
#${ASSIST_OVERLAY_ID} button { position: relative; }
#${ASSIST_OVERLAY_ID} .${ASSIST_COUNT_CLASS} {
  position: absolute; right: -3px; bottom: -3px;
  min-width: 15px; height: 15px; padding: 0 3px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 8px; background: #111827; border: 1px solid #f97316;
  color: #fdba74; font: 700 9px/1 system-ui, sans-serif;
  pointer-events: none;
}
/* The grab handle. Dragging is bound to this alone, never to the box, so a
   mis-aimed drag can never swallow a click meant for an assist button. */
#${ASSIST_OVERLAY_ID} .${ASSIST_HANDLE_CLASS} {
  width: 14px; height: 30px; flex: 0 0 14px;
  display: flex; align-items: center; justify-content: center;
  cursor: grab; color: #9ca3af; user-select: none;
  border-radius: 4px;
  /* Scoped to the handle, not the box: this suppresses the browser's own
     touch gestures so a drag moves the panel instead of scrolling the page,
     and putting it on the box would kill scrolling over the buttons too. */
  touch-action: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#${ASSIST_OVERLAY_ID} .${ASSIST_HANDLE_CLASS}:hover { background: #374151; color: #e5e7eb; }
#${ASSIST_OVERLAY_ID} .${ASSIST_HANDLE_CLASS}:active { cursor: grabbing; }
/* Collapsed: the handle alone, so it can be parked anywhere without covering
   anything. Clicking it brings the buttons back. */
#${ASSIST_OVERLAY_ID}.${ASSIST_COLLAPSED_CLASS} button { display: none; }
#${ASSIST_OVERLAY_ID}.${ASSIST_COLLAPSED_CLASS} { padding: 3px; opacity: .75; }
#${ASSIST_OVERLAY_ID}.${ASSIST_COLLAPSED_CLASS}:hover { opacity: 1; }
/* Touch. A 14px grip and 30px buttons are a mouse's targets, not a thumb's \u2014
   the usual floor is ~44px, and the handle is the one control that MUST be
   hittable or the panel can never be moved off whatever it is covering.
   The hover:none half of the query is there because a touchscreen laptop
   reports a coarse pointer while still having a real cursor. */
@media (pointer: coarse) and (hover: none) {
  #${ASSIST_OVERLAY_ID} { gap: 8px; padding: 8px; }
  #${ASSIST_OVERLAY_ID} button { width: 44px; height: 44px; }
  #${ASSIST_OVERLAY_ID} .${ASSIST_HANDLE_CLASS} {
    width: 26px; flex: 0 0 26px; height: 44px; font-size: 18px;
  }
  #${ASSIST_OVERLAY_ID}.${ASSIST_COLLAPSED_CLASS} { padding: 6px; opacity: .85; }
  #${ASSIST_OVERLAY_ID} .${ASSIST_COUNT_CLASS} {
    min-width: 18px; height: 18px; font-size: 11px;
  }
}
`
    document.head.appendChild(el)
  }

  /**
   * Write the remembered position onto the box, clamped to the window.
   *
   * Called after every render and on resize, not just on drop: the panel is
   * `position: fixed`, so a window that shrinks below the stored coordinates
   * would otherwise strand it off-screen with no way to drag it back.
   */
  /**
   * The area the user can actually see, which on mobile is not window.inner*.
   *
   * A phone's URL bar and on-screen keyboard shrink the visual viewport without
   * changing innerHeight, so clamping to innerHeight parks the panel behind the
   * keyboard — reachable only by dismissing it, which is exactly when you want
   * the panel. visualViewport reports the real visible box; falls back cleanly
   * on desktop and on anything that does not implement it.
   */
  function viewportSize() {
    if (typeof window === 'undefined') return { vw: 0, vh: 0 }
    const vv = window.visualViewport
    return {
      vw: Math.round(vv?.width ?? window.innerWidth ?? 0),
      vh: Math.round(vv?.height ?? window.innerHeight ?? 0),
    }
  }

  function placeAssistOverlay(box) {
    if (!box || typeof window === 'undefined') return
    const rect = typeof box.getBoundingClientRect === 'function' ? box.getBoundingClientRect() : null
    const size = { w: rect?.width ?? 0, h: rect?.height ?? 0 }
    const viewport = viewportSize()
    // No stored position → bottom-left, which is the corner Torn leaves clear
    // on the attack page. clampAssistPos() turns the nulls into exactly that.
    const stored = readAssistPos()
    const pos = clampAssistPos(stored ?? { left: ASSIST_MARGIN, top: null }, size, viewport)
    box.style.left = `${pos.left}px`
    box.style.top = `${pos.top}px`
    return pos
  }

  /**
   * Pointer-drag on the handle, with the result remembered.
   *
   * Pointer events rather than mouse events so this works with a touch drag on
   * mobile, and setPointerCapture so the drag survives the pointer leaving the
   * handle mid-move — without it, a fast drag drops the panel the moment the
   * cursor outruns a 14px target.
   */
  function bindAssistDrag(box, handle) {
    if (!handle || typeof handle.addEventListener !== 'function') return
    let dragging = null

    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      const rect = box.getBoundingClientRect()
      dragging = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false }
      try { handle.setPointerCapture(e.pointerId) } catch { /* not supported: plain move still works */ }
    })

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return
      e.preventDefault()
      dragging.moved = true
      const rect = box.getBoundingClientRect()
      const pos = clampAssistPos(
        { left: e.clientX - dragging.dx, top: e.clientY - dragging.dy },
        { w: rect.width, h: rect.height },
        viewportSize(),
      )
      box.style.left = `${pos.left}px`
      box.style.top = `${pos.top}px`
    })

    const end = (e) => {
      if (!dragging) return
      const wasDrag = dragging.moved
      dragging = null
      try { handle.releasePointerCapture(e.pointerId) } catch { /* nothing to release */ }
      if (wasDrag) {
        writeAssistPos({ left: parseFloat(box.style.left) || 0, top: parseFloat(box.style.top) || 0 })
        return
      }
      // A click, not a drag: fold the panel down to the handle so it can be
      // parked over nothing at all, and remember that too.
      const next = !box.classList.contains(ASSIST_COLLAPSED_CLASS)
      box.classList.toggle(ASSIST_COLLAPSED_CLASS, next)
      setAssistCollapsed(next)
      placeAssistOverlay(box)
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  let assistResizeBound = false

  function ensureAssistOverlay() {
    if (typeof document === 'undefined') return null
    let box = document.getElementById(ASSIST_OVERLAY_ID)
    if (box && box.isConnected) return box
    box = document.createElement('div')
    box.id = ASSIST_OVERLAY_ID
    const handle = document.createElement('div')
    handle.className = ASSIST_HANDLE_CLASS
    handle.title = 'Drag to move \u2014 click to collapse'
    // An SVG grip, not a glyph. The braille-dots character this used to be was
    // doubly fragile: it renders as mojibake wherever the file is decoded as
    // anything but UTF-8 (Torn PDA's webview, which is what surfaced it), and
    // even decoded correctly it depends on the platform having a font that
    // covers U+2800..U+28FF. This is the one control that MUST be visible —
    // it is the only way to move the panel off whatever it is covering — so it
    // gets a shape that cannot fail to draw.
    handle.innerHTML =
      '<svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true" fill="currentColor">'
      + '<circle cx="2" cy="3" r="1.2"/><circle cx="6" cy="3" r="1.2"/>'
      + '<circle cx="2" cy="8" r="1.2"/><circle cx="6" cy="8" r="1.2"/>'
      + '<circle cx="2" cy="13" r="1.2"/><circle cx="6" cy="13" r="1.2"/>'
      + '</svg>'
    box.appendChild(handle)
    for (const kind of Object.keys(ASSIST_KIND_META)) {
      const meta = ASSIST_KIND_META[kind]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.tnlKind = kind
      btn.title = meta.label
      const svg = assistIconSvg(meta.icon, 16)
      if (svg) btn.innerHTML = svg
      else btn.textContent = meta.label
      // Press gesture (#600): a tap asks for one more, a hold gives one back.
      //
      // The hold fires at the threshold while the button is STILL HELD rather
      // than on release. Waiting for release would mean holding for half a
      // second with no way to tell whether it had registered until you let go,
      // which mid-fight is exactly when you cannot afford to guess.
      //
      // Pointer events rather than mouse events so a thumb and a mouse take the
      // same path, and `pointercancel` matters more than it looks: a touch that
      // turns into a page scroll fires cancel, never up, and without it the
      // timer would survive and fire a decrement the user never asked for.
      let holdTimer = null
      let handled = false   // a hold already acted — swallow the click it becomes

      const act = async (gesture) => {
        const targetId = attackTargetId(typeof location !== 'undefined' ? location.search : '')
        if (!targetId) return
        const what = assistPressAction(rt.assists.get(targetId), kind, gesture)
        if (what === 'noop') return
        btn.disabled = true
        const res = what === 'decrement'
          ? await decrementAssist(targetId, kind)
          : await requestAssist(targetId, kind)
        btn.disabled = false
        // Not showToast(): that relies on injectStyles()' faction-page-only
        // stylesheet for its look, which never runs on the attack page — an
        // unstyled floating div is worse than the same failure surfacing the
        // way a failed dibs claim already does elsewhere in this file, on
        // the control itself.
        if (!res.ok) btn.title = res.message
        renderAssistOverlay()
      }

      const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null } }

      // ⚠️ One decrement per gesture, whichever route it arrives by.
      //
      // A long press on a touchscreen fires the hold timer AND synthesises a
      // `contextmenu` — the same physical press reaching us twice. Both routes
      // go through here, and the time window swallows the second: they are one
      // gesture, and taking two off a count for one press would be worse than
      // taking none. The window is generous because the synthesised event can
      // trail the timer by a good fraction of a second on a slow phone.
      let lastLongAt = 0
      const fireLong = () => {
        const now = Date.now()
        if (now - lastLongAt < LONG_PRESS_MS) return
        lastLongAt = now
        handled = true          // swallow the click a touch press turns into
        cancelHold()
        btn.classList.remove(ASSIST_BTN_HELD_CLASS)
        act('long')
      }

      btn.addEventListener('pointerdown', (e) => {
        // A right-click's own pointerdown is left alone deliberately: it starts
        // no hold and clears no latch, so the contextmenu below is the only
        // thing that acts on it.
        if (e.button != null && e.button !== 0) return
        handled = false
        cancelHold()
        holdTimer = setTimeout(() => { holdTimer = null; fireLong() }, LONG_PRESS_MS)
        btn.classList.add(ASSIST_BTN_HELD_CLASS)
      })
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
        btn.addEventListener(type, () => { cancelHold(); btn.classList.remove(ASSIST_BTN_HELD_CLASS) })
      }
      // Right-click is the desktop shortcut for the hold — same act, reachable
      // without waiting half a second at a mouse. preventDefault is not
      // optional either way: on a touchscreen this event IS the long press,
      // and letting it through pops the context menu and the selection callout
      // on top of the gesture.
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation()
        fireLong()
      })
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        // The hold already acted; the browser still delivers the click that the
        // press turned into, and letting it through would immediately undo the
        // decrement by asking for one more.
        if (handled) { handled = false; return }
        act('short')
      })
      box.appendChild(btn)
    }
    if (assistCollapsed()) box.classList.add(ASSIST_COLLAPSED_CLASS)
    document.body.appendChild(box)
    bindAssistDrag(box, handle)
    placeAssistOverlay(box)
    // Once per page, not once per rebuild: renderAssistOverlay() removes the
    // box whenever there is no target and builds a fresh one when there is,
    // so binding here unguarded would stack a new listener on every fight.
    if (!assistResizeBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      assistResizeBound = true
      const reflow = () => {
        const live = document.getElementById(ASSIST_OVERLAY_ID)
        if (live) placeAssistOverlay(live)
      }
      window.addEventListener('resize', reflow)
      // Rotating a phone does not reliably fire `resize` before the new
      // dimensions settle, and the visual viewport changes on its own as the
      // URL bar collapses or the keyboard opens — neither raises `resize`.
      window.addEventListener('orientationchange', reflow)
      window.visualViewport?.addEventListener?.('resize', reflow)
      window.visualViewport?.addEventListener?.('scroll', reflow)
    }
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
    // ⚠️ #617: what's outstanding on the TARGET, not what you personally
    // asked for. The old version lit a button only while YOUR request of that
    // kind was live, which under shared counts would hide the very thing this
    // panel exists to tell you — walking into a fight where two people already
    // want a smoke, the buttons would sit dark because neither was yours.
    const open = rt.assists.get(targetId)
    const wantedByKind = new Map(liveKinds(open).map(k => [k.kind, k.wanted]))
    for (const btn of box.querySelectorAll('button')) {
      const wanted = wantedByKind.get(btn.dataset.tnlKind) ?? 0
      btn.classList.toggle(ASSIST_BTN_ACTIVE_CLASS, wanted > 0)
      // #591: the count belongs ON the button you press to raise it — this is
      // the surface where you decide whether to ask for one more, so it has to
      // say how many are already wanted without a round trip to the roster.
      // Only shown past one: "×1" is noise.
      let pip = btn.querySelector(`.${ASSIST_COUNT_CLASS}`)
      if (wanted > 1) {
        if (!pip) {
          pip = document.createElement('span')
          pip.className = ASSIST_COUNT_CLASS
          btn.appendChild(pip)
        }
        const text = `\u00D7${wanted}`
        if (pip.textContent !== text) pip.textContent = text
      } else if (pip) {
        pip.remove()
      }
      const meta = ASSIST_KIND_META[btn.dataset.tnlKind]
      if (meta) {
        // The hold is the only gesture here with nothing on screen to
        // advertise it, so the tooltip is where it gets taught.
        btn.title = wanted > 0
          ? `${meta.label} \u00B7 ${wanted} still needed \u00B7 tap for one more, hold to take one back`
          : `${meta.label} \u00B7 tap to request`
      }
    }
  }

  /**
   * Read-only DOM glue for loadout capture (#528 Part 2) — passive, silent,
   * appends and reparents nothing.
   *
   * ⚠️ `#modelLayersContainer` and the weapon wrapper ids (`#weapon_main`
   * etc.) are BOTH duplicated by Torn, once per side — the attacker's own
   * panel carries the identical ids. A bare `document.querySelector('#…')`
   * always resolves to the FIRST match, and the attacker's panel is always
   * first in document order, so every capture was silently reading the
   * attacker's OWN gear as if it were the target's (caught live in
   * production — three real captures, every one just MonChoon's own
   * loadout). `defender___<hash>` is the one class fragment Torn puts only
   * on the opponent's weapon wrappers — present pre-fight (on the empty
   * "not available" slots) and mid-fight alike — so anchor there instead and
   * walk up to the shared ancestor panel, then scope every subsequent read
   * inside it.
   */
  function defenderScopeElement() {
    if (typeof document === 'undefined') return null
    const defenderWeapon = document.querySelector('[class*="defender___"]')
    if (!defenderWeapon) return null
    let el = defenderWeapon.parentElement
    let hops = 0
    while (el && hops < 12) {
      if (el.querySelector('#modelLayersContainer')) return el
      el = el.parentElement
      hops++
    }
    return null
  }

  function captureWeapons(scope) {
    const out = {}
    if (!scope) return out
    for (const [id, slot] of Object.entries(WEAPON_WRAPPER_SLOTS)) {
      const el = scope.querySelector(`#${id}`)
      if (!el) continue
      const name = parseWeaponAriaLabel(el.getAttribute('aria-label'))
      if (!name) continue // empty slot ("This weapon is not available") or unrevealed
      const entry = { name }
      const itemId = weaponItemIdFromSrc(el.querySelector('img')?.getAttribute('src'))
      if (itemId) entry.item_id = itemId
      out[slot] = entry
    }
    return out
  }

  /** Scoped to the same defender ancestor captureWeapons() reads — see
   *  defenderScopeElement()'s own note on why an unscoped, document-wide
   *  read silently pulled in the attacker's own armour too. */
  function captureArmor(scope) {
    const out = {}
    if (!scope) return out
    const areas = scope.querySelectorAll('#modelLayersContainer map area[title][alt]')
    for (const area of areas) {
      const slot = mapArmorAltToSlot(area.getAttribute('alt'))
      const name = (area.getAttribute('title') || '').trim()
      if (!slot || !name) continue
      out[slot] = { name }
    }
    return out
  }

  /** Assembles one capture, or null when the defender's panel isn't
   *  identifiable yet (pre-fight) or nothing readable was found on it. */
  function captureLoadout() {
    const scope = defenderScopeElement()
    if (!scope) return null
    const loadout = { weapons: captureWeapons(scope), armor: captureArmor(scope) }
    return loadoutIsEmpty(loadout) ? null : loadout
  }

  /**
   * Runs every poll tick on the attack page (#528: "passive and silent... do
   * not re-POST on every render tick for the same fight"). Sends AT MOST ONCE
   * per attack, not once per content change — a loadout cannot change once a
   * fight is under way, so there is nothing to gain from re-sending a fuller
   * read as Torn progressively reveals more of it, and doing so was flooding
   * the endpoint with near-duplicate rows for a single fight (MonChoon,
   * 2026-08-23). `rt.loadoutSent` latches true on the first successful POST
   * and only resets when the URL's target id changes to a genuinely new
   * fight — a failed POST does NOT latch, so a transient error gets retried
   * on the next tick rather than silently giving up for the rest of the fight.
   */
  /**
   * Read the attack page's fight log into the plain rows assistCandidates()
   * wants.
   *
   * ⚠️ The `attacking-events-*` class is the only stable hook on a row.
   * Everything around it (`row___`, `message___`, `col2___`) is a CSS-module
   * hash Torn rotates every deploy, so those are matched by PREFIX and the
   * event type comes from the class alone.
   */
  function readFightLogRows() {
    if (typeof document === 'undefined') return []
    const rows = []
    for (const li of document.querySelectorAll('[class*="listWrap___"] li, [class*="row___"]')) {
      const icon = li.querySelector('[class^="attacking-events-"]')
      if (!icon) continue
      const message = li.querySelector('[class*="message___"]')
      const age = li.querySelector('[class*="col2___"]')
      if (!message || !age) continue
      rows.push({
        eventClass: icon.className,
        text: message.textContent || '',
        age: age.textContent || '',
      })
    }
    return rows
  }

  /**
   * The defender's NAME, which the log names actions against.
   *
   * The URL gives us `user2ID` but every log line refers to the target by name,
   * so the two have to be bridged before anything can be filtered. Read off the
   * page rather than the roster: the attack page has no roster, which is the
   * same reason the faction check has to happen server-side.
   */
  function attackTargetName() {
    if (typeof document === 'undefined') return null
    const id = attackTargetId(typeof location !== 'undefined' ? location.search : '')
    if (!id) return null
    const link = document.querySelector(`a[href*="profiles.php?XID=${id}"]`)
    const text = link && link.textContent ? link.textContent.trim() : ''
    return text || null
  }

  /**
   * Report what the log shows, so the server can decrement the matching
   * requests (#591).
   *
   * Reports EVERY qualifying event every pass, deliberately — no local
   * bookkeeping of what has already been sent. The server's dedupe ledger is
   * the only thing that can be right about this: several members watch the same
   * fight, so "have I sent this" has to be answered across all of them, not per
   * browser. Re-sending is free (a conflict, counted zero); missing one is not.
   *
   * Only fires when there IS a live request against this target — otherwise
   * every fight would post a stream of events with nothing to answer.
   */
  async function reportFightLog() {
    if (!isAttackPage() || !rt.session) return
    const targetId = attackTargetId(typeof location !== 'undefined' ? location.search : '')
    if (!targetId) return
    const open = rt.assists.get(targetId)
    if (!open) return

    // ⚠️ NOT a gate any more, and that is the bug this fixes (#618).
    //
    // attackTargetName() looks for `a[href*="profiles.php?XID=<id>"]` on the
    // attack page. That was always a guess — flagged as unverified when it was
    // written — and a page that does not render the defender as a profile link
    // makes it null, at which point this function returned and NOT ONE event
    // was ever reported. A live smoke sat uncounted for twenty seconds with
    // everything else working perfectly.
    //
    // The name is now a prefilter when we happen to have it, and the server
    // decides. It resolves the SUBJECT name to a member id and checks it
    // against the target — on ids, against the roster, which is the same place
    // and the same reason the actor's faction is already checked there. The
    // attack page has no roster; the server does.
    const targetName = attackTargetName()

    const rows = readFightLogRows()
    const events = assistCandidates(rows, {
      targetName,
      // The session carries an id, not a name, and the log names actors — so
      // "is this the requester" cannot be answered here. It is answered on the
      // server instead, on ids, where a scraped name is never trusted anyway.
      requesterName: null,
      // ⚠️ #617: the EARLIEST live raise, not the newest. Each kind carries its
      // own timestamp now, and this bound exists to drop log lines from before
      // anyone asked — so taking the latest would discard events that answer a
      // kind raised earlier and still outstanding.
      requestedAtMs: earliestRaisedAtMs(open),
    })
    // Every bail-out says why. This path is unobservable from the outside —
    // a count that does not move looks identical whether the log was unread,
    // the parse failed, or the server declined every event — and the last
    // round of this took a live war and a screenshot to narrow down.
    if (events.length === 0) {
      log(`fight log: ${rows.length} row(s) read, 0 candidates`,
        `(target name ${targetName ?? 'unreadable'}, earliest request at ${earliestRaisedAtMs(open) ?? 'unknown'})`)
      return
    }

    try {
      const res = await api('/api/war-room/assist/observed', 'POST', {
        target_id: targetId,
        events: events.map((e) => ({ kind: e.kind, actor_name: e.actor, subject_name: e.subject, at_ms: e.at_ms })),
      })
      const counted = Number(res.body?.counted)
      if (res.status === 200 && counted > 0) {
        log(`fight log: ${counted} observed action(s) counted against the request`)
        pokePoll()
      } else {
        log(`fight log: ${events.length} candidate(s) reported, ${counted || 0} counted`,
          `(HTTP ${res.status})`)
      }
    } catch (err) {
      log('fight-log report failed:', err.message)
    }
  }

  async function checkLoadoutCapture() {
    if (!isAttackPage() || !rt.session) return
    const targetId = attackTargetId(typeof location !== 'undefined' ? location.search : '')
    if (!targetId) return
    if (rt.loadoutTarget !== targetId) { rt.loadoutTarget = targetId; rt.loadoutSent = false }
    if (rt.loadoutSent) return

    const loadout = captureLoadout()
    if (!loadout) return

    try {
      const res = await api('/api/war-room/loadout', 'POST', { target_id: targetId, loadout })
      if (res.status === 200) {
        rt.loadoutSent = true
      } else {
        log(`loadout capture rejected (${res.status}): ${res.body?.error ?? 'unknown error'}`)
      }
    } catch (err) {
      log('loadout capture failed:', err.message)
    }
  }

  /**
   * Undo everything faction-side, for when the SPA routes away from the war
   * page (#/armory, #/crimes, …) without a page load.
   *
   * This is the half that was missing, and it is what made the script look
   * "active on more pages than the war page": injectStyles() writes ONE
   * stylesheet into <head> and nothing ever took it out again. Its selectors
   * are deliberately broad — `.white-grad`, `.table-header`,
   * `[class*="tableHeader"]`, `ul.members-list`, `.table-body` — because on
   * the war roster those ARE the roster. They are Torn component classes
   * reused across every faction tab, so once the user clicked Armory those
   * same rules forced Torn's own furniture to `display:flex; width:100%`,
   * which is the empty full-width bar showing the tab name, and on a heavier
   * tab is enough to collapse the content region outright.
   *
   * Row-level cells are not chased here: Torn re-renders the content area on
   * every route change, so they leave with it. What survives a route change is
   * what this removes — the stylesheet, the <html> classes, and the furniture
   * parked on <body> or in the persistent page-title bar. The querySelectorAll
   * sweep at the end is belt-and-braces for a re-render that kept the rows.
   */
  function teardownWarUi() {
    if (typeof document === 'undefined') return
    // Cheap bail-out: the stylesheet is injected first and removed last, so its
    // absence means there is nothing left to undo. This runs on every mutation
    // batch while the user sits on another tab, so it must cost ~nothing.
    if (!document.getElementById(STYLE_ID)
        && !document.documentElement.classList.contains(WAR_ACTIVE_CLASS)) return

    // NOT the launcher, and not its settings panel — those are faction-page
    // furniture and survive a tab change (see render()). Everything here is
    // roster furniture: the stylesheet written against the war table, the stat
    // tooltip, the chain badge and its popover, and the toast host, which has
    // no styling of its own once the stylesheet is gone.
    for (const id of [STYLE_ID, TIP_ID, CHAIN_BADGE_ID, TOAST_HOST_ID]) {
      document.getElementById(id)?.remove()
    }
    chainBadge = null
    if (chainPanelBox && chainPanelBox.isConnected) chainPanelBox.remove()
    chainPanelBox = null
    rt.chainOpen = false

    document.documentElement.classList.remove(WAR_ACTIVE_CLASS, NO_BS_CLASS, TINTING_CLASS)

    for (const el of document.querySelectorAll(`.${DIBS_CLASS}, .${BS_CLASS}, .${MEMBER_COUNT_CLASS}`)) {
      el.remove()
    }
    // Sorting positions rows with a flex `order`, which our stylesheet is what
    // makes meaningful — left behind it would scramble Torn's own list. Scoped
    // to the two list containers rather than a document-wide [style*="order"]:
    // that substring also matches every inline `border`, so it would walk most
    // of the page to find a handful of rows.
    for (const list of document.querySelectorAll('ul.members-list, .table-body')) {
      for (const row of list.children) {
        if (row.style?.order) row.style.order = ''
      }
      delete list.dataset.tnlOrderSig
    }
    rt.sortState = new Map()
    rt.sorted = false
    rt.painted = -1
    rt.attached = -1
    log('left the war tab \u2014 roster styles and columns removed (launcher stays)')
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
    // The launcher and its status light belong to the whole faction page, not
    // to the war tab: it is how you reach settings and how you tell whether
    // the script is connected at all, and both of those are worth knowing from
    // Armory or Crimes. It is also self-contained — inline-styled, parked in
    // Torn's own page-title links — so it needs none of the roster stylesheet
    // below. Re-asserted on every pass because Torn re-renders the page title
    // out from under it on navigation.
    ensureLauncher()
    // Faction page, but not the war roster (the user clicked Armory, Crimes,
    // …): actively undo the ROSTER furniture rather than merely skipping the
    // paint. The hash moves without a page load, so "skip" would leave the
    // stylesheet applied to a tab it was never written for.
    //
    // BOTH conditions, not just the route (#610). The hash can still read
    // `#/war/rank` while Torn has re-rendered the content area into another
    // tab — see warRosterPresent() for why that is the case that broke the
    // page. The DOM is the authority on what is being shown; the URL is only a
    // hint about what was asked for.
    if (!isWarRankPage() || !warRosterPresent()) { teardownWarUi(); return }
    injectStyles()
    // Arms the scoped stylesheet. Every rule in it is prefixed with this class,
    // so this line — not the presence of the <style> element — is what makes
    // the sheet live.
    document.documentElement.classList.add(WAR_ACTIVE_CLASS)
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
    // Torn routes faction tabs client-side, so leaving or entering the war page
    // fires no navigation the script would otherwise see. Without this the gate
    // in render() is only ever evaluated against the hash the page happened to
    // load with. `hashchange` covers Torn's own tab links; `popstate` covers
    // the browser's back/forward over the same routes.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onRoute = () => { log(`route \u2192 ${location.hash || '(none)'}`); render() }
      window.addEventListener('hashchange', onRoute)
      window.addEventListener('popstate', onRoute)
    }
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
  /**
   * Where the launcher lives: Torn's own page-title links, or our own strip.
   *
   * `#top-page-links-list` is a desktop-layout element. When it is absent —
   * Torn PDA's webview and Torn's narrow mobile layout are the cases seen —
   * the old code returned null and the launcher simply never appeared, which
   * is indistinguishable from "the script did not run at all". That made the
   * one thing you need in order to diagnose anything (the status light) the
   * first thing to disappear on the platform hardest to debug.
   *
   * The fallback is a small fixed strip of our own. It is deliberately plain:
   * it exists so the script is always reachable and always able to say what
   * state it is in.
   */
  function launcherHost() {
    const native = document.getElementById('top-page-links-list')
    if (native) {
      document.getElementById(LAUNCHER_HOST_ID)?.remove()
      return native
    }
    let host = document.getElementById(LAUNCHER_HOST_ID)
    if (host && host.isConnected) return host
    if (!document.body) return null
    host = document.createElement('div')
    host.id = LAUNCHER_HOST_ID
    host.style.cssText = [
      'position:fixed', 'left:8px', 'top:8px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:6px',
      'background:rgba(17,24,39,.92)', 'border:1px solid #374151',
      'border-radius:8px', 'padding:4px 8px',
      'font:12px/1.4 system-ui,sans-serif', 'color:#e5e7eb',
      'box-shadow:0 4px 16px rgba(0,0,0,.4)', 'cursor:pointer',
    ].join(';')
    document.body.appendChild(host)
    log('no #top-page-links-list on this layout \u2014 using the fallback launcher strip')
    return host
  }

  function ensureLauncher() {
    if (typeof document === 'undefined') return null
    const found = document.getElementById(LAUNCHER_ID)
    if (found && found.isConnected) { launcher = found; return found }

    const list = launcherHost()
    if (!list) { launcher = null; return null }

    const link = document.createElement('a')
    link.id = LAUNCHER_ID
    link.href = '#'
    // Torn's own classes, so it inherits their type, hover and spacing.
    link.className = 't-clear h c-pointer m-icon line-h24 right'
    link.setAttribute('aria-labelledby', LAUNCHER_LABEL_ID)
    // Those are Torn's own classes and style nothing inside our fallback strip.
    if (list.id === LAUNCHER_HOST_ID) {
      link.style.cssText = 'display:flex;align-items:center;gap:6px;color:#e5e7eb;text-decoration:none'
    }

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

  /**
   * Where a popover goes so that it sits just under its launcher.
   *
   * Pure: takes the anchor's viewport rect and gives back viewport
   * coordinates, clamped so a launcher near the right edge cannot push a
   * 260px-wide panel off the screen. `scroll` is what turns those viewport
   * coordinates into PAGE coordinates for an absolutely-positioned box —
   * pass {x: 0, y: 0} for a box that stays `position: fixed`.
   */
  function panelPos(rect, viewportWidth, scroll = { x: 0, y: 0 }) {
    const width = PANEL_WIDTH
    const maxLeft = Math.max(8, (viewportWidth || width) - width - 8)
    const left = Math.round(Math.min(Math.max(8, rect.left), maxLeft))
    const top = Math.round(rect.bottom + 6)
    return { left: left + (scroll?.x ?? 0), top: top + (scroll?.y ?? 0) }
  }

  /**
   * Is this anchor pinned to the viewport rather than sitting in page flow?
   *
   * Decides which positioning the popover has to copy. Get it wrong in either
   * direction and the panel drifts away from the button that opened it the
   * moment the page scrolls: `fixed` under a flowing anchor leaves the panel
   * hanging in mid-air (#590), and `absolute` under a pinned anchor scrolls
   * the panel off while the button stays put.
   *
   * Only `fixed` counts. `sticky` is deliberately excluded — a sticky element
   * scrolls normally until it reaches its threshold, so treating it as pinned
   * would be wrong for most of the page.
   */
  function anchorIsPinned(anchor) {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false
    for (let node = anchor; node && node.nodeType === 1; node = node.parentElement) {
      if (window.getComputedStyle(node).position === 'fixed') return true
    }
    return false
  }

  function pageScroll() {
    if (typeof window === 'undefined') return { x: 0, y: 0 }
    return {
      x: Math.round(window.scrollX ?? window.pageXOffset ?? 0),
      y: Math.round(window.scrollY ?? window.pageYOffset ?? 0),
    }
  }

  /**
   * Put `box` under `anchorEl` and keep it there.
   *
   * ⚠️ The box MUST already be in the document when this is called: the
   * correction pass at the end measures where it actually landed. Absolute
   * coordinates are resolved against the nearest positioned ancestor, and we
   * cannot know from here whether Torn has made <body> positioned or given it
   * a transform — measuring the error and shifting by it is exact whatever the
   * containing block turns out to be, where doing the arithmetic blind is a
   * guess that silently offsets the panel.
   */
  function placePanel(box, anchorEl = launcher) {
    box.style.zIndex = '2147483000'
    const anchor = anchorEl
    if (!anchor || !anchor.isConnected || typeof anchor.getBoundingClientRect !== 'function') {
      box.style.position = 'fixed'
      box.style.top = ''
      box.style.left = '12px'
      box.style.bottom = '12px'
      return
    }
    const pinned = anchorIsPinned(anchor)
    box.style.position = pinned ? 'fixed' : 'absolute'
    box.style.bottom = ''
    const rect = anchor.getBoundingClientRect()
    const want = panelPos(rect, window.innerWidth, { x: 0, y: 0 })
    const pos = pinned ? want : panelPos(rect, window.innerWidth, pageScroll())
    box.style.left = `${pos.left}px`
    box.style.top = `${pos.top}px`
    if (pinned || typeof box.getBoundingClientRect !== 'function' || !box.isConnected) return
    const got = box.getBoundingClientRect()
    const dx = Math.round(want.left - got.left)
    const dy = Math.round(want.top - got.top)
    if (dx || dy) {
      box.style.left = `${pos.left + dx}px`
      box.style.top = `${pos.top + dy}px`
    }
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
    link.title = 'Chain \u2014 click for the bonus-hit ladder and the save claim'

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
    info.textContent = next ? `${current} hits \u00B7 next bonus at ${next} (${next - current} to go)` : `${current} hits`
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

    // Appended first: placePanel() measures where the box actually landed.
    document.body.appendChild(box)
    placePanel(box, chainBadge)
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
      live: '\u25CF live', connecting: '\u25CB connecting\u2026', reconnecting: '\u25CB reconnecting\u2026',
      auth: '\u26A0 session expired', idle: '\u25CB not connected', error: '\u26A0 error',
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
      launcher.title = `${LAUNCHER_NAME} \u2014 ${statusText(state)}`
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
    descInput.placeholder = 'What happened, or what you\u2019d like to see'
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
      note.textContent = 'Sending\u2026'
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
      document.body.appendChild(box)
      placePanel(box)
      return
    }

    if (rt.feedbackOpen) {
      feedbackView(box)
      document.body.appendChild(box)
      placePanel(box)
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
    // Which cross-origin transport we resolved to. On a desktop userscript
    // manager this is always "GM" and not worth a line, so it is only shown
    // when it is NOT that — i.e. exactly when someone is trying to work out
    // why a phone behaves differently from their browser.
    const transport = transportName()
    if (transport !== 'GM') {
      const tag = document.createElement('span')
      tag.textContent = transport === 'none' ? '\u26A0 no HTTP bridge' : transport
      tag.style.cssText = `font-weight:400;font-size:11px;color:${transport === 'none' ? '#f59e0b' : '#9ca3af'}`
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
        go.disabled = true; note.textContent = 'Connecting\u2026'
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
      note.textContent = 'Your key is used once and never stored \u2014 only the session token is.'
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
      who.textContent = `Signed in as ${rt.session.userId} \u00B7 ${rt.session.host}`
      box.insertBefore(who, box.lastChild)
      row.appendChild(hide)
      row.appendChild(out)
      box.appendChild(row)

      const secondRow = document.createElement('div')
      secondRow.style.cssText = 'display:flex;gap:6px;margin-top:6px'

      const gear = document.createElement('button')
      gear.textContent = '\u2699 Settings'
      gear.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      gear.addEventListener('click', () => { rt.settingsOpen = true; panel() })
      secondRow.appendChild(gear)

      const feedback = document.createElement('button')
      feedback.textContent = '\uD83D\uDCAC Feedback'
      feedback.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      feedback.addEventListener('click', () => { rt.feedbackOpen = true; panel() })
      secondRow.appendChild(feedback)

      box.appendChild(secondRow)
    }

    document.body.appendChild(box)
    placePanel(box)
  }

  async function boot() {
    rt.session = rt.session || store.read()
    if (!rt.session) { log('no stored session \u2014 waiting for a key'); return }
    log(`session for ${rt.session.userId} on ${rt.session.host},`,
      `faction ${rt.session.factionId}, expires ${rt.session.expiresAt ?? 'unknown'}`)

    const mine = pageUserId()
    log(`page identity: ${mine ?? 'unreadable'}`)
    if (!identityMatches(rt.session.userId, mine)) {
      setStatus('error')
      // eslint-disable-next-line no-console
      console.warn(`[TNL Dibs] token belongs to ${rt.session.userId}, page is ${mine} \u2014 refusing to act.`)
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
    // observe() stays gated on the PATH, not the war route: the MutationObserver
    // is how we notice Torn rendering the war roster after a hash change, so it
    // has to already be watching when the user routes onto the war page. render()
    // is the gate that decides whether that batch paints anything.
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
    // The war-route gate and the assist panel's placement maths — the pure
    // halves, so the URL shapes and the off-screen clamp are testable with
    // no DOM (the clamp is what stops a remembered position stranding the
    // panel outside a smaller window, where it could never be dragged back).
    warRankRouteMatch, isWarRankPage, warRosterPresent, memberLists, clampAssistPos, parseAssistPos, panelPos,
    parseFightLogAge, parseFightLogRow, assistCandidates, readFightLogRows, attackTargetName,
    scopeCss, scopeSelector, WAR_ACTIVE_CLASS,
    indexAssists, assistsIndex, badgeState, ASSIST_KIND_META, requestAssist, clearAssist,
    assistIconSvg, paintDibs, assistCount, assistPressAction, decrementAssist, LONG_PRESS_MS,
    liveKinds, earliestRaisedAtMs, KIND_PRIORITY,
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
    ownEl, ownText, releaseOwn, tornTextOf, TOOK_CLASS, OWN_CLASS,
    versionLabel, scriptVersion, attackLinkAttrs, statValueOf, transportName, gmGet, gmSet,
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
    // #528 Part 2: enemy loadout capture — the pure parse/dedupe seam, plus
    // the DOM-scoping functions (exported despite reading `document`, via
    // loadWithDom()'s fake DOM — the attacker-vs-defender scoping bug this
    // session shipped to production lived exactly here and nowhere else,
    // which is the whole argument for testing it directly rather than
    // trusting the pure helpers alone to catch it).
    parseWeaponAriaLabel, weaponItemIdFromSrc, mapArmorAltToSlot,
    loadoutIsEmpty,
    defenderScopeElement, captureWeapons, captureArmor, captureLoadout,
  }
})()

if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
