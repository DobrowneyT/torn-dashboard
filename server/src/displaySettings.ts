// Display tunables the SPA reads (#995), sourced from the feature-flag layer so
// MonChoon can adjust them in Global Admin without a deploy.
//
// ⚠️ Only named, display-only values leave here — never the flag table itself.
// Flags also hold cadences and switches that are an admin's business.
import type { FastifyInstance } from 'fastify'
import { requireAuth } from './authz.js'
import type { FlagResolver } from './featureFlags.js'

/** Fallback for the true-FF gradient's upper red anchor; mirrors the SPA's. */
export const FF_RED_HIGH_DEFAULT = 6
export const FF_RED_HIGH_FLAG = 'war_room_ff_red_high'

/** A usable upper anchor: a number above 3 (where green sits), else the default. */
export function ffRedHigh(value: unknown): number {
  const n = Number(value)
  return value !== undefined && value !== null && Number.isFinite(n) && n > 3 ? n : FF_RED_HIGH_DEFAULT
}

export function registerDisplaySettings(app: FastifyInstance, flags?: FlagResolver) {
  app.get('/api/display-settings', { preHandler: requireAuth() }, async () => {
    let raw: unknown
    try { raw = flags ? (await flags.get(FF_RED_HIGH_FLAG)).value : undefined } catch { raw = undefined }
    return { ff_red_high: ffRedHigh(raw) }
  })
}
