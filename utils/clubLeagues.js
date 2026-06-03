const CLUB_LEAGUES = [
  {
    id: 'bronze',
    name: 'Bronze',
    order: 1,
    rewards: {
      1: { coins: 5000, gems: 10 },
      2: { coins: 3500, gems: 7 },
      3: { coins: 2500, gems: 5 },
      4: { coins: 1500, gems: 3 },
    }
  },
  {
    id: 'silver',
    name: 'Silver',
    order: 2,
    rewards: {
      1: { coins: 8000, gems: 15 },
      2: { coins: 6000, gems: 12 },
      3: { coins: 4000, gems: 8 },
      4: { coins: 2500, gems: 5 },
    }
  },
  {
    id: 'gold',
    name: 'Gold',
    order: 3,
    rewards: {
      1: { coins: 12000, gems: 25 },
      2: { coins: 9000, gems: 18 },
      3: { coins: 6000, gems: 12 },
      4: { coins: 4000, gems: 8 },
    }
  },
  {
    id: 'platinum',
    name: 'Platinum',
    order: 4,
    rewards: {
      1: { coins: 18000, gems: 35 },
      2: { coins: 13000, gems: 25 },
      3: { coins: 9000, gems: 18 },
      4: { coins: 6000, gems: 12 },
    }
  },
  {
    id: 'diamond',
    name: 'Diamond',
    order: 5,
    rewards: {
      1: { coins: 25000, gems: 50 },
      2: { coins: 18000, gems: 35 },
      3: { coins: 12000, gems: 25 },
      4: { coins: 8000, gems: 15 },
    }
  },
  {
    id: 'rookie',
    name: 'Rookie',
    order: 6,
    rewards: {
      1: { coins: 30000, gems: 60 },
      2: { coins: 22000, gems: 45 },
      3: { coins: 15000, gems: 30 },
      4: { coins: 10000, gems: 20 },
    }
  },
  {
    id: 'pro',
    name: 'Pro',
    order: 7,
    rewards: {
      1: { coins: 40000, gems: 80 },
      2: { coins: 30000, gems: 60 },
      3: { coins: 20000, gems: 40 },
      4: { coins: 14000, gems: 25 },
    }
  },
  {
    id: 'elite',
    name: 'Elite',
    order: 8,
    rewards: {
      1: { coins: 55000, gems: 110 },
      2: { coins: 40000, gems: 80 },
      3: { coins: 28000, gems: 55 },
      4: { coins: 18000, gems: 35 },
    }
  },
  {
    id: 'supreme',
    name: 'Supreme',
    order: 9,
    rewards: {
      1: { coins: 70000, gems: 140 },
      2: { coins: 52000, gems: 100 },
      3: { coins: 35000, gems: 70 },
      4: { coins: 24000, gems: 45 },
    }
  },
  {
    id: 'titan',
    name: 'Titan',
    order: 10,
    rewards: {
      1: { coins: 90000, gems: 180 },
      2: { coins: 65000, gems: 130 },
      3: { coins: 45000, gems: 90 },
      4: { coins: 30000, gems: 60 },
    }
  },
  {
    id: 'royal',
    name: 'Royal',
    order: 11,
    rewards: {
      1: { coins: 115000, gems: 230 },
      2: { coins: 85000, gems: 170 },
      3: { coins: 58000, gems: 115 },
      4: { coins: 38000, gems: 75 },
    }
  },
  {
    id: 'imperial',
    name: 'Imperial',
    order: 12,
    rewards: {
      1: { coins: 145000, gems: 290 },
      2: { coins: 105000, gems: 210 },
      3: { coins: 72000, gems: 145 },
      4: { coins: 48000, gems: 95 },
    }
  },
  {
    id: 'mythic',
    name: 'Mythic',
    order: 13,
    rewards: {
      1: { coins: 180000, gems: 360 },
      2: { coins: 130000, gems: 260 },
      3: { coins: 90000, gems: 180 },
      4: { coins: 60000, gems: 120 },
    }
  },
  {
    id: 'legendary',
    name: 'Legendary',
    order: 14,
    rewards: {
      1: { coins: 220000, gems: 440 },
      2: { coins: 160000, gems: 320 },
      3: { coins: 110000, gems: 220 },
      4: { coins: 72000, gems: 145 },
    }
  },
  {
    id: 'throne',
    name: 'Throne',
    order: 15,
    rewards: {
      1: { coins: 270000, gems: 540 },
      2: { coins: 195000, gems: 390 },
      3: { coins: 135000, gems: 270 },
      4: { coins: 90000, gems: 180 },
    }
  },
  {
    id: 'crown',
    name: 'Crown',
    order: 16,
    rewards: {
      1: { coins: 325000, gems: 650 },
      2: { coins: 235000, gems: 470 },
      3: { coins: 160000, gems: 325 },
      4: { coins: 105000, gems: 210 },
    }
  },
  {
    id: 'master',
    name: 'Master',
    order: 17,
    rewards: {
      1: { coins: 390000, gems: 780 },
      2: { coins: 280000, gems: 560 },
      3: { coins: 190000, gems: 390 },
      4: { coins: 125000, gems: 250 },
    }
  },
  {
    id: 'grandmaster',
    name: 'Grandmaster',
    order: 18,
    rewards: {
      1: { coins: 470000, gems: 940 },
      2: { coins: 340000, gems: 680 },
      3: { coins: 230000, gems: 470 },
      4: { coins: 150000, gems: 300 },
    }
  },
  {
    id: 'champion',
    name: 'Champion',
    order: 19,
    rewards: {
      1: { coins: 565000, gems: 1130 },
      2: { coins: 410000, gems: 820 },
      3: { coins: 280000, gems: 565 },
      4: { coins: 185000, gems: 370 },
    }
  },
  {
    id: 'legend',
    name: 'Legend',
    order: 20,
    rewards: {
      1: { coins: 820000, gems: 1650 },
      2: { coins: 590000, gems: 1180 },
      3: { coins: 400000, gems: 820 },
      4: { coins: 265000, gems: 530 },
    }
  }
];

module.exports = CLUB_LEAGUES;
