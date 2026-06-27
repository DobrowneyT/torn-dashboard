/**
 * OC Planner logic
 *
 * Pure helpers that turn the faction's live "available" crimes (cat=available
 * from the Torn API) plus the current roster into a tier-by-tier planning
 * summary: who's free or coming out soon, how many open slots are pausing soon,
 * and — the headline — how many new slots we need to spawn at each tier so
 * nobody sits idle.
 *
 * Two horizons are tracked independently:
 *   - member horizon — how far ahead to count members coming out of executing
 *     OCs ("coming out in the next 12h/24h").
 *   - pause horizon — how far ahead to count open slots from crimes that are
 *     pausing ("slots pausing in the next 12h/24h, or already paused").
 *
 * Two "tier" axes meet on the same 1–6 scale: member faction tier (drives
 * "who's available") and slot tier (which member tier runs a given position,
 * drives "open slots"). They're matched 1:1 in the spawn projection.
 *
 * Pausing model: a recruiting crime only *pauses* when its timer (ready_at)
 * elapses, and filling a single slot un-pauses it for another cycle. So for
 * planning, each paused/about-to-pause crime is worth exactly ONE slot, not its
 * full open count — and that slot is attributed to the WEAKEST (highest-number)
 * open tier on the crime, since that's the easiest position to plug.
 *
 * Kept framework-free so it can be unit-tested without React/Supabase.
 */

export const PLANNER_TIERS = [1, 2, 3, 4, 5, 6]

// Horizon presets (seconds) for both the member and pause switches.
export const HORIZONS = {
  '12h': 12 * 3600,
  '24h': 24 * 3600,
}

/**
 * Infer a crime → faction-tier map from config.tierRequirements. Each tier's
 * requirement list references specific crimes; we map every referenced crime
 * to the *lowest* (strongest) tier that lists it. Used only as a fallback when
 * a crime's open positions have no per-position tier.
 */
export function inferCrimeTierMap(tierRequirements = {}) {
  const map = {}
  for (const [tierStr, reqs] of Object.entries(tierRequirements)) {
    const tier = Number(tierStr)
    for (const req of (reqs || [])) {
      if (!req?.crime) continue
      if (map[req.crime] == null || tier < map[req.crime]) map[req.crime] = tier
    }
  }
  return map
}

/**
 * Per-position tier map from config.tierRequirements: "Crime||Role" → tier.
 * A position referenced by multiple tiers keeps the lowest (strongest) one.
 */
export function buildPositionTierMap(tierRequirements = {}) {
  const map = {}
  for (const [tierStr, reqs] of Object.entries(tierRequirements)) {
    const tier = Number(tierStr)
    for (const req of (reqs || [])) {
      if (!req?.crime || !req?.role) continue
      const key = `${req.crime}||${req.role}`
      if (map[key] == null || tier < map[key]) map[key] = tier
    }
  }
  return map
}

/**
 * Build a crime-tier resolver (crime-level fallback). An explicit `overrideMap`
 * (config.ocTierByCrime) wins; otherwise the inferred map; otherwise null.
 */
export function makeCrimeTierResolver({ overrideMap = {}, tierRequirements = {} } = {}) {
  const inferred = inferCrimeTierMap(tierRequirements)
  return (crimeName) => {
    if (crimeName in overrideMap) return overrideMap[crimeName]
    if (crimeName in inferred) return inferred[crimeName]
    return null
  }
}

// Bucket key for a member/slot tier. Tier 0 (and null/undefined) means "needs
// review" and sits out of the 1–6 spawn math.
export function tierKey(tier) {
  return tier == null || tier === 0 ? 'review' : tier
}

const slotLabel = (s) => s.position_info?.label || s.position

/**
 * The tier to plan a crime's single fillable slot at. We look at the crime's
 * OPEN positions, map each to a tier, and pick the weakest (highest number) —
 * the easiest open slot to plug to keep the crime alive. Falls back to the
 * crime-level resolver when no open position carries a per-position tier.
 *
 * @param {Object} crime
 * @param {Object} opts
 * @param {Record<string, number>} opts.positionTierMap - "Crime||Role" → tier
 * @param {(name: string, difficulty?: number) => number|null} opts.resolveTier
 * @param {boolean} [opts.preferWeakest=true] - pick max (weakest) vs min (strongest)
 * @returns {number|null}
 */
export function slotTierForOpenSlots(crime, { positionTierMap = {}, resolveTier = () => null, preferWeakest = true } = {}) {
  const tiers = []
  for (const s of (crime.slots || [])) {
    if (s.user) continue
    const t = positionTierMap[`${crime.name}||${slotLabel(s)}`]
    if (t != null) tiers.push(t)
  }
  if (tiers.length) return preferWeakest ? Math.max(...tiers) : Math.min(...tiers)
  return resolveTier(crime.name, crime.difficulty)
}

/**
 * Reduce live crimes + roster into the base planner summary (horizon-independent).
 * The expensive crime classification happens here; the two horizons are applied
 * later in {@link selectOpenSlots} and {@link planForHorizon}.
 */
export function buildPlannerSummary({
  crimes = [],
  currentMembers = [],
  memberTiers = {},
  memberNames = {},
  resolveTier = () => null,
  positionTierMap = {},
  preferWeakestSlot = true,
}) {
  const inOc = new Set()
  const pausingCrimes = [] // recruiting/empty crimes with ≥1 open slot
  const freeing = []       // members in Planning crimes (free at ready_at)

  for (const c of crimes) {
    const slots = c.slots || []
    for (const s of slots) if (s.user) inOc.add(String(s.user.id))

    const isRecruiting = c.status === 'Recruiting'
    const isEmpty = isRecruiting && c.planning_at == null
    const openCount = slots.filter((s) => !s.user).length

    // A crime that can stall: recruiting (or empty) with open slots. We record
    // its pause time + the tier of the slot we'd plug; the horizon filter is
    // applied later. Each such crime is worth ONE planning slot.
    if (isRecruiting && openCount > 0) {
      pausingCrimes.push({
        id: c.id,
        name: c.name,
        difficulty: c.difficulty,
        isEmpty,
        pausesAt: isEmpty ? null : (c.ready_at ?? null),
        expiresAt: c.expired_at ?? null,
        openCount,
        slotTier: slotTierForOpenSlots(c, { positionTierMap, resolveTier, preferWeakest: preferWeakestSlot }),
      })
    }

    // Planning crimes execute at ready_at → their occupants free up then.
    if (c.status === 'Planning' && c.ready_at) {
      for (const s of slots) {
        if (!s.user) continue
        const id = String(s.user.id)
        freeing.push({
          id,
          name: memberNames[id] || `#${id}`,
          tier: memberTiers[id] ?? null,
          readyAt: c.ready_at,
          crimeId: c.id,
          crimeName: c.name,
        })
      }
    }
  }

  const rank = (t) => (t === 0 || t == null ? 99 : t)
  const notInOc = currentMembers
    .filter((m) => !inOc.has(String(m.id)))
    .sort((a, b) => rank(a.tier) - rank(b.tier) || String(a.name).localeCompare(String(b.name)))

  freeing.sort((a, b) => (a.readyAt || 0) - (b.readyAt || 0))

  return { inOc, pausingCrimes, freeing, notInOc, totalCrimes: crimes.length }
}

/**
 * Apply the pause horizon: pick the crimes whose single slot counts right now.
 * A crime is included if it's empty (already needs a starter) or it's already
 * paused / will pause within the horizon. Each contributes exactly one slot,
 * bucketed by its weakest open tier.
 */
export function selectOpenSlots(pausingCrimes = [], { now, pauseHorizonSecs }) {
  const cutoff = now + pauseHorizonSecs
  const openSlotsByTier = {}
  const openCrimes = []
  for (const c of pausingCrimes) {
    const included = c.isEmpty || (c.pausesAt != null && c.pausesAt <= cutoff)
    if (!included) continue
    openSlotsByTier[tierKey(c.slotTier)] = (openSlotsByTier[tierKey(c.slotTier)] || 0) + 1
    openCrimes.push({ ...c, paused: c.pausesAt != null && c.pausesAt <= now })
  }
  openCrimes.sort(
    (a, b) =>
      Number(b.isEmpty) - Number(a.isEmpty) ||
      Number(b.paused) - Number(a.paused) ||
      (a.pausesAt ?? Infinity) - (b.pausesAt ?? Infinity),
  )
  return { openSlotsByTier, openSlotsTotal: openCrimes.length, openCrimes }
}

/**
 * Project, for the member horizon, who's available and what we need to spawn.
 * Available = free now (not in any OC) + coming out within the member horizon.
 * Need[tier] = max(0, availableMembers[tier] − openSlots[tier]).
 *
 * @param {ReturnType<typeof buildPlannerSummary>} summary
 * @param {ReturnType<typeof selectOpenSlots>} openSlots
 * @param {{ now: number, memberHorizonSecs: number }} opts
 */
export function planForHorizon(summary, openSlots, { now, memberHorizonSecs }) {
  const cutoff = now + memberHorizonSecs
  const comingOut = summary.freeing.filter((f) => f.readyAt <= cutoff)

  const seen = new Set()
  const members = []
  for (const m of summary.notInOc) {
    const k = String(m.id)
    if (seen.has(k)) continue
    seen.add(k)
    members.push({ id: k, name: m.name, tier: m.tier, source: 'free' })
  }
  for (const f of comingOut) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    members.push({ id: f.id, name: f.name, tier: f.tier, source: 'coming', readyAt: f.readyAt, crimeName: f.crimeName })
  }

  const availableByTier = {}
  for (const m of members) {
    const key = tierKey(m.tier)
    availableByTier[key] = (availableByTier[key] || 0) + 1
  }

  const spawnNeedByTier = {}
  for (const t of PLANNER_TIERS) {
    const avail = availableByTier[t] || 0
    const open = openSlots.openSlotsByTier[t] || 0
    spawnNeedByTier[t] = Math.max(0, avail - open)
  }

  const spawnTotal = PLANNER_TIERS.reduce((sum, t) => sum + spawnNeedByTier[t], 0)
  const freeNowCount = members.filter((m) => m.source === 'free').length

  return {
    comingOut,
    members,
    availableByTier,
    spawnNeedByTier,
    spawnTotal,
    freeNowCount,
    comingOutCount: comingOut.length,
    reviewCount: availableByTier.review || 0,
  }
}
