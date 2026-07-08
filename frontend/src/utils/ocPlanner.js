/**
 * OC Planner logic (v2 — scenarios, not tier-slots)
 *
 * Turns the faction's live "available" crimes (cat=available) plus the current
 * roster into a *pipeline* plan: who's free or coming out, which crimes are
 * pausing and need a feed, and how many new scenarios to spawn per difficulty
 * category so nobody idles.
 *
 * Model (see plan): OC 2.0 spawns a random scenario within a difficulty
 * CATEGORY (Introductory / Simple / Intermediate / Advanced / Elaborate). The
 * faction maximizes Advanced and cascades members who can't run it down to
 * Intermediate, then Simple. Filling ONE slot of a crime resets its 24h clock,
 * so every crime — paused, empty, or freshly spawned — is a single-member sink;
 * we feed crimes one at a time, soonest-to-pause first. Balancing free members
 * against pausing crimes 1:1 gives the spawn count (member surplus) and the
 * "crews short" warning (crime surplus).
 *
 * Two independent horizons: a MEMBER window (who's coming out) and a CRIMES
 * window (which crimes' pauses count). Kept framework-free for unit testing.
 */

// Horizon presets (seconds) for both the member and crimes switches.
export const HORIZONS = {
  '12h': 12 * 3600,
  '24h': 24 * 3600,
}

// Fallback search order when a live crime's name isn't in ocScenarios — first
// category whose difficulty range contains the level wins. Ordered so Lv8
// resolves to Advanced (not Elaborate), matching what the faction runs.
const CATEGORY_FALLBACK_ORDER = ['introductory', 'simple', 'intermediate', 'advanced', 'elaborate']

/**
 * Build a crime → category resolver. Name is authoritative (Lv8 spans both
 * Advanced and Elaborate); difficulty is a fallback for unknown names.
 * @returns {(name: string, difficulty?: number) => string|null}
 */
export function makeCategoryResolver({ scenarios = {}, categories = {} } = {}) {
  return (name, difficulty) => {
    if (name && scenarios[name]) return scenarios[name].category
    if (difficulty == null) return null
    for (const key of CATEGORY_FALLBACK_ORDER) {
      const c = categories[key]
      if (c && difficulty >= c.difficulty[0] && difficulty <= c.difficulty[1]) return key
    }
    return null
  }
}

/** Names in cprRequirements that belong to the Advanced category (for the T3 CPR gate). */
export function advancedCrimeNames({ scenarios = {}, cprRequirements = {} } = {}) {
  return Object.keys(cprRequirements).filter((name) => scenarios[name]?.category === 'advanced')
}

/**
 * Does a member's CPR clear ≥1 position in any Advanced crime we have data for?
 * @param {Record<string, number>} cprMap - "Crime||Position" → cpr value
 */
export function qualifiesForAdvanced(cprMap = {}, { cprRequirements = {}, advancedNames = [] } = {}) {
  for (const name of advancedNames) {
    const positions = cprRequirements[name]?.positions || {}
    for (const [pos, req] of Object.entries(positions)) {
      const v = cprMap[`${name}||${pos}`]
      if (v != null && v >= req) return true
    }
  }
  return false
}

/**
 * The hardest category a member is planned into, from faction tier.
 * T1/T2 → advanced; T3 → advanced iff CPR qualifies, else intermediate;
 * T4 → intermediate; T5/T6 → simple; T0/null (review) → null (excluded).
 */
export function maxCategoryForMember(tier, advancedQualifies) {
  if (tier == null || tier === 0) return null
  if (tier <= 2) return 'advanced'
  if (tier === 3) return advancedQualifies ? 'advanced' : 'intermediate'
  if (tier === 4) return 'intermediate'
  return 'simple'
}

/**
 * Horizon-independent reduction of live crimes + roster.
 *
 * @param {Object} args
 * @param {Array} args.crimes          - Torn cat=available crimes
 * @param {Array} args.currentMembers  - [{ id, name, tier, category }] is_current roster (category pre-assigned)
 * @param {Record<string,string>} args.memberCategory - id → category (for occupants of executing crimes)
 * @param {Record<string,string>} args.memberNames    - id → name
 * @param {Record<string,number>} args.memberTiers    - id → faction tier
 * @param {(name: string, difficulty?: number) => string|null} args.categoryOf
 */
export function buildBase({
  crimes = [],
  currentMembers = [],
  memberCategory = {},
  memberNames = {},
  memberTiers = {},
  categoryOf = () => null,
}) {
  const inOc = new Set()
  const pausingCrimes = [] // recruiting/empty crimes with ≥1 open slot
  const freeing = []       // occupants of Planning crimes (free at ready_at)

  for (const c of crimes) {
    const slots = c.slots || []
    for (const s of slots) if (s.user) inOc.add(String(s.user.id))

    const category = categoryOf(c.name, c.difficulty)
    const isRecruiting = c.status === 'Recruiting'
    const isEmpty = isRecruiting && c.planning_at == null
    const openCount = slots.filter((s) => !s.user).length

    if (isRecruiting && openCount > 0) {
      pausingCrimes.push({
        id: c.id,
        name: c.name,
        difficulty: c.difficulty,
        category,
        isEmpty,
        pausesAt: isEmpty ? null : (c.ready_at ?? null),
        openCount,
      })
    }

    if (c.status === 'Planning' && c.ready_at) {
      for (const s of slots) {
        if (!s.user) continue
        const id = String(s.user.id)
        freeing.push({
          id,
          name: memberNames[id] || `#${id}`,
          tier: memberTiers[id] ?? null,
          category: memberCategory[id] ?? null,
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

  return { inOc, notInOc, freeing, pausingCrimes, totalCrimes: crimes.length }
}

/** Apply the MEMBER window: who's available (free now + coming out within window), by category. */
export function selectAvailable(base, { now, memberHorizonSecs }) {
  const cutoff = now + memberHorizonSecs
  const comingOut = base.freeing.filter((f) => f.readyAt <= cutoff)

  const seen = new Set()
  const members = []
  for (const m of base.notInOc) {
    const k = String(m.id)
    if (seen.has(k)) continue
    seen.add(k)
    members.push({ id: k, name: m.name, tier: m.tier, category: m.category, source: 'free' })
  }
  for (const f of comingOut) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    members.push({ id: f.id, name: f.name, tier: f.tier, category: f.category, source: 'coming', readyAt: f.readyAt, crimeName: f.crimeName })
  }

  const membersByCategory = {}
  let reviewCount = 0
  for (const m of members) {
    if (m.category == null) { reviewCount++; continue }
    membersByCategory[m.category] = (membersByCategory[m.category] || 0) + 1
  }

  return {
    members,
    comingOut,
    membersByCategory,
    freeNowCount: members.filter((m) => m.source === 'free').length,
    comingOutCount: comingOut.length,
    reviewCount,
  }
}

/** Apply the CRIMES window: pausing crimes (1 feed each) by category + an ordered feed queue. */
export function selectPausingSlots(base, { now, crimesHorizonSecs }) {
  const cutoff = now + crimesHorizonSecs
  const pausingByCategory = {}
  const feedQueue = []
  for (const c of base.pausingCrimes) {
    const included = c.isEmpty || (c.pausesAt != null && c.pausesAt <= cutoff)
    if (!included) continue
    const paused = c.pausesAt != null && c.pausesAt <= now
    pausingByCategory[c.category ?? 'unmapped'] = (pausingByCategory[c.category ?? 'unmapped'] || 0) + 1
    feedQueue.push({ ...c, paused })
  }
  // Most urgent first: empty, then already-paused, then soonest to pause.
  feedQueue.sort(
    (a, b) =>
      Number(b.isEmpty) - Number(a.isEmpty) ||
      Number(b.paused) - Number(a.paused) ||
      (a.pausesAt ?? Infinity) - (b.pausesAt ?? Infinity),
  )
  return { pausingByCategory, feedQueue }
}

/**
 * Balance members against pausing crimes 1:1 per plannable category.
 * scenariosToSpawn = member surplus; crewsShort = crime surplus.
 */
export function buildSpawnPlan({ membersByCategory = {}, pausingByCategory = {}, categories = {} }) {
  const plannable = Object.entries(categories)
    .filter(([, c]) => c.plannable)
    .sort((a, b) => b[1].difficulty[1] - a[1].difficulty[1]) // Advanced first
    .map(([k]) => k)

  const rows = {}
  let scenariosTotal = 0
  let scopeTotal = 0
  let crewsShortTotal = 0
  for (const cat of plannable) {
    const members = membersByCategory[cat] || 0
    const pausing = pausingByCategory[cat] || 0
    const scenariosToSpawn = Math.max(0, members - pausing)
    const crewsShort = Math.max(0, pausing - members)
    const scopeCost = scenariosToSpawn * (categories[cat].scopeCost || 0)
    rows[cat] = { members, pausing, scenariosToSpawn, crewsShort, scopeCost }
    scenariosTotal += scenariosToSpawn
    scopeTotal += scopeCost
    crewsShortTotal += crewsShort
  }
  return { plannable, rows, scenariosTotal, scopeTotal, crewsShortTotal }
}
