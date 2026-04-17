export const config = {
  supabase: {
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    serviceKey: import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY,
  },
  torn: {
    apiKey: import.meta.env.VITE_TORN_API_KEY,
  },
  faction: {
    name: "The Next Level - Forge",
    tag: "TNL-F",
    id: import.meta.env.VITE_FACTION_ID || "10739",
  },

  adminsUserIds: [
    '2250591', // MonChoon
    '2932241', // Marnix0126
  ],

  leadershipUserIds: [
    '2250591', // MonChoon
    '2749598', // Uncensored
    '2264192', // McGummy
    '2407528', // DiabolicPickles
    '2736995', // CleverGirl
    '2932241', // Marnix0126
    '2015160', // Andrew_616
  ],

  // Reward items whose value should be taken from sell_price (items table)
  // instead of the live Torn market price. Use for items that can only be
  // sold back to the system (e.g. item 1508).
  useSellPriceItemIds: [
    1508,
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

  // CPR pass-rate requirements per crime position (from faction CPR requirements sheet)
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
      { crime: "Honey Trap", role: "Muscle", minCpr: 75 }
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
}

export function isAdmin(userId) {
  return config.adminsUserIds.includes(String(userId))
}

export function isLeader(userId) {
  return config.leadershipUserIds.includes(String(userId))
}