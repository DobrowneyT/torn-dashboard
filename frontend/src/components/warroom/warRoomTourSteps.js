// Spotlight tour steps (#153 part 2), authored as structured data so the tour
// is a data edit to extend. Each step targets a stable `data-tour` attribute;
// `surface` splits the desktop first-visit pass from the Mobile App overlay
// pass. Any step whose target isn't in the DOM is skipped (graceful degrade).

export const WAR_ROOM_TOUR_STEPS = [
  // ── Desktop War Room ──
  {
    id: 'roster', surface: 'desktop',
    title: 'Targets — dibs & attack',
    body: 'Each row is an enemy. Click a target to put dibs on them (or Assist someone else’s claim). The attack button’s colour tells you the state: green = online + Okay, blue = assisting a dib, red = default.',
  },
  {
    id: 'chain', surface: 'desktop',
    title: 'The chain',
    body: 'Watch the chain timer — keep hits landing before it drops, and jump in to save the chain when it’s low.',
  },
  {
    id: 'rollcall', surface: 'desktop',
    title: 'Roll call',
    body: 'When a war starts, fill out your roll call so leaders know your availability. You can edit your answer any time from here.',
  },
  {
    id: 'alerts', surface: 'desktop',
    title: 'Personal alerts',
    body: 'Turn on personal alerts — a nudge when a target you’ve got dibs on leaves hospital, and a chain-watch when the timer runs low. Saved on this device.',
  },
  {
    id: 'mobile', surface: 'desktop',
    title: 'On your phone',
    body: 'Tap Mobile App for the phone-optimised War Room. The same controls are all there — when you open it, we’ll point them out.',
  },
  {
    id: 'help', surface: 'desktop',
    title: 'Need a refresher?',
    body: 'The ? button reopens the help panel and can replay this tour any time.',
  },

  // ── Mobile App overlay ── (steps whose target isn't present are skipped, so
  // this pass grows as more mobile controls get stable data-tour homes)
  {
    id: 'm-roster', surface: 'mobile',
    title: 'Targets — dibs & attack',
    body: 'Same as desktop: tap a target to claim dibs or assist, and the attack button’s colour shows the state (green = online + Okay, blue = assisting, red = default).',
  },
  {
    id: 'm-settings', surface: 'mobile',
    title: 'Filters, alerts & settings',
    body: 'The header controls hold your filters and settings — the same view and alert options as the desktop toolbar.',
  },
]

export function tourStepsFor(surface) {
  return WAR_ROOM_TOUR_STEPS.filter((s) => s.surface === surface)
}
