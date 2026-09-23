export const CONFIG = {
  start: { lat: 50.865895697309, lng: 3.273473649981 },
  worldBounds: { south: -60, west: -180, north: 75, east: 180 },
  cellMeters: 42,
  territoryLinkMeters: 900,
  revealCells: 2,
  simulationStepCells: 1,
  interactionMeters: 360,
  claimMeters: 130,
  maxGpsMetersPerSecond: 12,
  rewards: { discoverXp: 2, discoverTokens: 1, claimXp: 3, claimTokens: 2, checkpointXp: 40, checkpointTokens: 35, battleXp: 55, battleTokens: 45 },
  battleTickMs: 440,
  freeMinionMinutes: 20,
  offlineFreeMinionCap: 5,
  farmCost: 90,
  trainingCampCost: 120,
  farmerCost: 45,
  trainerCost: 65,
  foodPerFarmer: 3,
  starvationGraceHours: 72,
  trainingMinutes: 30,
  checkpointLevels: [
    { hp: 140, defense: 2, minionBonus: 0, rewardBonus: 1, cost: 0, slots: 6 },
    { hp: 190, defense: 4, minionBonus: 1, rewardBonus: 1.15, cost: 60, slots: 7 },
    { hp: 260, defense: 6, minionBonus: 2, rewardBonus: 1.3, cost: 100, slots: 8 },
    { hp: 340, defense: 9, minionBonus: 4, rewardBonus: 1.5, cost: 160, slots: 9 },
    { hp: 450, defense: 13, minionBonus: 6, rewardBonus: 1.75, cost: 250, slots: 10 }
  ],
  summonCosts: { standard: 55, wizard: 90, hexer: 90, beast: 150 }
} as const;

export const COLORS = { player: '#35c9a5', ember: '#f07861', violet: '#a987e9', neutral: '#e8c778' };
