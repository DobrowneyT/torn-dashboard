export const config = {
  dataSource: {
    cprData: import.meta.env.VITE_CPR_DATA_URL || '/torn-forge-oc-system/data/cpr_database.json',
    crimesData: import.meta.env.VITE_CRIMES_DATA_URL || '/torn-forge-oc-system/data/crimes_database.json',
  },
  faction: {
    name: "The Next Level - Forge",
    tag: "[TAG]",
    id: import.meta.env.VITE_FACTION_ID || "46427",
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
  ],
  // Inventory categories for organizing faction items
  inventoryCategories: {
    crimes: {
      label: "Crime Items",
      description: "Items consumed during organized crimes",
      color: "red",
      icon: "🎯"
    },
    medical: {
      label: "Medical Supplies",
      description: "Free medical items available for faction members",
      color: "green",
      icon: "💊"
    },
    drugs: {
      label: "Drugs & Boosters",
      description: "Free drugs and boosters for faction members",
      color: "purple",
      icon: "💉"
    },
    equipment: {
      label: "Equipment",
      description: "Weapons, armor, and other equipment",
      color: "blue",
      icon: "⚔️"
    },
    other: {
      label: "Other Items",
      description: "Miscellaneous items",
      color: "gray",
      icon: "📦"
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