/**
 * Matching mirrored roles to Torn's own crime positions (#442).
 *
 * This is the third appearance of the same hazard #390 hit twice. The strings
 * for the same thing differ per source:
 *
 *   tornprobability GetRoleNames   "Thief 1"     scenario "Mob Mentality"
 *   tornprobability GetRoleWeights "Thief1"      scenario "MobMentality"
 *   Torn's crime payload           "Thief #1"
 *
 * Our CPR readings are keyed by Torn's label; the simulator's roles are keyed by
 * tornprobability's. Joining them wrong reports one role's headcount under
 * another's name — invisible on screen, and wrong in the direction that gets a
 * crime spawned it should not be.
 *
 * ⚠️ Both sides ALSO carry a position id ("P1".."P6"), which looks like the
 * cleaner key. It is not trusted on its own: nothing guarantees tornprobability
 * numbers its positions the way Torn does, and an off-by-one there would be
 * completely silent. Name and position must AGREE, and a disagreement is
 * reported rather than resolved.
 */
import { normaliseKey } from './probabilityClient.js'

export interface MirroredRole {
  position_id: string
  role_name: string
}

export interface TornPosition {
  position_label: string
  position_id: string | null
}

export interface RoleMatch {
  positionId: string
  roleName: string
  positionLabel: string
  /** How the match was made — 'both' is the only one that had corroboration. */
  via: 'both' | 'name' | 'position'
}

export interface RoleMatchResult {
  matches: RoleMatch[]
  /** Roles with no Torn position we could tie them to. */
  unmatched: string[]
  /** Roles where the name and the position id pointed at different things. */
  conflicts: Array<{ roleName: string; byName: string; byPosition: string }>
}

export function matchRolesToPositions(
  roles: MirroredRole[],
  positions: TornPosition[]
): RoleMatchResult {
  const byLabel = new Map<string, TornPosition>()
  const byPositionId = new Map<string, TornPosition>()
  for (const p of positions) {
    byLabel.set(normaliseKey(p.position_label), p)
    if (p.position_id) byPositionId.set(normaliseKey(p.position_id), p)
  }

  const matches: RoleMatch[] = []
  const unmatched: string[] = []
  const conflicts: RoleMatchResult['conflicts'] = []

  for (const role of roles) {
    const nameHit = byLabel.get(normaliseKey(role.role_name))
    const posHit = byPositionId.get(normaliseKey(role.position_id))

    if (nameHit && posHit) {
      // Both sources found something. If they disagree, we do not get to pick:
      // one of our two assumptions about this crime is wrong, and using either
      // would produce a confident number built on the broken one.
      if (normaliseKey(nameHit.position_label) !== normaliseKey(posHit.position_label)) {
        conflicts.push({
          roleName: role.role_name,
          byName: nameHit.position_label,
          byPosition: posHit.position_label,
        })
        continue
      }
      matches.push({
        positionId: role.position_id,
        roleName: role.role_name,
        positionLabel: nameHit.position_label,
        via: 'both',
      })
      continue
    }

    // Only one source matched. The NAME is preferred: it is what a human reads
    // on both sides, and a name collision is far less likely than the two
    // services happening to number their positions differently.
    if (nameHit) {
      matches.push({
        positionId: role.position_id,
        roleName: role.role_name,
        positionLabel: nameHit.position_label,
        via: 'name',
      })
      continue
    }
    if (posHit) {
      matches.push({
        positionId: role.position_id,
        roleName: role.role_name,
        positionLabel: posHit.position_label,
        via: 'position',
      })
      continue
    }

    unmatched.push(role.role_name)
  }

  return { matches, unmatched, conflicts }
}
