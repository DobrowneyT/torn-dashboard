export const config = {
  dataSource: {
    cprData: import.meta.env.VITE_CPR_DATA_URL || '',
    crimesData: import.meta.env.VITE_CRIMES_DATA_URL || '',
  },
  faction: {
    name: "Your Faction Name",
    tag: "[TAG]",
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
    1: 40, 2: 30, 3: 15, 4: 7, 5: 3, 6: 0
  },
}