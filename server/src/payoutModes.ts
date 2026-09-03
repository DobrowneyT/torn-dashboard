/**
 * The three OC payout modes (#134), and what an unset faction setting means.
 *
 * Kept in one module because the answer has to be identical on both sides of
 * the write: `PUT /api/admin/settings/payout_mode` validates against this list,
 * and `GET /api/oc-config` resolves the absent case with this default. Before
 * #587 the list was private to `admin.ts` and the absent case was `null`, which
 * left every reader to invent its own fallback — the Payout Management page
 * chose flat-weighted while the tier UI chose tiered, on the same faction.
 *
 * Equal is the default because it is the only mode that is correct without any
 * further configuration: tiered needs a tier table, flat-weighted needs a
 * ticket policy, and a faction that has set neither should not be silently
 * paid by one of them. The frontend mirrors this in
 * `frontend/src/utils/payoutCalculations.js` for its pre-fetch seed.
 */
export const PAYOUT_MODES = ['tiered', 'flat-weighted', 'equal'] as const

export type PayoutMode = (typeof PAYOUT_MODES)[number]

export const DEFAULT_PAYOUT_MODE: PayoutMode = 'equal'

/** Whether a value off the wire (or out of jsonb) is a mode we recognise. */
export function isPayoutMode(value: unknown): value is PayoutMode {
  return typeof value === 'string' && (PAYOUT_MODES as readonly string[]).includes(value)
}
