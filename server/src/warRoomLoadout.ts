// Enemy loadout capture (#528 Part 2) — payload validation and retention.
//
// Pure helpers, separated from the route in warRoomWrites.ts for the same
// reason warRoomRevive.ts is: this is the one place the untrusted-input
// contract is readable, and it needs to be unit-testable without a DB or an
// HTTP server. The payload is written by a userscript we do not control
// running on a real player's browser — validate shape, bound size, and never
// trust anything beyond what is checked here (#528's own warning).

/** Weapon slots worth capturing. Fists/boots are always "Fists"/"Kick" per
 *  #528's own DOM research — no intel, not worth a column. */
export const WEAPON_SLOTS = ['primary', 'secondary', 'melee', 'temporary'] as const
export const ARMOR_SLOTS = ['helmet', 'chest', 'pants', 'boots', 'gloves'] as const

/** Generous ceiling for an item/weapon name — Torn's longest names run well
 *  under this; it exists to cap abuse, not to fit real data tightly. */
const NAME_MAX = 100
/** Torn item ids are small positive integers; this is a sanity ceiling, not
 *  an attempt to track Torn's actual catalog size. */
const ITEM_ID_MAX = 10_000_000
/** Whole-payload ceiling (bytes, via JSON.stringify) — a real capture is a
 *  few hundred bytes (nine slots at most); this catches a client trying to
 *  stuff the jsonb column rather than constraining honest use. */
export const LOADOUT_MAX_BYTES = 4_000
/** Four bonus containers render per weapon in the observed DOM; allow headroom. */
export const BONUS_MAX = 8
/** Torn's own bonus descriptions run to about 60 chars ("26% chance to Slow…"). */
export const DESCRIPTION_MAX = 200

/** Per-member rate limit, mirroring feedback.ts's in-process pattern. A
 *  legitimate capture happens once per fight (the userscript dedupes by
 *  content hash before ever calling this), so even a very active war —
 *  attacking a fresh target every few seconds — sits far under this; it
 *  exists to stop a MODIFIED script from filling the table, per #528. */
export const LOADOUT_RATE_LIMIT = 30
export const LOADOUT_RATE_WINDOW_MS = 5 * 60 * 1000

/** How long an observation survives before the daily prune removes it.
 *
 * Chosen over member_stat_samples' 90-day precedent deliberately shorter:
 * this is per-player intel ABOUT an individual, gathered by us rather than
 * handed out by Torn (#528's own "Data policy" warning), so the default
 * should lean toward NOT holding it rather than matching a window picked for
 * a much less sensitive series. 30 days comfortably spans a war (and the
 * cooldown before a likely rematch) while not becoming a standing dossier on
 * anyone we've ever fought.
 */
export const LOADOUT_RETENTION_DAYS = 30

export interface ValidatedLoadout {
  targetId: number
  warId: number | null
  loadout: Record<string, unknown>
}

export interface ValidationResult {
  ok: boolean
  error?: string
  value?: ValidatedLoadout
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate one slot map (weapons or armor) against its allowed slot names. */
function validateSlotMap(raw: unknown, allowedSlots: readonly string[]): Record<string, unknown> | string {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) return 'must be an object'
  const out: Record<string, unknown> = {}
  for (const [slot, entry] of Object.entries(raw)) {
    if (!allowedSlots.includes(slot)) return `unknown slot "${slot}"`
    if (!isPlainObject(entry)) return `slot "${slot}" must be an object`
    const extraKeys = Object.keys(entry).filter(
      (k) => k !== 'name' && k !== 'item_id' && k !== 'bonuses' && k !== 'glow' && k !== 'colour'
    )
    if (extraKeys.length > 0) return `slot "${slot}" has unexpected field(s): ${extraKeys.join(', ')}`
    const name = entry.name
    if (typeof name !== 'string' || !name.trim()) return `slot "${slot}" needs a non-empty name`
    if (name.length > NAME_MAX) return `slot "${slot}" name exceeds ${NAME_MAX} chars`
    const clean: Record<string, unknown> = { name: name.trim() }
    // item_id is a bonus, best-effort field — validated when present, never
    // required (#528: a gear-hiding script can strip the <img> the id comes
    // from, and that must not block the capture).
    if (entry.item_id !== undefined && entry.item_id !== null) {
      const id = Number(entry.item_id)
      if (!Number.isInteger(id) || id <= 0 || id > ITEM_ID_MAX) {
        return `slot "${slot}" item_id must be a positive integer`
      }
      clean.item_id = id
    }

    // ⚠️ #616: bonuses, glow and colour are all BEST-EFFORT, exactly like
    // item_id. A weapon with none is ordinary, not broken, and a capture must
    // never be rejected for lacking them — armour carries no glow at all, and
    // rejecting on that would refuse every armour capture we already take.
    if (entry.bonuses !== undefined && entry.bonuses !== null) {
      if (!Array.isArray(entry.bonuses)) return `slot "${slot}" bonuses must be an array`
      if (entry.bonuses.length > BONUS_MAX) {
        return `slot "${slot}" has more than ${BONUS_MAX} bonuses`
      }
      const bonuses: Record<string, unknown>[] = []
      for (const b of entry.bonuses) {
        if (!isPlainObject(b)) return `slot "${slot}" bonus must be an object`
        const title = b.title
        // ⚠️ A blank title is Torn's EMPTY bonus slot (`blank-bonus-25`), which
        // the userscript already skips. Refuse it here too rather than storing
        // a nameless bonus that would render as a phantom special.
        if (typeof title !== 'string' || !title.trim()) return `slot "${slot}" bonus needs a title`
        if (title.length > NAME_MAX) return `slot "${slot}" bonus title exceeds ${NAME_MAX} chars`
        const cleanBonus: Record<string, unknown> = { title: title.trim() }
        if (b.description !== undefined && b.description !== null) {
          const d = b.description
          if (typeof d !== 'string') return `slot "${slot}" bonus description must be a string`
          if (d.length > DESCRIPTION_MAX) {
            return `slot "${slot}" bonus description exceeds ${DESCRIPTION_MAX} chars`
          }
          if (d.trim()) cleanBonus.description = d.trim()
        }
        bonuses.push(cleanBonus)
      }
      if (bonuses.length > 0) clean.bonuses = bonuses
    }

    // ⚠️ Stored as OBSERVED, not interpreted. `glow` is the token from Torn's
    // `glow-<x>___<hash>` class and `colour` a sibling tier token seen once
    // (a defender's P90: `glow-yellow orange`). Which of the two is the real
    // rarity tier is not yet settled — see the userscript's captureQuality —
    // so both are kept verbatim and neither is turned into a boolean here.
    for (const key of ['glow', 'colour'] as const) {
      const v = entry[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string' || !v.trim()) return `slot "${slot}" ${key} must be a non-empty string`
      if (!/^[a-z]{1,20}$/.test(v.trim())) return `slot "${slot}" ${key} must be a simple token`
      clean[key] = v.trim()
    }

    out[slot] = clean
  }
  return out
}

/**
 * Validate an untrusted `/api/war-room/loadout` POST body.
 *
 * Rejects: missing/invalid target_id, a loadout that isn't {weapons?, armor?},
 * unknown slot names, malformed slot entries, an empty capture (nothing in
 * either map), and a payload over the size ceiling.
 */
export function validateLoadoutPayload(body: unknown): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, error: 'body required' }

  const targetId = Number(body.target_id)
  if (!Number.isFinite(targetId) || !Number.isInteger(targetId) || targetId <= 0) {
    return { ok: false, error: 'target_id required' }
  }

  let warId: number | null = null
  if (body.war_id !== undefined && body.war_id !== null) {
    const w = Number(body.war_id)
    if (!Number.isFinite(w) || w <= 0) return { ok: false, error: 'war_id must be a positive number' }
    warId = w
  }

  const rawLoadout = body.loadout
  if (!isPlainObject(rawLoadout)) return { ok: false, error: 'loadout required' }
  const extraTopKeys = Object.keys(rawLoadout).filter((k) => k !== 'weapons' && k !== 'armor')
  if (extraTopKeys.length > 0) {
    return { ok: false, error: `loadout has unexpected field(s): ${extraTopKeys.join(', ')}` }
  }

  const weapons = validateSlotMap(rawLoadout.weapons, WEAPON_SLOTS)
  if (typeof weapons === 'string') return { ok: false, error: `weapons: ${weapons}` }
  const armor = validateSlotMap(rawLoadout.armor, ARMOR_SLOTS)
  if (typeof armor === 'string') return { ok: false, error: `armor: ${armor}` }

  if (Object.keys(weapons).length === 0 && Object.keys(armor).length === 0) {
    return { ok: false, error: 'loadout must capture at least one slot' }
  }

  const loadout = { weapons, armor }
  const size = Buffer.byteLength(JSON.stringify(loadout), 'utf8')
  if (size > LOADOUT_MAX_BYTES) {
    return { ok: false, error: `loadout payload exceeds ${LOADOUT_MAX_BYTES} bytes` }
  }

  return { ok: true, value: { targetId, warId, loadout } }
}

export interface PruneResult {
  pruned: number
  retentionDays: number
}

/**
 * Daily hard-delete past the retention window (#528's own "prune, not just
 * describe" acceptance criterion). Unlike the scraper job table (registered
 * DISABLED until an admin opts in per faction, see scraper/scheduler.ts),
 * this is wired unconditionally in main.ts — a category of record about real
 * players should not depend on someone remembering to flip it on.
 */
export async function pruneLoadoutObservations(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  retentionDays: number = LOADOUT_RETENTION_DAYS
): Promise<PruneResult> {
  const res = await db.query(
    `DELETE FROM war_room_loadout_observations_v2 WHERE observed_at < now() - ($1 || ' days')::interval`,
    [String(retentionDays)]
  )
  return { pruned: res.rowCount ?? 0, retentionDays }
}
