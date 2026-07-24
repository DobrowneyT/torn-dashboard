// War Room help content (#153), authored as structured data so the panel is a
// data edit to extend — and so other pages can reuse the same shape later. Each
// section has an id, a title, an optional `forLeaders` flag (rendered only to
// leaders, always clearly labelled), and a list of {term, desc} points.
//
// Keep this accurate to the live War Room + Mobile overlay: dibs auto-drop
// (#159), attack button states, chain, roll call, personal alerts (#156/#157),
// the Mobile App launcher, and the leader-only controls incl. the headline
// banner (#158).

export const WAR_ROOM_HELP_SECTIONS = [
  {
    id: 'dibs',
    title: 'Dibs — calling a target',
    points: [
      { term: 'Claiming', desc: 'Click a target to put dibs on them so the rest of the faction knows they’re yours. Your name shows on that target for everyone.' },
      { term: 'Assist vs Attack', desc: 'If someone already has dibs you can Assist their claim instead of taking your own — you pile onto the same target rather than splitting fire.' },
      { term: 'Auto-drop', desc: 'A stalled claim releases itself so targets don’t stay locked forever — e.g. a claim on someone who’s hospitalised frees up shortly after they’re out if you haven’t hit, so nobody sits on a dead dib.' },
    ],
  },
  {
    id: 'attack',
    title: 'The attack button colours',
    points: [
      { term: 'Green', desc: 'The best case — the target is online and Okay (attackable right now).' },
      { term: 'Blue', desc: 'You’re assisting someone else’s dib on this target.' },
      { term: 'Red', desc: 'The default state — not currently a green/assist situation (e.g. hospital, or unclaimed).' },
    ],
  },
  {
    id: 'chain',
    title: 'Chain',
    points: [
      { term: 'The timer', desc: 'The chain counter shows how long until the chain drops — keep hits landing before it expires.' },
      { term: 'Cooldown', desc: 'After the chain ends there’s a cooldown before a new one counts; watch the timer so you don’t waste energy early.' },
      { term: 'Saving the chain', desc: 'When the timer is low, claim the save — get a hit in to reset the counter and keep the chain alive.' },
    ],
  },
  {
    id: 'rollcall',
    title: 'Roll call',
    points: [
      { term: 'Responding', desc: 'When a war starts, fill out your roll call so leaders know your availability. The Roll Call button flags you until you’ve responded.' },
      { term: 'Editing', desc: 'You can reopen and edit your response any time from the Roll Call button, even after the prompt has closed.' },
      { term: 'The gate', desc: 'The roll-call prompt auto-releases after everyone (or enough people) has answered, so it won’t keep nagging once the faction is checked in.' },
    ],
  },
  {
    id: 'alerts',
    title: 'Personal alerts',
    points: [
      { term: 'Dib reminder', desc: 'Get a personal nudge when a target you’ve got dibs on comes out of hospital, so you don’t miss the window.' },
      { term: 'Chain watch', desc: 'Get alerted when the chain timer drops low, so you can jump in for the save.' },
      { term: 'Per-browser', desc: 'Alert settings live in the gear next to the toolbar and are saved on this device — set them once per browser/phone.' },
    ],
  },
  {
    id: 'mobile',
    title: 'Mobile App',
    points: [
      { term: 'Opening it', desc: 'Tap the Mobile App button in the toolbar to open the phone-optimised War Room overlay — it works on any screen, but it’s built for one-handed use in a war.' },
      { term: 'Same controls', desc: 'Everything you use on desktop is there: dibs and the attack button on each target, the chain timer, roll call, and your personal alerts.' },
      { term: 'Settings', desc: 'The gear/settings in the mobile overlay holds the same alert and view options as the desktop toolbar.' },
    ],
  },
  {
    id: 'leaders',
    title: 'For leaders',
    forLeaders: true,
    points: [
      { term: 'Settings', desc: 'The gear on the title row opens the leadership controls — poll cadence, dibs auto-drop window, and the rest of the war config.' },
      { term: 'War notes & roll call', desc: 'The clipboard button opens war notes and the roll-call results, including the leads-only private note.' },
      { term: 'Headline banner', desc: 'Post a headline (Turtle / Stop / Push-to-time or free text) that shows across the top of everyone’s War Room to steer the faction in real time.' },
      { term: 'Spies', desc: 'Leadership spy-stat controls surface enemy stats where available to help call targets.' },
    ],
  },
]

// The member-facing sections (everyone) and, separately, the leader-only ones.
export function helpSectionsFor({ isLeader }) {
  return WAR_ROOM_HELP_SECTIONS.filter((s) => !s.forLeaders || isLeader)
}
