// ==UserScript==
// @name         TNL War Room — Dibs
// @namespace    https://monchoon.me/
// @version      1.0.1
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
 * answers. Writes therefore go through GM.xmlHttpRequest, which is privileged
 * and exempt from CORS; reads come over the WebSocket, which is also exempt and
 * authenticates on its token alone. Between them no server-side CORS change is
 * needed. Do not "fix" this by allow-listing torn.com on the API.
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
   * Member ids that are NOT ours.
   *
   * ⚠️ The war page lists both factions and dibs are enemy-only — a claim
   * button beside a teammate is nonsense and a support ticket. The socket's
   * `state` rows carry faction_id, so this comes from data rather than from
   * guessing which part of the DOM a row sits in.
   */
  function enemyIds(stateRows, ourFactionId) {
    const out = new Set()
    for (const row of stateRows ?? []) {
      if (String(row.faction_id) !== String(ourFactionId)) out.add(Number(row.member_id))
    }
    return out
  }

  /** What the control should say for a target, given who holds it. */
  function buttonState(dib, currentUserId) {
    if (!dib) return { label: '+ Dibs', action: 'claim', mine: false }
    if (String(dib.by) === String(currentUserId)) {
      return { label: '✓ Your dib', action: 'release', mine: true }
    }
    return { label: `🖐 ${dib.name ?? 'Claimed'}`, action: 'none', mine: false }
  }

  /** Backoff for the nth consecutive reconnect attempt (0-based). */
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
      xhr({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.body,
        onload: (res) => {
          let parsed = null
          try { parsed = JSON.parse(res.responseText) } catch { /* not json */ }
          resolve({ status: res.status, body: parsed })
        },
        onerror: () => reject(new Error(`request failed: ${opts.url}`)),
        ontimeout: () => reject(new Error(`request timed out: ${opts.url}`)),
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
    ws: null,
    attempt: 0,
    status: 'idle',
  }

  /** The logged-in Torn user, read from the page's own sidebar profile link. */
  function pageUserId() {
    const link = document.querySelector('#sidebarroot a[href*="profiles.php?XID="], .sidebar a[href*="profiles.php?XID="]')
    return link ? parseXid(link.getAttribute('href')) : null
  }

  function api(path, method, body) {
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

  function connect() {
    if (!rt.session) return
    const url = `wss://${rt.session.host}/api/war-room/ws?token=${encodeURIComponent(rt.session.token)}`
    const ws = new WebSocket(url)
    rt.ws = ws

    ws.addEventListener('open', () => { rt.attempt = 0; setStatus('live') })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'snapshot') {
        rt.dibs = indexDibs(msg.dibs)
        rt.enemies = enemyIds(msg.state, rt.ourFactionId)
      } else if (msg.type === 'delta') {
        if (msg.channel === 'dibs') indexDibs(msg.rows, rt.dibs)
        if (msg.channel === 'state') {
          for (const id of enemyIds(msg.rows, rt.ourFactionId)) rt.enemies.add(id)
        }
      } else return
      render()
    })
    // 4401 is the server refusing the token — reconnecting cannot fix that.
    ws.addEventListener('close', (ev) => {
      if (ev.code === 4401) { setStatus('auth'); return }
      setStatus('reconnecting')
      const wait = backoffFor(rt.attempt++)
      setTimeout(connect, wait)
    })
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
    for (const [playerId, anchors] of rt.nodes) {
      if (!rt.enemies.has(playerId)) continue
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
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return
    for (const anchor of root.querySelectorAll('a[href*="profiles.php?XID="]')) {
      const id = parseXid(anchor.getAttribute('href'))
      if (id === null) continue
      if (!rt.nodes.has(id)) rt.nodes.set(id, new Set())
      rt.nodes.get(id).add(anchor)
    }
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

  function setStatus(state) {
    rt.status = state
    if (!panelStatus) return
    const text = {
      live: '● live', reconnecting: '○ reconnecting…', auth: '⚠ session expired',
      idle: '○ not connected', error: '⚠ error',
    }[state] || state
    panelStatus.textContent = text
  }

  function panel() {
    // Rebuildable: the panel changes shape when a session appears or goes away,
    // and the first release never re-rendered it — so after a successful
    // connect the key field stayed on screen next to the word "Connected".
    if (panelBox && panelBox.isConnected) panelBox.remove()

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
          // like it had not saved anything.
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
      const out = document.createElement('button')
      out.textContent = 'Sign out'
      out.style.cssText = 'width:100%;padding:5px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer'
      out.addEventListener('click', () => {
        store.clear()
        rt.session = null
        if (rt.ws) { try { rt.ws.close() } catch { /* already gone */ } }
        location.reload()
      })
      const who = document.createElement('div')
      who.style.cssText = 'opacity:.7;margin-bottom:6px'
      who.textContent = `Signed in as ${rt.session.userId} · ${rt.session.host}`
      box.insertBefore(who, box.lastChild)
      box.appendChild(out)
    }

    document.body.appendChild(box)
  }

  async function boot() {
    rt.session = rt.session || store.read()
    if (!rt.session) return

    const mine = pageUserId()
    if (!identityMatches(rt.session.userId, mine)) {
      setStatus('error')
      // eslint-disable-next-line no-console
      console.warn(`[TNL Dibs] token belongs to ${rt.session.userId}, page is ${mine} — refusing to act.`)
      rt.session = null
      return
    }

    // Named `bootstrapRes`, not `boot`: a `const boot` here shadows this very
    // function inside its own body, which is legal, confusing, and breaks the
    // moment anyone adds a retry.
    const bootstrapRes = await gmRequest({ url: `https://${rt.session.host}/api/bootstrap` })
    rt.ourFactionId = bootstrapRes.body?.faction?.torn_faction_id ?? rt.session.factionId
    connect()
    observe()
  }

  function main() {
    // ⚠️ Read the stored session BEFORE building the panel. The first release
    // called panel() first, so rt.session was always null at render time and
    // the panel asked for a key on every single load — a saved session looked
    // like it had never saved.
    rt.session = store.read()
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

  return {
    parseXid, resolveTenant, indexDibs, enemyIds, buttonState, backoffFor,
    identityMatches, panelNeedsKey, establishSession, store, main,
    TENANTS_URL, STORE_KEY, BADGE_CLASS,
  }
})()

// Bootstrap only in a real browser. Guarded so the unit tests can evaluate this
// file and pull the pure helpers out with no DOM work running.
if (typeof window !== 'undefined' && typeof document !== 'undefined') TNLDibs.main()

// Test seam — Tampermonkey has no `module`, so this is inert in the browser.
if (typeof module !== 'undefined' && module.exports) module.exports = TNLDibs
