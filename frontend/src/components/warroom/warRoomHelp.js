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
    id: 'quickbar',
    title: 'The quick bar',
    points: [
      { term: 'Faction War Page', desc: 'Opens your faction’s war/ranked-war page on Torn in a new tab.' },
      { term: 'Faction Medical', desc: 'Jumps to your faction armoury’s medical items (blood bags, first-aid, morphine) so you can grab a heal fast.' },
      { term: 'Items', desc: 'Opens your Torn items page — quick access to your own inventory mid-war.' },
      { term: 'Revives', desc: 'Requests a revive from your faction’s configured revive service (leadership sets the service up in settings). Shows Sent / an error, with a short cooldown between requests.' },
      { term: 'Find Target', desc: 'Opens a random enemy’s attack page within a user-ID range you set (click it, then the little settings to choose the min/max ID) — handy for finding chain filler outside the war list.' },
    ],
  },
  {
    id: 'filters',
    title: 'Filtering the list',
    points: [
      { term: 'Status', desc: 'Show only Okay / Hospital / Flying / Jail — pick any combination (multi-select); “All” clears it. Most of the time you want Okay (attackable now).' },
      { term: 'Activity', desc: 'Filter by Online / Idle / Offline to focus on who’s actually at their keyboard.' },
      { term: 'Battle-stat filter', desc: 'Turn “Stats” On and set a Min and/or Max to show only enemies whose spied battle-stat total is in range. Values accept shorthand — e.g. 3m, 750k, 2.6b. Un-spied targets (shown as ??? in the Stats column) are hidden while a min/max is set, since we can’t know their stats. Use it to hide people you can’t beat, or to farm only softer targets.' },
    ],
  },
  {
    id: 'farm',
    title: 'Farm mode',
    points: [
      { term: 'What it does', desc: 'A one-click sort tuned for grinding hits — it overrides the column sort with a tiered order built for watching the hospital list. Click any column header to leave farm mode.' },
      { term: 'Priority order', desc: 'Green targets (online + Okay) float to the very top, biggest battle stats first. Then everyone else: freshly-out-of-hospital Okay targets next (most-recently released first), then whoever’s timer is about to expire (soonest out first), then the rest.' },
      { term: 'Why', desc: 'You’re always looking at the best available hit — a live green target, or the next person about to become attackable — without hunting the list yourself.' },
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
    title: 'Personal alerts (the bell)',
    points: [
      { term: 'Opening it', desc: 'The bell button opens “My War Room Alerts”. It turns blue when you have an alert on. Everything here is personal and saved to this browser — it’s not a leadership setting.' },
      { term: 'Dib hospital-exit', desc: 'Toggle On, then set a Lead time in seconds — you’ll be alerted that many seconds before a target you’ve dibbed leaves hospital, so you’re ready when they’re Okay.' },
      { term: 'Chain watch', desc: 'Toggle On, then set a Threshold in seconds — you’ll be alerted when the chain timer drops below it (and attack buttons flag red), so you can jump in for the save.' },
      { term: 'Sound & Screen flash', desc: 'Each alert has its own Sound and Screen-flash toggles, plus a “Test sound” link to preview it. Note: the browser only allows alert sounds after you’ve clicked on the page at least once.' },
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
