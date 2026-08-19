// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.3.0
// @description  Claim and release War Room dibs from the Torn faction war page.
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
  const DEBUG_KEY = 'tnl-dibs-debug'
  /** Read cadence — see the transport note above for why this is a poll. */
  const POLL_MS = 3000
  const POLL_HIDDEN_MS = 30000

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
    try { return GM_getValue(DEBUG_KEY, 'false') === 'true' } catch { return false }
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

  /** What the control should say for a target, given who holds it. */
  function buttonState(dib, currentUserId) {
    if (!dib) return { label: '+ Dibs', action: 'claim', mine: false }
    if (String(dib.by) === String(currentUserId)) {
      return { label: '✓ Your dib', action: 'release', mine: true }
    }
    return { label: `🖐 ${dib.name ?? 'Claimed'}`, action: 'none', mine: false }
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
    painted: -1,            // last badge count logged, so render() is not spammy
    opponentId: null,       // the faction the war room is pointed at
    since: null,            // delta watermark, always the server's own clock
    polling: false,
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
        'content-type': 'application/json',
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
    return { ok: true }
  }

  async function release(targetId) {
    const res = await api(`/api/war-room/dibs/${targetId}`, 'DELETE')
    return res.status === 200 ? { ok: true } : { ok: false, message: `HTTP ${res.status}` }
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
      let ok = false
      let keepGoing = true
      try {
        keepGoing = await pollOnce()
        ok = keepGoing
      } catch (err) {
        setStatus('reconnecting')
        log('poll failed:', err.message)
      }
      if (!keepGoing) { rt.polling = false; return }

      // ⚠️ Back off on consecutive failures rather than hammering every 3s.
      // A tenant that is mid-deploy answers 502 for a minute or two, and every
      // member of the faction is running this at once during a war.
      const hidden = typeof document !== 'undefined' && document.hidden
      if (ok) rt.attempt = 0
      const wait = ok ? pollDelay(hidden) : Math.max(backoffFor(rt.attempt++), pollDelay(hidden))
      setTimeout(tick, wait)
    }
    tick()
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  function badgeFor(anchor, playerId) {
    let badge = anchor.parentElement?.querySelector(`.${BADGE_CLASS}[data-tnl-target="${playerId}"]`)
    if (badge) return badge
    badge = document.createElement('button')
    badge.type = 'button'
    badge.className = BADGE_CLASS
    badge.dataset.tnlTarget = String(playerId)
    badge.style.cssText = [
      'margin-left:6px', 'padding:1px 6px', 'font-size:10px', 'font-weight:600',
      'border-radius:9px', 'border:1px solid rgba(255,255,255,.25)', 'cursor:pointer',
      'vertical-align:middle', 'line-height:16px', 'white-space:nowrap',
    ].join(';')
    badge.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation()
      const state = buttonState(rt.dibs.get(playerId), rt.session?.userId)
      if (state.action === 'none') return
      badge.disabled = true
      badge.textContent = '…'
      const res = state.action === 'claim' ? await claim(playerId) : await release(playerId)
      badge.disabled = false
      if (!res.ok) badge.title = res.message
      render()          // the socket will confirm; this repaints immediately
    })
    anchor.parentElement?.appendChild(badge)
    return badge
  }

  function render() {
    let painted = 0
    for (const [playerId, anchors] of rt.nodes) {
      if (!rt.enemies.has(playerId)) continue
      painted++
      const state = buttonState(rt.dibs.get(playerId), rt.session?.userId)
      for (const anchor of anchors) {
        if (!anchor.isConnected) continue
        const badge = badgeFor(anchor, playerId)
        badge.textContent = state.label
        badge.style.background = state.mine ? '#1d4ed8' : state.action === 'none' ? '#6d28d9' : '#374151'
        badge.style.color = '#fff'
        badge.style.cursor = state.action === 'none' ? 'default' : 'pointer'
      }
    }
    // ⚠️ The single most useful line when "no badges appeared". It separates
    // the three ways that happens: no profile links found on the page at all,
    // links found but none of them enemies (an empty or mismatched roster), or
    // enemies matched and painted — in which case the problem is CSS, not us.
    if (painted !== rt.painted) {
      rt.painted = painted
      log(`painted ${painted} of ${rt.nodes.size} linked players`,
        `(${rt.enemies.size} known enemies)`)
    }
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
    render()
  }

  function observe() {
    // ⚠️ Torn renders these views dynamically, so a single pass at document-end
    // finds an empty page. Same shape as the Battle Stats Predictor observer.
    const observer = new MutationObserver((mutations) => {
      const touched = new Set()
      for (const m of mutations) {
        for (const node of m.addedNodes) if (node.nodeType === 1) touched.add(node)
      }
      for (const node of touched) scan(node)
    })
    observer.observe(document, { childList: true, subtree: true })
    scan(document)
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
   * The debug switch, in the panel rather than the console.
   *
   * The tracing that matters most — the socket's whole lifecycle — happens at
   * page load, so the setting is persisted and read on the next load. Asking a
   * member to type a console command on torn.com is also a worse thing to teach
   * than a checkbox.
   */
  function debugToggle() {
    const wrap = document.createElement('label')
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;opacity:.7;cursor:pointer'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = debugOn()
    box.addEventListener('change', () => {
      GM_setValue(DEBUG_KEY, box.checked ? 'true' : 'false')
      log('debug logging on — reload to trace startup')
    })
    const text = document.createElement('span')
    text.textContent = 'Debug log (console)'
    wrap.appendChild(box)
    wrap.appendChild(text)
    return wrap
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
      dot.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
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
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
      'background:#111827', 'color:#e5e7eb', 'border:1px solid #374151',
      'border-radius:10px', 'padding:10px 12px', 'font:12px/1.4 system-ui,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)', 'max-width:260px',
    ].join(';')

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
      hide.addEventListener('click', () => { rt.expanded = false; panel() })

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
      box.appendChild(debugToggle())
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

  return {
    setSession, currentSession, api, refreshToken,
    parseXid, resolveTenant, indexDibs, enemyIds, frameRows, buttonState, backoffFor,
    identityMatches, panelNeedsKey, panelExpanded, statusText, statusColor,
    opponentFrom, pollDelay, redactUrl, debugOn, establishSession, store, main,
    TENANTS_URL, STORE_KEY, BADGE_CLASS,
  }
})()

// Bootstrap only in a real browser. Guarded so the unit tests can evaluate this
// file and pull the pure helpers out with no DOM work running.
if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
