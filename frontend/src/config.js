export const config = {
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    // SECURITY: never reference the service_role key here. Everything under
    // `config` is imported by the browser bundle, so any VITE_ var read in this
    // file is inlined by `vite build` and shipped to every visitor. The
    // service_role key bypasses RLS entirely — it lives ONLY in server-side env
    // (Edge Function secrets + the sync-items maintenance script), never on the
    // client. See scripts/sync-items.mjs.
  },
  // SECURITY: no shared/personal Torn API key on the client. The only Torn key
  // the browser should ever hold is the logged-in user's own Limited key,
  // captured at login as `user.apiKey`. Server-side jobs read TORN_API_KEY from
  // env (a non-VITE name so it can't be inlined into the bundle).
  faction: {
    name: "The Next Level - Forge",
    tag: "TNL-F",
    id: import.meta.env.VITE_FACTION_ID || "10739",
  },

  // 2.0: a single consolidated key per member, captured via mandatory opt-in at
  // login. Limited Access (level 3) covers every selection the site needs
  // (user: profile/personalstats/crimes, faction: crimes/members/chain/attacks/
  // rankedwars). Bump consentVersion to force everyone to re-accept the ToS.
  apiKey: {
    title: 'Forge-Dashboard',     // shows up as the key name in Torn
    requiredLevel: 3,             // Torn access.level for Limited Access
    consentVersion: '2.0',        // bump to re-prompt the disclosure
  },

  adminsUserIds: [
    '2250591', // MonChoon
  ],

  // Read-only demo access for leaders of the other TNL family factions.
  // Visitors bypass the faction-membership check at login, see everything
  // leadership sees (Data Management excluded), and can run the full OC/RW
  // payout flows — but every save/write is disabled. Their API key is used
  // for identity + session-token minting ONLY and is never stored in
  // member_secrets or the rotation pool. IDs here must also be mirrored in
  // VISITOR_IDS inside supabase/functions/war-room-fetch (JWT mint + RLS).
  // Cleared for the multi-faction distribution: visitors are granted per
  // faction via role_assignments (Settings page), not a shipped list.
  visitorUserIds: [],

  leadershipUserIds: [
    '2250591', // MonChoon
    '2749598', // Uncensored
    '2264192', // McGummy
    '2407528', // DiabolicPickles
    // '2736995', // CleverGirl
    '2932241', // Marnix0126
    // '2015160', // Andrew_616
  ],

  warleadUserIds: [
    '2250591', // MonChoon
    '2749598', // Uncensored
    '2264192', // McGummy
    '2407528', // DiabolicPickles
    '2932241', // Marnix0126
    `873341`, // Goosey
    `2478585`, // Gekents
    `2642228`, // FLY
    `1712182`, // Muttley
    `3058543`, // Gank
  ],

  ocmanagerUserIds: [
    '2250591', // MonChoon
    '2749598', // Uncensored
    '2932241', // Marnix0126
    `2214797`, // Onyx
    `3074032`, // Josiah
  ],

  crimeItemIds: [
    66, 67, 68, 69, 70, 71, 72, 74, 159, 213, 568, 579, 981, 1080, 1203,
    1258, 1284, 1331, 1350, 1362, 1380, 1383, 73, 103, 158, 172, 188, 190,
    201, 222, 226, 256, 567, 576, 643, 856, 1012, 1094, 1223, 1230, 884, 1361,
    1379, 1381, 1429, 1430, 1461, 1431
  ],

  inventoryCategories: {
    crimes: {
      label: "Crime Items",
      description: "Items consumed during organized crimes (filter view)",
      color: "red",
      isPseudoCategory: true
    },
    medical: { label: "Medical", description: "Medical items", color: "green" },
    drugs: { label: "Drugs", description: "Drugs and boosters", color: "purple" },
    weapons: { label: "Weapons", description: "Weapons and ammunition", color: "red" },
    armor: { label: "Armor", description: "Armor and protective gear", color: "blue" },
    temporary: { label: "Temporary", description: "Temporary items (grenades, etc)", color: "orange" },
    utilities: { label: "Utilities", description: "Tools and utility items", color: "gray" },
    caches: { label: "Caches", description: "Item caches", color: "yellow" },
    cesium: { label: "Cesium", description: "Cesium items", color: "cyan" }
  },

  // CPR requirements per crime position
  // Also update https://docs.google.com/spreadsheets/d/1jGUqs4mLJzFWidWFO1AGVztcdY3o2JLo6OrDsI24J10/edit?usp=sharing
  // script is `cpr_requirements.gs` the Object is `CPR_REQUIREMENTS`
  // then run CPR Requirements -> Write Requirements to Sheet
  cprRequirements: {
    "Blast from the Past": {
      difficulty: 7,
      positions: {
        "Bomber": 75, "Engineer": 75, "Hacker": 70,
        "Muscle": 75, "Picklock #1": 70, "Picklock #2": 70
      }
    },
    "Break the Bank": {
      difficulty: 8,
      positions: {
        "Robber": 60, "Thief #1": 50, "Thief #2": 65,
        "Muscle #1": 60, "Muscle #2": 60, "Muscle #3": 65
      }
    },
    "Stacking the Deck": {
      difficulty: 8,
      positions: {
        "Cat Burglar": 68, "Driver": 50, "Imitator": 68, "Hacker": 68
      }
    },
    "Ace in the Hole": {
      difficulty: 8,
      positions: {
        "Hacker": 63, "Driver": 53, "Imitator": 63,
        "Muscle #1": 63, "Muscle #2": 63
      }
    },
    "Clinical Precision": {
      difficulty: 8,
      positions: {
        "Cat Burglar": 67, "Cleaner": 67, "Imitator": 70, "Assassin": 67
      }
    },
    "Bidding War": {
      difficulty: 6,
      positions: {
        "Driver": 75, "Robber #1": 70, "Robber #2": 75,
        "Robber #3": 75, "Bomber #1": 70, "Bomber #2": 75
      }
    },
    "Honey Trap": {
      difficulty: 6,
      positions: {
        "Muscle": 75, "Enforcer": 75
      }
    },
  },

  // Tier qualification requirements — each entry references a specific crime + position.
  // 2/3 rule: member must meet ceil(2/3 * requirements.length) to qualify.
  tierRequirements: {
    1: [
      { crime: "Clinical Precision", role: "Imitator", minCpr: 70 },
      { crime: "Break the Bank", role: "Muscle #3", minCpr: 65 },
      { crime: "Break the Bank", role: "Thief #2", minCpr: 65 }
    ],
    2: [
      { crime: "Break the Bank", role: "Muscle #1", minCpr: 60 },
      { crime: "Break the Bank", role: "Robber", minCpr: 60 },
      { crime: "Clinical Precision", role: "Assassin", minCpr: 67 },
      { crime: "Clinical Precision", role: "Cat Burglar", minCpr: 67 },
      { crime: "Clinical Precision", role: "Cleaner", minCpr: 67 },
      { crime: "Blast from the Past", role: "Muscle", minCpr: 75 },
      { crime: "Blast from the Past", role: "Engineer", minCpr: 75 },
      { crime: "Blast from the Past", role: "Bomber", minCpr: 75 }
    ],
    3: [
      { crime: "Blast from the Past", role: "Hacker", minCpr: 70 },
      { crime: "Blast from the Past", role: "Picklock #1", minCpr: 70 },
      { crime: "Bidding War", role: "Bomber #2", minCpr: 75 },
      { crime: "Bidding War", role: "Driver", minCpr: 75 },
      { crime: "Bidding War", role: "Robber #2", minCpr: 75 }
    ],
    4: [
      { crime: "Bidding War", role: "Bomber #1", minCpr: 70 },
      { crime: "Bidding War", role: "Robber #1", minCpr: 70 },
      { crime: "Honey Trap", role: "Enforcer", minCpr: 75 },
      { crime: "Honey Trap", role: "Muscle #1", minCpr: 75 }
    ],
    5: [
      { level: 5, role: "Average", minCpr: 75, isAverage: true }
    ],
    6: [
      { level: 4, role: "Average", minCpr: 75, isAverage: true }
    ]
  },

  payoutTickets: {
    1: 40, 2: 30, 3: 15, 4: 7, 5: 3, 6: 2
  },

  // @deprecated — superseded by ocScenarios/ocCategories (the OC Planner now
  // plans whole scenarios per difficulty category, not per-tier slots).
  ocTierByCrime: {},

  // OC 2.0 difficulty categories (the "scenario types" a faction can spawn).
  // The faction spawns a RANDOM scenario within a chosen category, each costing
  // Scope (regens +1/day, caps at 100). `plannable` flags the categories we
  // actually run — the OC Planner only recommends spawns for these.
  ocCategories: {
    introductory: { label: 'Introductory', short: 'Intro',  difficulty: [1, 2],  scopeCost: 1, plannable: false },
    simple:       { label: 'Simple',       short: 'Simple', difficulty: [3, 4],  scopeCost: 2, plannable: true  },
    intermediate: { label: 'Intermediate', short: 'Inter',  difficulty: [5, 6],  scopeCost: 3, plannable: true  },
    advanced:     { label: 'Advanced',     short: 'Adv',    difficulty: [7, 8],  scopeCost: 4, plannable: true  },
    elaborate:    { label: 'Elaborate',    short: 'Elab',   difficulty: [8, 10], scopeCost: 5, plannable: false },
  },

  // Known OC 2.0 scenarios → { category, difficulty, participants }. Category is
  // resolved by NAME first (difficulty 8 spans both Advanced and Elaborate, so
  // name is authoritative); difficulty is only a fallback for unknown names.
  // participants = full crew size (shown for reference; does not size spawns).
  // Source: Torn user wiki (OCs 2.0 scenario list).
  ocScenarios: {
    // Introductory (Lv1-2)
    'First Aid and Abet':      { category: 'introductory', difficulty: 1, participants: 3 },
    'Mob Mentality':           { category: 'introductory', difficulty: 1, participants: 4 },
    'Pet Project':             { category: 'introductory', difficulty: 1, participants: 3 },
    'Thou Shalt Not Steal':    { category: 'introductory', difficulty: 2, participants: 3 },
    'Cash Me If You Can':      { category: 'introductory', difficulty: 2, participants: 3 },
    'Best of the Lot':         { category: 'introductory', difficulty: 2, participants: 4 },
    // Simple (Lv3-4)
    'Smoke and Wing Mirrors':  { category: 'simple', difficulty: 3, participants: 4 },
    'Market Forces':           { category: 'simple', difficulty: 3, participants: 5 },
    'Gaslight the Way':        { category: 'simple', difficulty: 3, participants: 6 },
    'Snow Blind':              { category: 'simple', difficulty: 4, participants: 4 },
    'Plucking the Lotus Petal':{ category: 'simple', difficulty: 4, participants: 4 },
    'Stage Fright':            { category: 'simple', difficulty: 4, participants: 6 },
    // Intermediate (Lv5-6)
    'Guardian Angels':         { category: 'intermediate', difficulty: 5, participants: 3 },
    'Counter Offer':           { category: 'intermediate', difficulty: 5, participants: 5 },
    'No Reserve':              { category: 'intermediate', difficulty: 5, participants: 3 },
    'Honey Trap':              { category: 'intermediate', difficulty: 5, participants: 3 },
    'Bidding War':             { category: 'intermediate', difficulty: 6, participants: 6 },
    'Leave No Trace':          { category: 'intermediate', difficulty: 6, participants: 3 },
    'Dish It Out':             { category: 'intermediate', difficulty: 6, participants: 5 },
    'Sneaky Git Grab':         { category: 'intermediate', difficulty: 6, participants: 4 },
    // Advanced (Lv7-8)
    'Blast from the Past':     { category: 'advanced', difficulty: 7, participants: 6 },
    'Window of Opportunity':   { category: 'advanced', difficulty: 7, participants: 5 },
    'Break the Bank':          { category: 'advanced', difficulty: 8, participants: 6 },
    'Clinical Precision':      { category: 'advanced', difficulty: 8, participants: 4 },
    // Elaborate (Lv8-10)
    'Stacking the Deck':       { category: 'elaborate', difficulty: 8,  participants: 4 },
    'Manifest Cruelty':        { category: 'elaborate', difficulty: 8,  participants: 4 },
    'Ace in the Hole':         { category: 'elaborate', difficulty: 9,  participants: 5 },
    'Gone Fission':            { category: 'elaborate', difficulty: 9,  participants: 5 },
    'Crane Reaction':          { category: 'elaborate', difficulty: 10, participants: 6 },
  },
}

// One-click Torn link that generates a correctly-titled Limited Access key
// (type=3). Shown in the login opt-in disclosure so members don't have to
// hand-pick selections. See Torn's "addNewKey" preferences deep-link.
// `title` defaults to the static legacy-mode value; API-mode callers pass
// the tenant-branded title from factionIdentity's getApiKeyTitle() (#131).
export function tornKeyGenUrl(title = config.apiKey.title) {
  const encoded = encodeURIComponent(title)
  return `https://www.torn.com/preferences.php#tab=api?&step=addNewKey&title=${encoded}&type=3`
}

export function isAdmin(userId) {
  return config.adminsUserIds.includes(String(userId))
}

export function isLeader(userId) {
  return config.leadershipUserIds.includes(String(userId))
}

export function isWarLead(userId) {
  return config.warleadUserIds.includes(String(userId))
}

export function isOCManager(userId) {
  return config.ocmanagerUserIds.includes(String(userId))
}

export function isVisitor(userId) {
  return config.visitorUserIds.includes(String(userId))
}