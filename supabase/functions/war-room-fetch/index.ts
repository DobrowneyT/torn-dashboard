// DEPLOYMENT NOTE: Deploy with --no-verify-jwt flag
// Deploy command: npx supabase functions deploy war-room-fetch --no-verify-jwt
// Uses custom Torn API key authentication instead of Supabase JWT

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-torn-api-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const LEADERSHIP_IDS = ['2250591', '2749598', '2264192', '2407528', '2932241', '2015160']
// Subset of leadership with the power to release someone else's dibs.
// Mirrors `adminsUserIds` in src/config.js — keep them in sync.
const ADMIN_IDS = ['2250591']
const OUR_FACTION_ID = '10739'

// ── Torn API key rotation ─────────────────────────────────────────────────────
// Set TORN_API_KEYS as a Supabase secret: a comma-separated list of one or more keys.
// With N keys, each successive call uses the next key in the list (round-robin),
// bypassing Torn's per-key 30s response cache and allowing sub-second fresh data.
// Single-key fallback: if only one key is provided it always uses that key — same
// behaviour as the old TORN_API_KEY secret (kept below for easy rollback).
//
// To revert to a single key, comment out the TORN_API_KEYS block and uncomment:
//   function nextTornKey() { return Deno.env.get('TORN_API_KEY') ?? '' }

const _tornKeys: string[] = (Deno.env.get('TORN_API_KEYS') ?? '').split(',').map((k: string) => k.trim()).filter(Boolean)

// Key selection uses the current Unix second so it's deterministic across all
// Deno Deploy worker instances (no shared mutable state). The selected key
// advances every second, cycling through all N keys every N seconds.
// At 3s polling with 13 keys: each key is used roughly once per 13-second cycle.
// At 0.5s polling with 13 keys: the key changes twice per second — you need
// ≥2 keys to stay under the 100 req/min per-key rate limit.
//
// To revert to a single fixed key, comment out this block and uncomment:
//   function nextTornKey() { return Deno.env.get('TORN_API_KEY') ?? '' }
function nextTornKey(): string {
  if (_tornKeys.length === 0) return ''
  return _tornKeys[Math.floor(Date.now() / 1000) % _tornKeys.length]
}

// ── Auth cache (two-layer) ────────────────────────────────────────────────────
// L1: in-memory Map — zero-latency within a warm instance
// L2: Supabase war_room_auth_cache table — survives cold starts and is shared
//     across all Deno Deploy worker instances (fixes the per-request re-auth)
// TTL: 24 hours. Raw API keys are never stored — only a SHA-256 hex digest.

const AUTH_TTL_MS = 24 * 60 * 60 * 1000
const authMemCache = new Map<string, { userId: string; expiresAt: number }>()

// Module-level admin client used only for auth cache reads/writes
const supabaseAuth = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

interface AuthResult {
  success: boolean
  userId?: string
  error?: string
}

async function verifyTornUser(apiKey: string): Promise<AuthResult> {
  // L1: in-memory
  const mem = authMemCache.get(apiKey)
  if (mem && mem.expiresAt > Date.now()) return { success: true, userId: mem.userId }

  // L2: DB cache — one fast DB read instead of a Torn API call on cold starts
  const keyHash = await sha256hex(apiKey)
  const { data: dbCached } = await supabaseAuth
    .from('war_room_auth_cache')
    .select('user_id, expires_at')
    .eq('key_hash', keyHash)
    .maybeSingle()

  if (dbCached && new Date(dbCached.expires_at) > new Date()) {
    authMemCache.set(apiKey, { userId: dbCached.user_id, expiresAt: new Date(dbCached.expires_at).getTime() })
    return { success: true, userId: dbCached.user_id }
  }

  // Cache miss — verify with Torn API (happens at most once per 24h per key)
  try {
    const resp = await fetch(`https://api.torn.com/v2/key/info?key=${apiKey}`)
    if (!resp.ok) return { success: false, error: 'Failed to verify API key' }
    const data = await resp.json()
    if (data.error) return { success: false, error: `Torn API error: ${data.error.error}` }

    const userId = String(data.info.user.id)
    // Torn /v2/key/info returns faction_id as a flat property on user — not
    // nested under `user.faction`. The old nested lookup always yielded ''
    // which broke for any non-leadership member (leadership were rescued by
    // the LEADERSHIP_IDS bypass below).
    const factionId = String(data.info.user.faction_id ?? '')

    if (factionId !== OUR_FACTION_ID && !LEADERSHIP_IDS.includes(userId)) {
      return { success: false, error: 'Not a faction member' }
    }

    const expiresAt = new Date(Date.now() + AUTH_TTL_MS).toISOString()
    authMemCache.set(apiKey, { userId, expiresAt: Date.now() + AUTH_TTL_MS })
    // Fire-and-forget — don't block the response on the DB write
    supabaseAuth.from('war_room_auth_cache').upsert({ key_hash: keyHash, user_id: userId, expires_at: expiresAt })

    return { success: true, userId }
  } catch (e) {
    return { success: false, error: `Auth error: ${e}` }
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Action handlers ───────────────────────────────────────────────────────────

// Build the volatile `state` jsonb for a member from a Torn API member payload.
function buildMemberState(m: any) {
  return {
    status: {
      state:       m.status?.state       ?? null,
      description: m.status?.description ?? null,
      until:       m.status?.until       ?? null,
    },
    last_action: {
      status:    m.last_action?.status    ?? null,
      timestamp: m.last_action?.timestamp ?? null,
    },
    is_revivable:        m.is_revivable        ?? false,
    has_early_discharge: m.has_early_discharge ?? false,
    is_in_oc:            m.is_in_oc            ?? false,
    is_on_wall:          m.is_on_wall          ?? false,
    revive_setting:      m.revive_setting      ?? null,
    updated_at:          new Date().toISOString(),
  }
}

// Deep-equal two member state objects ignoring updated_at (which always differs).
// JSON.stringify isn't safe here: Postgres jsonb does NOT preserve key order, so
// a value round-tripped through the DB stringifies differently than the freshly
// built one even when semantically identical. Compare leaf fields explicitly.
function stateEqual(a: any, b: any): boolean {
  if (!a || !b) return false
  return a.status?.state         === b.status?.state
      && a.status?.description   === b.status?.description
      && a.status?.until         === b.status?.until
      && a.last_action?.status   === b.last_action?.status
      && a.last_action?.timestamp === b.last_action?.timestamp
      && a.is_revivable          === b.is_revivable
      && a.has_early_discharge   === b.has_early_discharge
      && a.is_in_oc              === b.is_in_oc
      && a.is_on_wall            === b.is_on_wall
      && a.revive_setting        === b.revive_setting
}

async function handleFetchMembers(supabase: ReturnType<typeof createClient>, factionId: number) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  const url = `https://api.torn.com/v2/faction/${factionId}/members?striptags=true&comment=WarRoom&timestamp=${Math.floor(Date.now() / 1000)}&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const now = Math.floor(Date.now() / 1000)

  // Lazily backfill the faction's display name. Only hits Torn /basic when
  // the faction isn't already cached — first save after a Clear State, or a
  // war against a faction we've never seen. Returned in the response so the
  // client can update the header without waiting on a useEffect re-run.
  let factionName: string | null = null
  const { data: cached } = await supabase
    .from('factions').select('name').eq('id', factionId).maybeSingle()
  if (cached?.name) {
    factionName = cached.name as string
  } else {
    try {
      const basicResp = await fetch(`https://api.torn.com/v2/faction/${factionId}/basic?key=${tornKey}`)
      if (basicResp.ok) {
        const basicData = await basicResp.json()
        const basic = basicData?.basic ?? {}
        if (basic.name) {
          factionName = basic.name as string
          await supabase.from('factions').upsert({
            id: factionId,
            name: basic.name,
            tag: basic.tag ?? null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' })
        }
      }
    } catch (e) {
      console.error('faction basic lookup failed:', e)
    }
  }

  // Load current state for this faction so we can skip rows whose volatile
  // state hasn't actually changed. Every skipped row is a Realtime UPDATE event
  // we don't emit — the whole point of this fix.
  const { data: current } = await supabase
    .from('war_room_state')
    .select('member_id, state')
    .eq('faction_id', factionId)
  const currentMap = new Map<number, any>((current ?? []).map((r: any) => [r.member_id, r.state]))

  const changed = members
    .map((m: any) => ({
      member_id:   m.id,
      member_name: m.name,
      faction_id:  factionId,
      level:       m.level,
      position:    m.position ?? null,
      state:       buildMemberState(m),
    }))
    .filter(row => !stateEqual(currentMap.get(row.member_id), row.state))

  if (changed.length > 0) {
    const { error } = await supabase
      .from('war_room_state')
      .upsert(changed, { onConflict: 'member_id' })
    if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)
  }

  return json({ ok: true, count: changed.length, total: members.length, fetched_at: now, faction_name: factionName })
}

async function handleFetchOurMembers(supabase: ReturnType<typeof createClient>) {
  const tornKey = nextTornKey()
  if (!tornKey) return json({ error: 'TORN_API_KEYS secret not set' }, 500)

  // Must specify OUR_FACTION_ID explicitly — without it, /v2/faction/members
  // returns whichever faction the rotating API key owner belongs to. If
  // TORN_API_KEYS includes a key from outside our faction, we'd silently
  // upsert that other faction's roster with faction_id = OUR_FACTION_ID,
  // polluting the table with members who were never in our faction.
  const url = `https://api.torn.com/v2/faction/${OUR_FACTION_ID}/members?striptags=true&comment=WarRoom&key=${tornKey}`
  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `Torn API HTTP ${resp.status}` }, 502)

  const data = await resp.json()
  if (data.error) return json({ error: `Torn API error ${data.error.code}: ${data.error.error}` }, 502)

  const members = data.members as Record<string, unknown>[]
  const ourFactionId = Number(OUR_FACTION_ID)

  // Same diff-based upsert as the enemy fetch — only push rows whose volatile
  // state changed since the last poll.
  const { data: current } = await supabase
    .from('war_room_state')
    .select('member_id, state')
    .eq('faction_id', ourFactionId)
  const currentMap = new Map<number, any>((current ?? []).map((r: any) => [r.member_id, r.state]))

  const candidates = members.map((m: any) => ({
    member_id:   m.id,
    member_name: m.name,
    faction_id:  ourFactionId,
    level:       m.level,
    position:    m.position ?? null,
    state:       buildMemberState(m),
  }))
  const changed = candidates.filter(row => !stateEqual(currentMap.get(row.member_id), row.state))

  if (changed.length > 0) {
    const { error } = await supabase
      .from('war_room_state')
      .upsert(changed, { onConflict: 'member_id' })
    if (error) return json({ error: `DB upsert error: ${error.message}` }, 500)
  }

  // Prune ex-members: anyone with faction_id = OUR_FACTION_ID who is no
  // longer in the current roster (left the faction at some point). Enemy
  // side doesn't need this because the Save flow already wipes on faction
  // switch, but our roster has no such reset — without this prune, the
  // "Us" counts in the header drift upward forever.
  const currentIds = new Set(candidates.map(c => c.member_id))
  const stale = (current ?? [])
    .map((r: any) => r.member_id)
    .filter((id: number) => !currentIds.has(id))
  let pruned = 0
  if (stale.length > 0) {
    const { error: delError, count } = await supabase
      .from('war_room_state')
      .delete({ count: 'exact' })
      .eq('faction_id', ourFactionId)
      .in('member_id', stale)
    if (delError) return json({ error: `DB prune error: ${delError.message}` }, 500)
    pruned = count ?? stale.length
  }

  return json({ ok: true, count: changed.length, pruned, total: members.length })
}

async function handleGetConfig(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from('war_room_config')
    .select('*')
    .eq('id', 1)
    .single()

  if (error) return json({ error: error.message }, 500)
  return json({ config: data })
}

async function handleSetConfig(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  const update: Record<string, unknown> = {}
  if ('enabled' in body) update.enabled = body.enabled
  if ('faction_id' in body) update.faction_id = body.faction_id
  if ('faction_name' in body) update.faction_name = body.faction_name
  if ('revive_service_name' in body) update.revive_service_name = body.revive_service_name
  if ('revive_service_url'  in body) update.revive_service_url  = body.revive_service_url
  if ('revive_services'     in body) update.revive_services     = body.revive_services

  if (body.enabled === true) {
    update.started_by = Number(userId)
    update.started_at = new Date().toISOString()
  }

  const { error } = await supabase
    .from('war_room_config')
    .update(update)
    .eq('id', 1)

  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

// Fetch the full faction-spy payload from TornStats.
// API shape (from the userscript reference):
//   GET https://www.tornstats.com/api/v2/{key}/spy/faction/{factionId}
//   → { status, message?, faction: { members: { [id]: { id, spy: {
//        timestamp, strength, speed, defense, dexterity, total } } } } }
// `status: false` plus a `message` field is how TornStats signals errors
// (invalid key, faction not found, rate-limited).
async function fetchTornStatsFactionSpies(apiKey: string, factionId: number) {
  try {
    const resp = await fetch(`https://www.tornstats.com/api/v2/${apiKey}/spy/faction/${factionId}`)
    if (!resp.ok) {
      console.warn('[tornstats] HTTP', resp.status)
      return null
    }
    const data = await resp.json()
    if (data?.status === false) {
      console.warn('[tornstats] error:', data?.message)
      return null
    }
    return data
  } catch (e) {
    console.warn('[tornstats] fetch failed:', e)
    return null
  }
}

// Two-pass spy update: TornStats first (real spies w/ breakdown + capture
// timestamp), then BSP fills in the gaps. The action keeps its legacy
// 'fetch_bsp' name + `fetchBspStats(...)` client helper for backwards
// compatibility — internally it's now an "update spies" operation.
//
// Skip conditions for the TornStats pass (any one → falls through to BSP-only):
//   - TORNSTATS_API_KEY env not set
//   - tornstats_max_age_days config is 0 (explicit disable)
//   - Couldn't resolve the enemy faction id from war_room_state
//   - TornStats API returned an error (network / bad key / rate limited)
async function handleFetchBsp(supabase: ReturnType<typeof createClient>, memberIds: number[]) {
  const bspKey = Deno.env.get('BSP_API_KEY')
  const tsKey = Deno.env.get('TORNSTATS_API_KEY')
  if (!bspKey) return json({ error: 'BSP_API_KEY secret not set' }, 500)
  if (!tsKey) return json({ error: 'TORNSTATS_API_KEY secret not set' }, 500)
  if (!memberIds?.length) return json({ error: 'member_ids required' }, 400)

  const now = new Date().toISOString()
  let tornstatsFilled = 0
  let needBsp: number[] = memberIds.slice()

  // ── Pass 1: TornStats ──────────────────────────────────────────────────

  // Look up the enemy faction id from any row in war_room_state matching
  // the requested member ids and NOT belonging to our faction. Filter on
  // OUR_FACTION_ID guards against accidentally querying our own stats.
  const { data: enemySample } = await supabase
    .from('war_room_state')
    .select('faction_id')
    .in('member_id', memberIds)
    .neq('faction_id', Number(OUR_FACTION_ID))
    .limit(1)
    .maybeSingle()
  const enemyFactionId: number | null = enemySample?.faction_id ?? null

  if (tsKey && enemyFactionId) {
    const { data: cfg } = await supabase
      .from('war_room_config')
      .select('tornstats_max_age_days')
      .eq('id', 1)
      .maybeSingle()
    const maxAgeDays: number = cfg?.tornstats_max_age_days ?? 0

    // Always run the TornStats pass when an API key is configured. The age
    // setting is just an upper bound on how old a spy is allowed to be:
    //   N > 0  → reject spies older than N days (fall through to BSP)
    //   N === 0 → no age filter, accept any TornStats spy we get
    // Disabling TornStats entirely is done by unsetting TORNSTATS_API_KEY.
    const spies = await fetchTornStatsFactionSpies(tsKey, enemyFactionId)
    const memberIdSet = new Set(memberIds.map(Number))
    const minTimestamp = maxAgeDays > 0
      ? Math.floor((Date.now() - maxAgeDays * 86_400_000) / 1000)
      : 0  // 0 disables the age cutoff — anything positive passes

    if (spies?.faction?.members && typeof spies.faction.members === 'object') {
      const filledIds: number[] = []
      for (const key of Object.keys(spies.faction.members)) {
        const entry = spies.faction.members[key]
        const id = Number(entry?.id ?? key)
        if (!memberIdSet.has(id)) continue
        const spy = entry?.spy
        if (!spy || typeof spy.total !== 'number' || spy.total <= 0) continue
        if (typeof spy.timestamp !== 'number' || spy.timestamp < minTimestamp) continue

        const { error: upErr } = await supabase.from('war_room_state').update({
          bsp_total:      spy.total,
          bsp_str:        spy.strength ?? null,
          bsp_spd:        spy.speed ?? null,
          bsp_def:        spy.defense ?? null,
          bsp_dex:        spy.dexterity ?? null,
          bsp_fetched_at: now,
          spy_source:     'tornstats',
          ts_spy_at:      new Date(spy.timestamp * 1000).toISOString(),
        }).eq('member_id', id)
        if (!upErr) filledIds.push(id)
      }
      tornstatsFilled = filledIds.length
      const filledSet = new Set(filledIds)
      needBsp = memberIds.filter(id => !filledSet.has(id))
      console.log(`[update_spies] TornStats: ${tornstatsFilled} filled (maxAgeDays=${maxAgeDays}), ${needBsp.length} remain for BSP`)
    }
  }

  // ── Pass 2: BSP for anyone TornStats didn't fill ───────────────────────
  const BSP_DELAY_MS = 30
  const results: Record<number, { total: number | null; str: number | null; spd: number | null; def: number | null; dex: number | null }> = {}

  for (let i = 0; i < needBsp.length; i++) {
    const id = needBsp[i]
    try {
      const resp = await fetch(`http://www.lol-manager.com/api/battlestats/${bspKey}/${id}/TornForge`)
      const data = await resp.json()
      if (data && (data.Result === 1 || data.Result === 6) && data.TBS) {
        results[id] = {
          total: data.TBS ?? null,
          str:   data.Strength ?? null,
          spd:   data.Speed ?? null,
          def:   data.Defense ?? null,
          dex:   data.Dexterity ?? null,
        }
      } else {
        results[id] = { total: null, str: null, spd: null, def: null, dex: null }
      }
    } catch {
      results[id] = { total: null, str: null, spd: null, def: null, dex: null }
    }

    if (i < needBsp.length - 1) {
      await new Promise(r => setTimeout(r, BSP_DELAY_MS))
    }
  }

  let bspFilled = 0
  for (const [idStr, stats] of Object.entries(results)) {
    const id = Number(idStr)
    if (stats.total === null) continue
    await supabase.from('war_room_state').update({
      bsp_total:      stats.total,
      bsp_str:        stats.str,
      bsp_spd:        stats.spd,
      bsp_def:        stats.def,
      bsp_dex:        stats.dex,
      bsp_fetched_at: now,
      spy_source:     'bsp',
      ts_spy_at:      null,    // BSP is a prediction, not a real spy
    }).eq('member_id', id)
    bspFilled++
  }

  return json({
    ok: true,
    fetched: tornstatsFilled + bspFilled,
    tornstats: tornstatsFilled,
    bsp: bspFilled,
    requested: memberIds.length,
  })
}

async function handleClearState(
  supabase: ReturnType<typeof createClient>,
  userId: string
) {
  if (!LEADERSHIP_IDS.includes(userId)) {
    return json({ error: 'Leadership only' }, 403)
  }

  // Clear dibs too — they're tied to the current war's targets and are
  // meaningless once members are wiped.
  await supabase.from('war_room_dibs').delete().neq('id', 0)

  const { error } = await supabase.from('war_room_state').delete().neq('member_id', 0)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleClaimDibs(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string,
  userName: string
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  // Is the target already claimed by someone else?
  const { data: existing } = await supabase
    .from('war_room_dibs')
    .select('id, claimed_by, claimed_name')
    .eq('target_id', targetId)
    .maybeSingle()

  if (existing && String(existing.claimed_by) !== userId) {
    return json({
      error: `Already claimed by ${existing.claimed_name}`,
      owner: { id: existing.claimed_by, name: existing.claimed_name },
    }, 409)
  }

  // Single-dibs enforcement: hard-delete any other claims this user holds
  // (including the same target if re-claiming). The table is reusable —
  // released rows leave no trace.
  await supabase.from('war_room_dibs')
    .delete()
    .eq('claimed_by', Number(userId))

  const { error } = await supabase.from('war_room_dibs').insert({
    target_id: targetId,
    claimed_by: Number(userId),
    claimed_name: userName,
    war_id: body.war_id ?? null,
  })

  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function handleReleaseDibs(
  supabase: ReturnType<typeof createClient>,
  body: any,
  userId: string
) {
  const targetId = body.target_id
  if (!targetId) return json({ error: 'target_id required' }, 400)
  if (!userId || userId === 'anon') return json({ error: 'user_id required' }, 400)

  const query = supabase
    .from('war_room_dibs')
    .delete()
    .eq('target_id', targetId)

  // Only admins can release anyone's dibs. Everyone else (including non-admin
  // leadership) can only release their own.
  if (!ADMIN_IDS.includes(String(userId))) {
    query.eq('claimed_by', Number(userId))
  }

  const { error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

// Hospital status descriptions Torn emits use nationality adjectives. Map
// each adjective to the title-cased country name Nuke's API expects. Anything
// not in this table (including the bare "In hospital" form) is treated as
// Torn — the standard hospital has no nationality prefix.
const HOSPITAL_COUNTRY_ADJECTIVES: Array<[RegExp, string]> = [
  [/\bMexican\b/i,       'Mexico'],
  [/\bCaymanian\b/i,     'Cayman Islands'],
  [/\bCanadian\b/i,      'Canada'],
  [/\bHawaiian\b/i,      'Hawaii'],
  [/\bBritish\b/i,       'United Kingdom'],
  [/\bArgentinian\b/i,   'Argentina'],
  [/\bSwiss\b/i,         'Switzerland'],
  [/\bJapanese\b/i,      'Japan'],
  [/\bChinese\b/i,       'China'],
  [/\bEmirati\b/i,       'UAE'],
  [/\bSouth African\b/i, 'South Africa'],
]

/**
 * Resolve the requester's current country from their war_room_state row.
 * Returns a Nuke-API-compatible title-cased country name, defaulting to
 * "Torn" when the description doesn't match any nationality (which covers
 * both the standard hospital and the "user not in our war_room_state" case).
 */
async function resolveUserCountry(
  supabase: ReturnType<typeof createClient>,
  userID: number | string,
): Promise<string> {
  const { data } = await supabase
    .from('war_room_state')
    .select('state')
    .eq('member_id', Number(userID))
    .maybeSingle()
  const description: string = data?.state?.status?.description ?? ''
  for (const [pattern, country] of HOSPITAL_COUNTRY_ADJECTIVES) {
    if (pattern.test(description)) return country
  }
  return 'Torn'
}

// Server-side proxy for revive-service POST requests. Browser cross-origin
// POSTs to services like tornuhc.eu would be blocked by CORS, so we forward
// the call from the Edge Function (server-to-server, no CORS) and return the
// response. The Tampermonkey script equivalent uses GM.xmlHttpRequest for the
// same reason.
//
// Three payload shapes are supported via the `preset` field:
//   - 'json' (default): UHC/WTF style — JSON body with a custom source key
//   - 'nuke': form-encoded body with Nuke's torn_player_id / _name / _country
//     / app_info fields, country resolved server-side from war_room_state
async function handleReviveRequest(
  supabase: ReturnType<typeof createClient>,
  body: any,
) {
  const url: string = body.url
  if (!url || typeof url !== 'string') return json({ error: 'url required' }, 400)
  if (!body.userID) return json({ error: 'userID required' }, 400)

  const preset: string = (body.preset ?? 'json').toString().toLowerCase()

  if (preset === 'nuke') {
    return await sendNukeRequest(supabase, url, body)
  }
  return await sendJsonRequest(url, body)
}

async function sendJsonRequest(url: string, body: any) {
  // Different revive services use different JSON keys for the same value:
  //   UHC → "source"
  //   WTF → "requestChannel"
  // The user picks the right key per-service in the Manage Services modal.
  const sourceKey   = (typeof body.sourceKey === 'string' && body.sourceKey.trim()) || 'source'
  const sourceValue = body.source ?? ''

  const payload: Record<string, unknown> = {
    userID:      body.userID,
    userName:    body.userName    ?? '',
    factionName: body.factionName ?? '',
    [sourceKey]: sourceValue,
  }

  console.log('[revive_request:json] →', { url, payload })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await resp.text()
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch { parsedBody = { raw: text } }
    console.log('[revive_request:json] ←', { status: resp.status, body: parsedBody })
    return json({ ok: resp.ok, status: resp.status, body: parsedBody, sentPayload: payload, url })
  } catch (e) {
    console.error('[revive_request:json] error', e)
    return json({ error: `Revive request failed: ${e}` }, 502)
  }
}

async function sendNukeRequest(
  supabase: ReturnType<typeof createClient>,
  url: string,
  body: any,
) {
  const country = await resolveUserCountry(supabase, body.userID)

  // Mirror the userscript exactly: `torn_player_name` is "Name [id]", and the
  // app_info string carries the version of our app for their logs.
  const playerName = body.userName ? `${body.userName} [${body.userID}]` : String(body.userID)
  const formFields: Record<string, string> = {
    torn_player_id:      String(body.userID),
    torn_player_name:    playerName,
    torn_player_country: country,
    app_info:            body.source || 'TNL War Room',
  }
  const formBody = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  console.log('[revive_request:nuke] →', { url, formFields })

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    })
    const text = await resp.text()
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch { parsedBody = { raw: text } }
    console.log('[revive_request:nuke] ←', { status: resp.status, body: parsedBody })
    return json({ ok: resp.ok, status: resp.status, body: parsedBody, sentPayload: formFields, url })
  } catch (e) {
    console.error('[revive_request:nuke] error', e)
    return json({ error: `Revive request failed: ${e}` }, 502)
  }
}

async function handleGetDibs(
  supabase: ReturnType<typeof createClient>,
  body: any
) {
  let query = supabase
    .from('war_room_dibs')
    .select('id, target_id, claimed_by, claimed_name, claimed_at, war_id')

  if (body.war_id) query = query.eq('war_id', body.war_id)

  const { data, error } = await query
  if (error) return json({ error: error.message }, 500)
  return json({ dibs: data })
}

// ── JWT minting (realtime + session auth) ────────────────────────────────────
// Mints JWTs signed with the project's SUPABASE_JWT_SECRET so the frontend
// can prove identity to PostgREST (REST queries) AND Supabase Realtime
// (private broadcasts). Both consumers verify the signature against the
// same secret, so a single token shape works for either path.
//
// Caller must already be verified via verifyTornUser() (these actions are NOT
// in POLL_ACTIONS, so the standard auth flow runs before we get here).
//
// Claims:
//   role          = 'authenticated' (so RLS policies `TO authenticated` apply)
//   sub           = `torn-{userId}` (stable per Torn account)
//   torn_user_id  = Torn account id
//   faction_id    = our faction id
//   is_leadership = mirrors LEADERSHIP_IDS list
//   is_admin      = mirrors ADMIN_IDS list
//
// Two endpoints exist because they have different lifetimes:
//   - mint_realtime_token: 24h. Long-lived to match websocket persistence.
//     Used by WarRoomView's existing realtime.setAuth() loop today.
//   - mint_session_token: 4h. Shorter so a stolen/stale token loses value
//     faster, and faction membership re-checks happen ~every 4h. Used by
//     the supabase-js client's accessToken async hook for REST queries.
// They can be unified later once the frontend fully consumes the shared
// sessionToken module for realtime auth too.

const JWT_TTL_REALTIME_SECONDS = 24 * 60 * 60   // 24h
const JWT_TTL_SESSION_SECONDS  =  4 * 60 * 60   //  4h

async function mintAuthToken(userId: string, ttlSeconds: number) {
  // Set this once via `npx supabase secrets set JWT_SECRET=<value>`.
  // The value comes from Supabase Dashboard → Project Settings → API → JWT Secret.
  // Can't be named SUPABASE_JWT_SECRET — Supabase reserves the SUPABASE_ prefix.
  const jwtSecret = Deno.env.get('jwt_secret')
  if (!jwtSecret) return { error: 'JWT_SECRET secret not set', status: 500 }
  if (!userId || userId === 'anon') return { error: 'user_id required', status: 400 }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

  const expiresAt = getNumericDate(ttlSeconds)
  const token = await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      aud:           'authenticated',
      role:          'authenticated',
      sub:           `torn-${userId}`,
      torn_user_id:  userId,
      faction_id:    OUR_FACTION_ID,
      is_leadership: LEADERSHIP_IDS.includes(userId),
      is_admin:      ADMIN_IDS.includes(userId),
      iat: getNumericDate(0),
      exp: expiresAt,
    },
    key,
  )

  return { token, expiresAt }
}

async function handleMintRealtimeToken(userId: string) {
  const result = await mintAuthToken(userId, JWT_TTL_REALTIME_SECONDS)
  if ('error' in result) return json({ error: result.error }, result.status)
  return json({ token: result.token, expires_at: result.expiresAt })
}

async function handleMintSessionToken(userId: string) {
  const result = await mintAuthToken(userId, JWT_TTL_SESSION_SECONDS)
  if ('error' in result) return json({ error: result.error }, result.status)
  return json({ token: result.token, expires_at: result.expiresAt })
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const tornApiKey = req.headers.get('x-torn-api-key')
    if (!tornApiKey) return json({ error: 'Missing x-torn-api-key header' }, 401)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const body = await req.json()
    const action: string = body.action

    // Polling actions are high-frequency and use server-side TORN_API_KEYS — the
    // user's key is irrelevant to what data gets fetched, so skip the Torn auth
    // verification on these hot paths entirely.
    // Dibs are also unverified — they're already serialised by the DB unique
    // constraint, and the user_id is sent in the body. Trade-off documented.
    const POLL_ACTIONS = new Set(['fetch_members', 'fetch_our_members', 'get_config', 'get_dibs', 'claim_dibs', 'release_dibs', 'revive_request'])

    let userId = 'anon'
    if (!POLL_ACTIONS.has(action)) {
      const auth = await verifyTornUser(tornApiKey)
      if (!auth.success) return json({ error: auth.error }, 403)
      userId = auth.userId!
    }

    // Resolve display name for dibs (passed by client to avoid extra API call)
    const userName: string = body.user_name ?? 'Unknown'

    switch (action) {
      case 'fetch_members':
        return await handleFetchMembers(supabase, body.faction_id)
      case 'fetch_our_members':
        return await handleFetchOurMembers(supabase)
      case 'fetch_bsp':
        return await handleFetchBsp(supabase, body.member_ids)
      case 'get_config':
        return await handleGetConfig(supabase)
      case 'set_config':
        return await handleSetConfig(supabase, body, userId)
      case 'clear_state':
        return await handleClearState(supabase, userId)
      case 'claim_dibs':
        // user_id comes from the body since claim_dibs skips auth (POLL_ACTIONS)
        return await handleClaimDibs(supabase, body, String(body.user_id ?? ''), userName)
      case 'release_dibs':
        return await handleReleaseDibs(supabase, body, String(body.user_id ?? ''))
      case 'get_dibs':
        return await handleGetDibs(supabase, body)
      case 'revive_request':
        return await handleReviveRequest(supabase, body)
      case 'mint_realtime_token':
        // userId is set by verifyTornUser() above — this action is NOT in
        // POLL_ACTIONS so the standard Torn-key auth flow runs first.
        return await handleMintRealtimeToken(userId)
      case 'mint_session_token':
        // Same auth + claim shape as mint_realtime_token, shorter TTL.
        // Consumed by the frontend's supabase-js accessToken hook so every
        // REST call carries the JWT (role=authenticated + custom claims).
        return await handleMintSessionToken(userId)
      default:
        return json({ error: `Unknown action: ${action}` }, 400)
    }
  } catch (e) {
    console.error('war-room-fetch error:', e)
    return json({ error: 'Internal server error' }, 500)
  }
})
