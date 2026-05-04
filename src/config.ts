import type { FoodDef, FoodId, LevelDef } from './types';

export interface OrderDef {
  name: string;
  items: FoodId[];
  points: number;
  weight: number;
  hasPork: boolean;
}

export const FOOD: Map<FoodId, FoodDef> = new Map([
  ['raw_patty',  { id: 'raw_patty',  name: 'Raw Patty',       color: '#8b4513', isRaw: true,  cookTime: 15000, burnTime: 6250,  station: 'grill',  rawOf: 'patty',      cost: 125 }],
  ['raw_hotdog', { id: 'raw_hotdog', name: 'Raw Hot Dog',      color: '#c0392b', isRaw: true,  cookTime: 7500,  burnTime: 5000,  station: 'grill',  rawOf: 'hotdog',     cost: 100 }],
  ['raw_fries',  { id: 'raw_fries',  name: 'Raw Fries', color: '#e8e8c0', isRaw: true,  cookTime: 7500,  burnTime: 3750, station: 'fryer', rawOf: 'fries', cost: 100 }],
  ['raw_rings',  { id: 'raw_rings',  name: 'Raw Pups',  color: '#d4c890', isRaw: true,  cookTime: 5000,  burnTime: 3750, station: 'fryer', rawOf: 'rings', cost: 100 }],
  ['raw_pork',   { id: 'raw_pork',   name: 'Raw Pork',         color: '#e8b4b8', isRaw: true,  cookTime: 25000, burnTime: 12500, station: 'smoker', rawOf: 'whole_pork', cost: 700 }],
  ['patty',      { id: 'patty',      name: 'Patty',            color: '#5c3317', isRaw: false, cookTime: 10000, burnTime: 6250,  station: 'grill',  cookedFrom: 'raw_patty'  }],
  ['hotdog',     { id: 'hotdog',     name: 'Hot Dog',          color: '#a03020', isRaw: false, cookTime: 6250,  burnTime: 5000,  station: 'grill',  cookedFrom: 'raw_hotdog' }],
  ['fries',    { id: 'fries',    name: 'Fries',    color: '#f0c040', isRaw: false, cookTime: 7500,  burnTime: 3750,  station: 'fryer', cookedFrom: 'raw_fries' }],
  ['fries_lg', { id: 'fries_lg', name: 'Lg Fries', color: '#f8d060', isRaw: false, cookTime: 0,     burnTime: 0,     station: 'fryer' }],
  ['rings',    { id: 'rings',    name: 'Pups',     color: '#e8a030', isRaw: false, cookTime: 10000, burnTime: 3750,  station: 'fryer', cookedFrom: 'raw_rings'  }],
  ['rings_lg', { id: 'rings_lg', name: 'Lg Pups',  color: '#f0b848', isRaw: false, cookTime: 0,     burnTime: 0,     station: 'fryer' }],
  ['whole_pork', { id: 'whole_pork', name: 'Whole Smoked Pork', color: '#b06050', isRaw: false, cookTime: 0,    burnTime: 0,    station: 'chop',  cookedFrom: 'raw_pork'         }],
  ['pork',       { id: 'pork',       name: 'Pulled Pork',      color: '#c8806a', isRaw: false, cookTime: 0,    burnTime: 0,    station: 'chop',  cookedFrom: 'whole_pork'       }],
  ['cheese',           { id: 'cheese',           name: 'Cheese',        color: '#f8c030', isRaw: false, cookTime: 0,    burnTime: 0,    station: 'grill', cost: 25              }],
  ['raw_cheese_patty', { id: 'raw_cheese_patty', name: 'Melting Patty', color: '#d4a020', isRaw: true,  cookTime: 1875, burnTime: 5000, station: 'grill', rawOf: 'cheese_patty'  }],
  ['cheese_patty',     { id: 'cheese_patty',     name: 'Cheese Patty',  color: '#c89818', isRaw: false, cookTime: 3750, burnTime: 5000, station: 'grill', cookedFrom: 'raw_cheese_patty' }],
]);

// ─── Order definitions ────────────────────────────────────────────────────────

const SIDES: { label: string; food: FoodId; pts: number; weight: number }[] = [
  { label: 'Sm Fry', food: 'fries',    pts: 1, weight: 4 },
  { label: 'Lg Fry', food: 'fries_lg', pts: 2, weight: 3 },
  { label: 'Sm Pup', food: 'rings',    pts: 1, weight: 2 },
  { label: 'Lg Pup', food: 'rings_lg', pts: 2, weight: 1 },
];

const SANDWICHES: { name: string; items: FoodId[]; pts: number; comboW: number; hasPork: boolean }[] = [
  { name: 'Hamburger',        items: ['patty'],                              pts: 2, comboW: 1, hasPork: false },
  { name: 'Cheeseburger',     items: ['cheese_patty'],                       pts: 2, comboW: 4, hasPork: false },
  { name: 'Dbl Burger',       items: ['patty',       'patty'],               pts: 4, comboW: 1, hasPork: false },
  { name: 'Dbl Cheeseburger', items: ['cheese_patty','cheese_patty'],        pts: 4, comboW: 2, hasPork: false },
  { name: 'BBQ Sand.',        items: ['pork'],                               pts: 2, comboW: 7, hasPork: true  },
  { name: 'Hotdog',           items: ['hotdog'],                             pts: 2, comboW: 5, hasPork: false },
];

export const ORDER_DEFS: OrderDef[] = [
  // Standalone items
  { name: 'Hamburger',        items: ['patty'],                         points: 2, weight:  1, hasPork: false },
  { name: 'Cheeseburger',     items: ['cheese_patty'],                  points: 2, weight:  3, hasPork: false },
  { name: 'Dbl Burger',       items: ['patty',       'patty'],          points: 4, weight:  1, hasPork: false },
  { name: 'Dbl Cheeseburger', items: ['cheese_patty','cheese_patty'],   points: 4, weight:  2, hasPork: false },
  { name: 'BBQ Sand.',        items: ['pork'],                          points: 2, weight:  4, hasPork: true  },
  { name: 'BBQ Plate',        items: ['pork','pork','fries','rings'],   points: 3, weight: 10, hasPork: true  },
  { name: 'Hotdog',           items: ['hotdog'],                        points: 2, weight:  5, hasPork: false },
  { name: 'Sm Fry',           items: ['fries'],                         points: 1, weight:  3, hasPork: false },
  { name: 'Lg Fry',           items: ['fries_lg'],                      points: 2, weight:  2, hasPork: false },
  { name: 'Sm Pup',           items: ['rings'],                         points: 1, weight:  2, hasPork: false },
  { name: 'Lg Pup',           items: ['rings_lg'],                      points: 2, weight:  1, hasPork: false },
  // Combos: each sandwich × each side
  ...SANDWICHES.flatMap(s =>
    SIDES.map(side => ({
      name:     `${s.name}+${side.label}`,
      items:    [...s.items, side.food] as FoodId[],
      points:   s.pts + side.pts,
      weight:   s.comboW * side.weight,
      hasPork:  s.hasPork,
    }))
  ),
];

export const ORDERS: Record<string, FoodId[]> = Object.fromEntries(
  ORDER_DEFS.map(o => [o.name, o.items])
);

export const LEVEL_DURATION = 180000;

const LEVEL_NAMES = [
  'Soft Open', 'Lunch Rush', 'Dinner Crowd', 'Friday Night', 'BBQ Festival',
  'Second Shift', 'Saturday Night', 'Pit Boss', 'Smoke Storm', 'BBQ Legend',
];
const MAX_ACTIVE = [3, 3, 4, 4, 5, 5, 5, 6, 6, 6];

const ORDER_AVG_MS = [30000, 25000, 20000, 15000, 10000, 7500, 5000, 3000, 2000, 1000];

export const LEVELS: LevelDef[] = Array.from({ length: 10 }, (_, i) => {
  const base = ORDER_AVG_MS[i];
  return {
    n:                i + 1,
    name:             LEVEL_NAMES[i],
    duration:         LEVEL_DURATION,
    orderIntervalMin: Math.round(base * 0.8),
    orderIntervalMax: Math.round(base * 1.2),
    maxActiveOrders:  MAX_ACTIVE[i],
    orderTimeLimit:   60000,
  };
});

const ITEM_PRICES: Record<string, number> = {
  'Hamburger':        500,
  'Cheeseburger':     600,
  'Dbl Burger':       850,
  'Dbl Cheeseburger': 1000,
  'BBQ Sand.':        700,
  'BBQ Plate':        1200,
  'Hotdog':           400,
  'Sm Fry':           300,
  'Lg Fry':           500,
  'Sm Pup':           300,
  'Lg Pup':           500,
};

const COMBO_BASE_PRICES: Record<string, number> = {
  'Hamburger':        700,
  'Cheeseburger':     800,
  'Dbl Burger':       1050,
  'Dbl Cheeseburger': 1200,
  'BBQ Sand.':        900,
  'Hotdog':           600,
};

const LG_SIDE_UPCHARGE = 150;

export const MEAL_PRICES: Record<string, number> = {
  ...ITEM_PRICES,
  ...Object.fromEntries(
    SANDWICHES.flatMap(s =>
      SIDES.map(side => [
        `${s.name}+${side.label}`,
        (COMBO_BASE_PRICES[s.name] ?? 0) + (side.label.startsWith('Lg') ? LG_SIDE_UPCHARGE : 0),
      ])
    )
  ),
};

export const PARTIAL_SPOIL_TIME    = 50000;
export const STAGED_SPOIL_TIME     = 75000;
export const LABOR_RATE            = 10;   // cents/sec during prep + play ($0.10/s)
export const OVERTIME_LABOR_RATE   = 15;   // cents/sec during overtime ($0.15/s)
export const OVERHEAD_COST         = 2000; // $20 overhead deducted at end of each level
export const STARTING_MONEY        = 5000; // $50 starting cash
export const BASE_MAX_FAILS        = 3;
export const UPSET_THRESHOLDS      = Array.from({ length: 20 }, (_, i) => (i + 1) * 10000); // $100, $200, $300 ... $2000
export const PLAYER_SPEED  = 330;
export const INTERACT_RANGE = 30;
