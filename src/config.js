export const config = {
  dataSource: {
    cprData: import.meta.env.VITE_CPR_DATA_URL || '/torn-forge-oc-system/data/cpr_database.json',
    crimesData: import.meta.env.VITE_CRIMES_DATA_URL || '/torn-forge-oc-system/data/crimes_database.json',
  },
  faction: {
    name: "The Next Level - Forge",
    tag: "TNL-F",
    id: import.meta.env.VITE_FACTION_ID || "10739",
  },
  // Custom leadership list - add Torn user IDs of users who should have leadership access
  // These users will have access to Payout Management, Tier Management, and Inventory Management
  // regardless of their official faction position
  leadershipUserIds: [
    2250591, // MonChoon
    2749598, // Uncensored
    2264192, // McGummy
    2407528, // DiabolicPickles
    2932241, // Marnix0126
    2015160, // Andrew_616
  ],
  // Crime items that are consumed during organized crimes
  crimeItemIds: [
    66, 67, 68, 69, 70, 71, 72, 74, 159, 213, 568, 579, 981, 1080, 1203,
    1258, 1284, 1331, 1350, 1362, 1380, 1383, 73, 103, 158, 172, 188, 190,
    201, 222, 226, 256, 567, 576, 643, 856, 1012, 1094, 1223, 1230, 884, 1361,
    1379, 1381, 1429, 1430, 1461, 1431
  ],
  // Inventory categories - these match API categories
  inventoryCategories: {
    crimes: {
      label: "Crime Items",
      description: "Items consumed during organized crimes (filter view)",
      color: "red",
      isPseudoCategory: true // Special filter category, not a real item type
    },
    medical: {
      label: "Medical",
      description: "Medical items",
      color: "green"
    },
    drugs: {
      label: "Drugs",
      description: "Drugs and boosters",
      color: "purple"
    },
    weapons: {
      label: "Weapons",
      description: "Weapons and ammunition",
      color: "red"
    },
    armor: {
      label: "Armor",
      description: "Armor and protective gear",
      color: "blue"
    },
    temporary: {
      label: "Temporary",
      description: "Temporary items (grenades, etc)",
      color: "orange"
    },
    utilities: {
      label: "Utilities",
      description: "Tools and utility items",
      color: "gray"
    },
    caches: {
      label: "Caches",
      description: "Item caches",
      color: "yellow"
    },
    cesium: {
      label: "Cesium",
      description: "Cesium items",
      color: "cyan"
    }
  },
  tierRequirements: {
    1: [
      { level: 8, role: "Imitator", minCpr: 70 },
      { level: 8, role: "Muscle", minCpr: 65 },
      { level: 8, role: "Thief", minCpr: 65 }
    ],
    2: [
      { level: 8, role: "Muscle", minCpr: 60 },
      { level: 8, role: "Robber", minCpr: 60 },
      { level: 8, role: "Assassin", minCpr: 67 },
      { level: 8, role: "Cat Burglar", minCpr: 67 },
      { level: 8, role: "Cleaner", minCpr: 67 },
      { level: 7, role: "Muscle", minCpr: 75 },
      { level: 7, role: "Engineer", minCpr: 75 },
      { level: 7, role: "Bomber", minCpr: 75 }
    ],
    3: [
      { level: 7, role: "Hacker", minCpr: 70 },
      { level: 7, role: "Picklock", minCpr: 70 },
      { level: 6, role: "Bomber", minCpr: 75 },
      { level: 6, role: "Driver", minCpr: 75 },
      { level: 6, role: "Robber", minCpr: 75 }
    ],
    4: [
      { level: 6, role: "Bomber", minCpr: 70 },
      { level: 6, role: "Robber", minCpr: 70 },
      { level: 6, role: "Enforcer", minCpr: 75 },
      { level: 6, role: "Muscle", minCpr: 75 }
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