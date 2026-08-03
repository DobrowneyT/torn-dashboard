// Tier assignment — pure-logic port of scripts/assign_tiers.py (v2 CPR,
// proportion-based 2/3 rule, top-down tier checking, KNN fallback for
// partial data). Requirements come from faction_settings.tier_requirements
// (the config.js shape): role entries {crime, role, minCpr} and average
// entries {level, minCpr, isAverage: true}.

export interface RoleRequirement {
  crime: string
  role: string
  minCpr: number
  isAverage?: false
}
export interface AverageRequirement {
  level: number
  role?: string
  minCpr: number
  isAverage: true
}
export type TierRequirement = RoleRequirement | AverageRequirement
export type TierRequirements = Record<number | string, TierRequirement[]>

export interface CprRecord {
  cpr_value: number
}
/** { crimeName: { positionLabel: { cpr_value } } } */
export type MemberCpr = Record<string, Record<string, CprRecord>>
export type CrimeTypes = Record<string, { difficulty: number | null }>

export interface TierAssignmentResult {
  tier: number
  assignment_method: string
  requirements_met: number
  requirements_needed: number
}

const PROPORTION_THRESHOLD = 2 / 3
const KNN_K = 5

export function assignTiers(
  memberCpr: Record<string, MemberCpr>,
  crimeTypes: CrimeTypes,
  requirements: TierRequirements
): Record<string, TierAssignmentResult> {
  const tiers = Object.keys(requirements).map(Number).sort((a, b) => a - b)
  const crimesByDifficulty = new Map<number, string[]>()
  for (const [name, info] of Object.entries(crimeTypes)) {
    if (info.difficulty == null) continue
    if (!crimesByDifficulty.has(info.difficulty)) crimesByDifficulty.set(info.difficulty, [])
    crimesByDifficulty.get(info.difficulty)!.push(name)
  }

  const getCpr = (data: MemberCpr, crime: string, role: string): number | null =>
    data[crime]?.[role]?.cpr_value ?? null

  const difficultyAverage = (data: MemberCpr, difficulty: number): number | null => {
    const values: number[] = []
    for (const crime of crimesByDifficulty.get(difficulty) ?? []) {
      for (const rec of Object.values(data[crime] ?? {})) {
        if (typeof rec?.cpr_value === 'number') values.push(rec.cpr_value)
      }
    }
    if (values.length === 0) return null
    return values.reduce((s, v) => s + v, 0) / values.length
  }

  const evaluate = (data: MemberCpr, req: TierRequirement): { met: boolean; available: boolean } => {
    if ('isAverage' in req && req.isAverage) {
      const avg = difficultyAverage(data, req.level)
      if (avg === null) return { met: false, available: false }
      return { met: avg >= req.minCpr, available: true }
    }
    const r = req as RoleRequirement
    const value = getCpr(data, r.crime, r.role)
    if (value === null) return { met: false, available: false }
    return { met: value >= r.minCpr, available: true }
  }

  const allDatapoints = (data: MemberCpr): Array<[string, string, number]> => {
    const points: Array<[string, string, number]> = []
    for (const [crime, roles] of Object.entries(data)) {
      for (const [role, rec] of Object.entries(roles ?? {})) {
        if (typeof rec?.cpr_value === 'number') points.push([crime, role, rec.cpr_value])
      }
    }
    return points
  }

  // ── Pass 1 ────────────────────────────────────────────────────────────
  const assignments: Record<string, TierAssignmentResult> = {}
  const pass1: Record<string, TierAssignmentResult> = {}
  const knnQueue: Array<{ memberId: string; datapoints: Array<[string, string, number]> }> = []

  for (const [memberId, data] of Object.entries(memberCpr)) {
    const datapoints = allDatapoints(data)
    if (datapoints.length === 0) {
      assignments[memberId] = {
        tier: 0, assignment_method: 'NO_DATA_MANUAL_REVIEW_REQUIRED',
        requirements_met: 0, requirements_needed: 0,
      }
      continue
    }

    let assigned: TierAssignmentResult | null = null
    let queued = false
    for (const tier of tiers) {
      const reqs = requirements[tier] ?? requirements[String(tier)]
      const needed = Math.ceil(reqs.length * PROPORTION_THRESHOLD)
      let met = 0
      let available = 0
      for (const req of reqs) {
        const r = evaluate(data, req)
        if (r.available) {
          available += 1
          if (r.met) met += 1
        }
      }
      if (available === 0) continue
      if (available < reqs.length) {
        knnQueue.push({ memberId, datapoints })
        queued = true
        break
      }
      if (met >= needed) {
        assigned = {
          tier, assignment_method: 'pass1_requirements',
          requirements_met: met, requirements_needed: needed,
        }
        break
      }
    }
    if (queued) continue
    assignments[memberId] = assigned ?? {
      tier: 6, assignment_method: 'pass1_default_tier6',
      requirements_met: 0, requirements_needed: 0,
    }
    pass1[memberId] = assignments[memberId]
  }

  // ── Pass 2: KNN ───────────────────────────────────────────────────────
  for (const { memberId, datapoints } of knnQueue) {
    const votes: number[] = []
    for (const [crime, role, value] of datapoints) {
      const neighbors: Array<[number, number]> = []
      for (const [otherId, assignment] of Object.entries(pass1)) {
        const otherCpr = getCpr(memberCpr[otherId], crime, role)
        if (otherCpr !== null) neighbors.push([Math.abs(value - otherCpr), assignment.tier])
      }
      if (neighbors.length < KNN_K) continue
      const nearest = neighbors.sort((a, b) => a[0] - b[0]).slice(0, KNN_K)
      const counts = new Map<number, number>()
      for (const [, tier] of nearest) counts.set(tier, (counts.get(tier) ?? 0) + 1)
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
      votes.push(best[0])
    }
    if (votes.length === 0) {
      assignments[memberId] = {
        tier: 6, assignment_method: 'knn_failed_default_tier6',
        requirements_met: 0, requirements_needed: 0,
      }
      continue
    }
    const counts = new Map<number, number>()
    for (const t of votes) counts.set(t, (counts.get(t) ?? 0) + 1)
    const maxVotes = Math.max(...counts.values())
    const finalTier = Math.min(...[...counts.entries()].filter(([, v]) => v === maxVotes).map(([t]) => t))
    assignments[memberId] = {
      tier: finalTier, assignment_method: 'knn_prediction',
      requirements_met: 0, requirements_needed: 0,
    }
  }

  return assignments
}
