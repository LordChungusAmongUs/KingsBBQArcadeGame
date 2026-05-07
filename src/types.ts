export type FoodId =
  | 'raw_patty' | 'raw_hotdog'
  | 'raw_fries' | 'raw_rings' | 'raw_pork'
  | 'patty'     | 'hotdog'
  | 'fries'     | 'fries_lg' | 'rings' | 'rings_lg' | 'whole_pork' | 'pork'
  | 'cheese'    | 'raw_cheese_patty' | 'cheese_patty';

export type StationKind = 'supply' | 'cooler' | 'freezer' | 'grill' | 'fryer' | 'smoker' | 'chop' | 'prep' | 'counter' | 'trash' | 'warmer';

export interface CookSlot {
  food: FoodId | null;
  timer: number;
  state: 'empty' | 'cooking' | 'ready' | 'burned';
  smokerPlacedLevel?: number;
  smokerPlacedAtTimer?: number;
  smokerPlacedDuringPrep?: boolean; // true → compare against prepTimer, false/absent → levelTimer
}

export interface Station {
  id: string;
  kind: StationKind;
  x: number; y: number; w: number; h: number;
  label: string;
  color: string;
  slots: CookSlot[];
  slotRows?: number;   // rows for multi-row cook station grids (default 1)
  produces?: FoodId;   // supply stations
  menu?: FoodId[];     // cooler / freezer item list
}

export interface OrderItem {
  food: FoodId;
  done: boolean;
}

export interface Order {
  id: number;
  name: string;
  items: OrderItem[];
  timeLimit: number;
  elapsed: number;
  status: 'active' | 'plating' | 'failed';
  spoilTimer: number;  // ms since first partial item placed; resets done flags when it expires
  burnedCount: number; // overcooked items added to this order (each costs 50%/totalItems)
}

export interface HeldItem {
  food: FoodId;
  count: number;
  burned: boolean;
}

export interface Player {
  x: number; y: number;
  vx: number; vy: number;
  held: HeldItem | null;
  radius: number;
  facing: number;
  walkFrame: number;
}

export interface Plate {
  orderId: number;
  name: string;
  spoilTimer: number;
}

export interface StagedItem {
  food: FoodId;
  spoilTimer: number;
  spoiled: boolean;
  count: number;   // uses remaining (fries/rings start at 2, others at 1)
}

export interface GameState {
  player: Player;
  stations: Station[];
  orders: Order[];
  plates: Plate[];       // completed plates sitting on prep table
  staged: StagedItem[];  // pre-cooked items waiting on prep table
  score: number;
  level: number;
  levelTimer: number;
  nextOrderIn: number;
  completed: number;
  failed: number;
  phase: 'playing' | 'level_end' | 'game_over';
  levelEndTimer: number;
  prepTimer: number;
  laborAccum: number;
  chopStored: number;     // whole_pork pieces sitting on chop table (0 or 1)
  chopProgress: number;   // ms into 2000ms chop (>0 means actively chopping)
  chopOutput: number;     // pork portions ready on chop table
  chopOutputTimer: number;   // ms since chopOutput was last produced; drives spoil
  chopOutputSpoiled: boolean; // true when chopOutput timer has expired
  activeMenu: { stationId: string; owner: 1 | 2 | 3 | 4 } | null;
  player2: Player | null;
  player3: Player | null;
  player4: Player | null;
  playerCount: number;   // 1–4
  coop: boolean;
  maxFails: number;
  thresholdsUnlocked: number;
  levelSales: number;
  tutorialOrderQueue: string[];
  levelCOGS: number;
  levelLabor: number;
  levelWaste: number;
  levelOverhead: number;        // overhead deducted at level end
  levelPorkCooked: number;      // pork shoulders smoked this level
  levelGrillFryerCooked: number; // items finished on grill or fryer this level
  salesByItem: Record<string, { count: number; revenue: number }>;
  levelSatisfactionSum: number;   // sum of per-order satisfaction scores (0-100) this level
  levelSatisfactionCount: number; // total orders counted (served + walked out)
}

export interface FoodDef {
  id: FoodId;
  name: string;
  color: string;
  isRaw: boolean;
  cookTime: number;
  burnTime: number;
  station: StationKind;
  rawOf?: FoodId;
  cookedFrom?: FoodId;
  cost?: number;  // ingredient cost in cents, deducted on pickup
}

export interface LevelDef {
  n: number;
  name: string;
  duration: number;
  orderIntervalMin: number;
  orderIntervalMax: number;
  maxActiveOrders: number;
  orderTimeLimit: number;
}
