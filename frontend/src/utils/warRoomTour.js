// First-run spotlight tour state + step logic (#153 part 2). Kept
// side-effect-free (except the localStorage helpers) so it's unit-testable.
// "Seen" is per-browser localStorage, tracked separately for the desktop War
// Room and the Mobile App overlay — each has its own first-run pass and its own
// one-click Skip, so a returning user on a new device dismisses each in one tap.

const SEEN_KEY = 'warRoomTourSeen' // { desktop: true, mobile: true }

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function isTourSeen(surface, storage = defaultStorage()) {
  if (!storage) return false
  try {
    const map = JSON.parse(storage.getItem(SEEN_KEY) || '{}')
    return map[surface] === true
  } catch { return false }
}

export function markTourSeen(surface, storage = defaultStorage()) {
  if (!storage) return
  try {
    const map = JSON.parse(storage.getItem(SEEN_KEY) || '{}')
    map[surface] = true
    storage.setItem(SEEN_KEY, JSON.stringify(map))
  } catch { /* ignore quota / serialization */ }
}

// Replay clears the seen flag so the pass runs again.
export function resetTourSeen(surface, storage = defaultStorage()) {
  if (!storage) return
  try {
    const map = JSON.parse(storage.getItem(SEEN_KEY) || '{}')
    delete map[surface]
    storage.setItem(SEEN_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

// The graceful-degradation core: from `start`, scan in direction `dir` (+1/-1)
// for the first step whose target is present, per the `isPresent(step)`
// predicate. Returns that index, or -1 if none remain — so a step whose target
// is role-gated, absent (no active war), or off-screen is skipped, not broken.
export function firstPresentStep(steps, start, dir, isPresent) {
  if (dir !== 1 && dir !== -1) return -1
  for (let i = start; i >= 0 && i < steps.length; i += dir) {
    if (isPresent(steps[i])) return i
  }
  return -1
}
