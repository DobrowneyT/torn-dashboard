/**
 * Client-side clamp for the war-room cadence fields, where **0 means off**.
 *
 * ⚠️ This exists because `Math.max(floor, Math.floor(Number(x) || fallback))`
 * cannot express "off". `Number('0') || 30` is 30 — zero is falsy — so an
 * operator who typed 0 watched the field revert to 30s in front of them, with
 * no error and nothing in the log. Every cadence input on the panel had it.
 *
 * The valid range is deliberately NON-CONTIGUOUS: exactly 0, or [floor, max].
 * A value between the two is raised to the floor rather than collapsed to 0,
 * because someone typing 2 clearly wants polling — just faster than we will
 * safely do. Mirrors clampConfigValue + ZERO_OR_FLOOR in
 * server/src/warRoomConfigBounds.ts; keep the two in step.
 */
export function clampCadence(raw, fallback, floor, max = 600) {
  // A cleared input is not "off" — it is an accident. Off has to be typed.
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const floored = Math.floor(n)
  if (floored <= 0) return 0
  return Math.min(max, Math.max(floor, floored))
}
