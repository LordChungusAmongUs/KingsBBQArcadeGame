import type { GameState, Order, FoodId, HeldItem, StagedItem, CookSlot } from './types';
import { LEVELS, ORDERS, FOOD, MEAL_PRICES, INTERACT_RANGE, PLAYER_SPEED, PARTIAL_SPOIL_TIME, STAGED_SPOIL_TIME, LABOR_RATE, OVERTIME_LABOR_RATE, BASE_MAX_FAILS, UPSET_THRESHOLDS, ORDER_DEFS } from './config';
import { buildStations, tickCooking, nearestStation, distToStation, placeOnStation, pickupFromStation } from './kitchen';
import { input, keys } from './input';
import { awardXP, incrementStat } from './profile';

// Remote player input — set by net handlers; avoids injecting into the shared keys Set
export const remoteInput = {
  useRemote: false,  // true when this machine is an online co-op host
  p2: { up: false, down: false, left: false, right: false },
  p3: { up: false, down: false, left: false, right: false },
  p4: { up: false, down: false, left: false, right: false },
};

const MEAL_STAT_MAP: Record<string, string> = {
  'Hamburger':        'sold_hamburger',
  'Cheeseburger':     'sold_cheeseburger',
  'Dbl Burger':       'sold_dbl_burger',
  'Dbl Cheeseburger': 'sold_dbl_cheeseburger',
  'BBQ Sand.':        'sold_bbq_sand',
  'BBQ Plate':        'sold_bbq_plate',
  'Hotdog':           'sold_hotdog',
};

function onCookingDone(food: FoodId, kind: string): void {
  awardXP(1);
  if (food === 'raw_patty')  incrementStat('patties_grilled', 1);
  else if (food === 'raw_hotdog') incrementStat('hotdogs_grilled', 1);
  else if (food === 'raw_fries')  incrementStat('fries_fried', 1);
  else if (food === 'raw_rings')  incrementStat('pups_fried', 1);
  else if (food === 'raw_pork' && kind === 'smoker') incrementStat('shoulders_smoked', 1);
}

function trackCook(gs: GameState, food: FoodId, kind: string): void {
  if (kind === 'grill' || kind === 'fryer') gs.levelGrillFryerCooked++;
  if (food === 'raw_pork' && kind === 'smoker') gs.levelPorkCooked++;
}

function calcOverhead(gs: GameState): number {
  const porkCost = gs.levelPorkCooked > 0
    ? 100 + (gs.levelPorkCooked - 1) * 50   // $1.00 first, $0.50 each additional
    : 0;
  return 1000 + porkCost + gs.levelGrillFryerCooked * 10; // $10 flat + pork + $0.10/grill/fryer
}

const MAX_STACK = 2;
let _orderId = 1;

export function createGame(level: number, carryScore = 0, playerCount = 1, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): GameState {
  const lvl = LEVELS[level - 1];
  const coop = playerCount > 1;
  const game: GameState = {
    player:  { x: 540, y: 430, vx: 0, vy: 0, held: null, radius: 18, facing: 0, walkFrame: 0 },
    player2: playerCount >= 2 ? { x: 630, y: 430, vx: 0, vy: 0, held: null, radius: 18, facing: Math.PI, walkFrame: 0 } : null,
    player3: playerCount >= 3 ? { x: 540, y: 540, vx: 0, vy: 0, held: null, radius: 18, facing: 0, walkFrame: 0 } : null,
    player4: playerCount >= 4 ? { x: 630, y: 540, vx: 0, vy: 0, held: null, radius: 18, facing: Math.PI, walkFrame: 0 } : null,
    playerCount,
    coop,
    stations: buildStations(),
    orders: [],
    plates: [],
    staged: [],
    score: carryScore,
    level,
    levelTimer: lvl.duration,
    nextOrderIn: 3000,
    completed: 0,
    failed: carryFailed,
    phase: 'playing',
    levelEndTimer: 0,
    prepTimer: 15000,
    laborAccum: 0,
    chopStored: 0,
    chopProgress: 0,
    chopOutput: 0,
    chopOutputTimer: 0,
    chopOutputSpoiled: false,
    activeMenu: null,
    maxFails: BASE_MAX_FAILS + thresholdsUnlocked,
    thresholdsUnlocked,
    levelSales: 0,
    levelCOGS: 0,
    levelLabor: 0,
    levelWaste: 0,
    levelOverhead: 0,
    levelPorkCooked: 0,
    levelGrillFryerCooked: 0,
    salesByItem: {},
    tutorialOrderQueue: [],
    levelSatisfactionSum: 0,
    levelSatisfactionCount: 0,
  };
  if (smokerSlots) {
    const smoker = game.stations.find(s => s.kind === 'smoker');
    if (smoker) smoker.slots = smokerSlots.map(sl => ({ ...sl }));
  }
  return game;
}

function calcOrderSatisfaction(order: Order): number {
  const frac = order.elapsed / order.timeLimit;
  let sat = 100;
  if (frac >= 0.75)      sat -= 25; // red zone
  else if (frac >= 0.5)  sat -= 10; // yellow zone
  const totalItems = order.items.length;
  if (totalItems > 0) sat -= Math.round(order.burnedCount * (50 / totalItems));
  return Math.max(0, sat);
}

export function tickGame(gs: GameState, dt: number): void {
  if (gs.phase !== 'playing') {
    gs.levelEndTimer -= dt;
    tickCooking(gs.stations, dt);
    return;
  }

  if (gs.prepTimer > 0) {
    gs.prepTimer = Math.max(0, gs.prepTimer - dt);
    drainLabor(gs, dt, LABOR_RATE * gs.playerCount);
    tickCooking(gs.stations, dt, (food, kind) => { onCookingDone(food, kind); trackCook(gs, food, kind); });
    tickSmoker(gs);
    tickChop(gs, dt);
    tickStaged(gs, dt);
    tickMenu(gs);
    tickPlayer(gs, dt);
    if (gs.coop && gs.player2) tickPlayer2(gs, dt);
    if (gs.player3) tickPlayer3(gs, dt);
    if (gs.player4) tickPlayer4(gs, dt);
    if (input.interactPressed)   doInteract(gs, 1);
    if (input.p2InteractPressed) doInteract(gs, 2);
    if (input.p3InteractPressed) doInteract(gs, 3);
    if (input.p4InteractPressed) doInteract(gs, 4);
    return;
  }

  gs.levelTimer -= dt;
  const isOvertime = gs.levelTimer <= 0;
  drainLabor(gs, dt, (isOvertime ? OVERTIME_LABOR_RATE : LABOR_RATE) * gs.playerCount);
  if (isOvertime) {
    gs.levelTimer = 0;

    // When no orders remain, instantly spoil all leftover food
    const noOrders = !gs.orders.some(o => o.status === 'active' || o.status === 'plating');
    if (noOrders) {
      for (const st of gs.stations) {
        if (st.kind === 'grill' || st.kind === 'fryer') {
          for (const slot of st.slots) {
            if (slot.state === 'cooking' || slot.state === 'ready') slot.state = 'burned';
          }
        } else if (st.kind === 'warmer') {
          for (const slot of st.slots) {
            if (slot.food && slot.state === 'ready') slot.state = 'burned';
          }
        }
      }
      for (const si of gs.staged) si.spoiled = true;
      gs.chopStored = 0; gs.chopProgress = 0; gs.chopOutput = 0; gs.chopOutputTimer = 0; gs.chopOutputSpoiled = false;
    }

    const hasBadFood = gs.staged.some(si => si.spoiled) ||
      gs.stations.some(st => st.slots.some(sl => sl.state === 'burned')) ||
      gs.chopOutputSpoiled ||
      gs.player.held?.burned === true ||
      gs.player2?.held?.burned === true ||
      gs.player3?.held?.burned === true ||
      gs.player4?.held?.burned === true;
    const stillWaiting = !noOrders || hasBadFood;
    if (!stillWaiting) {
      if (gs.failed >= gs.maxFails) {
        gs.phase = 'game_over';
        gs.levelEndTimer = 4000;
      } else {
        const overhead = calcOverhead(gs);
        gs.levelOverhead = overhead;
        gs.score -= overhead;
        gs.phase = 'level_end';
        gs.levelEndTimer = 20000;
      }
      return;
    }
  }

  tickOrders(gs, dt);
  tickStaged(gs, dt);
  tickCooking(gs.stations, dt, (food, kind) => { onCookingDone(food, kind); trackCook(gs, food, kind); });
  tickSmoker(gs);
  tickChop(gs, dt);
  if (gs.chopOutput > 0 && !gs.chopOutputSpoiled) {
    gs.chopOutputTimer += dt;
    if (gs.chopOutputTimer >= STAGED_SPOIL_TIME) gs.chopOutputSpoiled = true;
  }
  tickMenu(gs);
  tickPlayer(gs, dt);
  if (gs.coop && gs.player2) tickPlayer2(gs, dt);
  if (gs.player3) tickPlayer3(gs, dt);
  if (gs.player4) tickPlayer4(gs, dt);
  if (input.interactPressed)   doInteract(gs, 1);
  if (input.p2InteractPressed) doInteract(gs, 2);
  if (input.p3InteractPressed) doInteract(gs, 3);
  if (input.p4InteractPressed) doInteract(gs, 4);

  // Bankruptcy: $0 or below ends the game immediately
  if (gs.score <= 0 && gs.phase === 'playing') {
    gs.phase = 'game_over';
    gs.levelEndTimer = 4000;
  }
}

// ─── Labor & thresholds ───────────────────────────────────────────────────────

function drainLabor(gs: GameState, dt: number, rate: number): void {
  gs.laborAccum += dt;
  while (gs.laborAccum >= 1000) {
    gs.laborAccum -= 1000;
    gs.score -= rate;
    gs.levelLabor += rate;
  }
}

function checkThresholds(gs: GameState): void {
  const newCount = UPSET_THRESHOLDS.filter(t => gs.score >= t).length;
  if (newCount > gs.thresholdsUnlocked) {
    gs.thresholdsUnlocked = newCount;
    gs.maxFails = BASE_MAX_FAILS + gs.thresholdsUnlocked;
  }
}

function getIngredientCost(foodId: FoodId): number {
  const def = FOOD.get(foodId);
  if (!def) return 0;
  if (def.cost !== undefined) return def.cost;
  if (def.cookedFrom) return getIngredientCost(def.cookedFrom);
  return 0;
}

// ─── Orders ───────────────────────────────────────────────────────────────────

function tickOrders(gs: GameState, dt: number): void {
  const lvl = LEVELS[gs.level - 1];
  gs.nextOrderIn -= dt;
  if (gs.nextOrderIn <= 0 && gs.levelTimer > 0) {
    spawnOrder(gs);
    gs.nextOrderIn = lvl.orderIntervalMin + Math.random() * (lvl.orderIntervalMax - lvl.orderIntervalMin);
  }
  for (const o of gs.orders) {
    if (o.status !== 'active') continue;
    o.elapsed += dt;
    if (o.elapsed >= o.timeLimit) {
      o.status = 'failed';
      gs.failed++;
      gs.levelSatisfactionCount++; // walk-out = 0%, don't add to sum
      incrementStat('customers_lost', 1);
      if (gs.failed >= gs.maxFails) { gs.phase = 'game_over'; gs.levelEndTimer = 4000; }
    }
  }

  // Partial plate spoil: if some items placed but not all, count down
  for (const o of gs.orders) {
    if (o.status !== 'active') continue;
    const anyDone = o.items.some(i => i.done);
    const allDone = o.items.every(i => i.done);
    if (anyDone && !allDone) {
      o.spoilTimer += dt;
      if (o.spoilTimer >= PARTIAL_SPOIL_TIME) {
        for (const item of o.items) {
          if (item.done) {
            gs.staged.push({ food: item.food, spoilTimer: 0, spoiled: true, count: 1 });
            item.done = false;
          }
        }
        o.spoilTimer = 0;
      }
    } else {
      o.spoilTimer = 0;
    }
  }
}

// Maps arrow direction to slot index based on menu size
function menuKeySlot(menuLen: number, dir: 'up'|'left'|'right'|'down'): number {
  if (menuLen === 1) return dir === 'up' ? 0 : -1;
  if (menuLen === 2) { return dir === 'left' ? 0 : dir === 'right' ? 1 : -1; }
  if (menuLen === 3) { return dir === 'up' ? 0 : dir === 'left' ? 1 : dir === 'right' ? 2 : -1; }
  return dir === 'up' ? 0 : dir === 'left' ? 1 : dir === 'right' ? 2 : dir === 'down' ? 3 : -1;
}

function tickMenu(gs: GameState): void {
  if (!gs.activeMenu) return;

  const st = gs.stations.find(s => s.id === gs.activeMenu!.stationId);
  const owner = gs.activeMenu.owner;
  const ownerP = owner === 4 && gs.player4 ? gs.player4
               : owner === 3 && gs.player3 ? gs.player3
               : owner === 2 && gs.player2 ? gs.player2
               : gs.player;

  if (!st || distToStation(ownerP.x, ownerP.y, st) > INTERACT_RANGE * 2.5) {
    gs.activeMenu = null;
    return;
  }

  const dirs: Array<['up'|'left'|'right'|'down', boolean]> =
    owner === 4 ? [
      ['up',    input.p4MenuPickUp],   ['left',  input.p4MenuPickLeft],
      ['right', input.p4MenuPickRight],['down',  input.p4MenuPickDown],
    ] : owner === 3 ? [
      ['up',    input.p3MenuPickUp],   ['left',  input.p3MenuPickLeft],
      ['right', input.p3MenuPickRight],['down',  input.p3MenuPickDown],
    ] : owner === 2 ? [
      ['up',    input.p2MenuPickUp],   ['left',  input.p2MenuPickLeft],
      ['right', input.p2MenuPickRight],['down',  input.p2MenuPickDown],
    ] : [
      ['up',    input.menuPickUp],     ['left',  input.menuPickLeft],
      ['right', input.menuPickRight],  ['down',  input.menuPickDown],
    ];
  const p = ownerP;

  // ── Warmer: each physical slot maps to one arrow key ──────────────────────
  if (st.kind === 'warmer') {
    const hasContent = st.slots.some(sl => sl.food && (sl.state === 'ready' || sl.state === 'burned'));
    if (!hasContent && !p.held) { gs.activeMenu = null; return; }
    const slotCount = Math.min(st.slots.length, 4);
    for (const [dir, pressed] of dirs) {
      if (!pressed) continue;
      const idx = menuKeySlot(slotCount, dir);
      if (idx < 0 || idx >= slotCount) continue;
      const slot = st.slots[idx];
      if (!slot) continue;
      if ((slot.state === 'ready' || slot.state === 'burned') && slot.food) {
        // Pick up from this slot (burned items can be carried to trash)
        const food = slot.food;
        const wasBurned = slot.state === 'burned';
        slot.food = null; slot.state = 'empty'; slot.timer = 0;
        if (p.held === null) {
          p.held = { food, count: 1, burned: wasBurned };
        } else if (!wasBurned && p.held.food === food && !p.held.burned && p.held.count < MAX_STACK) {
          p.held.count++;
        } else if (!wasBurned && !p.held.burned) {
          // Swap: return held to an empty slot, then pick up
          for (let i = 0; i < p.held.count; i++) {
            const es = st.slots.find(sl => sl.state === 'empty');
            if (!es) break;
            es.food = p.held!.food; es.state = 'ready'; es.timer = 0;
          }
          p.held = { food, count: 1, burned: false };
        }
      } else if (slot.state === 'empty' && p.held && !p.held.burned) {
        // Place one item from hand into this slot (whole_pork allowed)
        const def = FOOD.get(p.held.food);
        if (def && !def.isRaw) {
          slot.food = p.held.food; slot.state = 'ready'; slot.timer = 0;
          p.held.count--;
          if (p.held.count <= 0) p.held = null;
        }
      }
      break;
    }
    return;
  }

  // ── Cooler / Freezer: food-type menu ─────────────────────────────────────
  const menu = st.menu ?? [];
  for (const [dir, pressed] of dirs) {
    if (!pressed) continue;
    const idx = menuKeySlot(menu.length, dir);
    if (idx < 0 || idx >= menu.length) continue;
    const food = menu[idx];
    if (p.held === null) {
      p.held = { food, count: 1, burned: false };
    } else if (p.held.food === food && !p.held.burned && p.held.count < MAX_STACK) {
      p.held.count++;
    } else {
      p.held = { food, count: 1, burned: false };
    }
    break;
  }
}

function tickStaged(gs: GameState, dt: number): void {
  // Tick spoil timers; mark as spoiled (do NOT remove — player must trash them)
  for (const si of gs.staged) {
    if (si.spoiled) continue;
    si.spoilTimer += dt;
    if (si.spoilTimer >= STAGED_SPOIL_TIME) si.spoiled = true;
  }

  // Tick completed plate spoil timers; remove if expired
  for (let i = gs.plates.length - 1; i >= 0; i--) {
    gs.plates[i].spoilTimer += dt;
    if (gs.plates[i].spoilTimer >= STAGED_SPOIL_TIME) {
      gs.plates.splice(i, 1);
    }
  }


  // Auto-apply non-spoiled staged items to active orders
  for (const o of gs.orders) {
    if (o.status !== 'active') continue;
    for (const item of o.items) {
      if (item.done) continue;

      // Large serving: consumes 2 counts from the base food batch
      const lgBase: FoodId | null = item.food === 'fries_lg' ? 'fries'
                                  : item.food === 'rings_lg'  ? 'rings' : null;
      if (lgBase !== null) {
        const idx = gs.staged.findIndex(si => !si.spoiled && si.food === lgBase && si.count >= 2);
        if (idx !== -1) {
          item.done = true;
          gs.staged[idx].count -= 2;
          if (gs.staged[idx].count <= 0) gs.staged.splice(idx, 1);
          if (o.items.every(i => i.done)) {
            o.status = 'plating';
            gs.plates.push({ orderId: o.id, name: o.name, spoilTimer: o.spoilTimer });
            awardXP(1); incrementStat('plates_completed', 1);
          }
        }
        continue;
      }

      // Normal: exact food match, uses 1 count
      const idx = gs.staged.findIndex(si => !si.spoiled && si.food === item.food);
      if (idx !== -1) {
        item.done = true;
        const si = gs.staged[idx];
        si.count--;
        if (si.count <= 0) gs.staged.splice(idx, 1);
        if (o.items.every(i => i.done)) {
          o.status = 'plating';
          gs.plates.push({ orderId: o.id, name: o.name, spoilTimer: o.spoilTimer });
          awardXP(1); incrementStat('plates_completed', 1);
        }
      }
    }
  }
}

function tickSmoker(gs: GameState): void {
  const smoker = gs.stations.find(s => s.kind === 'smoker');
  if (!smoker) return;
  for (const slot of smoker.slots) {
    if (slot.state !== 'cooking' || slot.smokerPlacedLevel === undefined) continue;
    if (gs.level <= slot.smokerPlacedLevel) continue;
    const targetReached = slot.smokerPlacedDuringPrep
      ? gs.prepTimer <= slot.smokerPlacedAtTimer!          // placed during prep → compare prep countdown
      : gs.levelTimer <= slot.smokerPlacedAtTimer!;        // placed during play → compare level countdown
    if (targetReached) {
      slot.state = 'ready';
      slot.timer = 0;
      awardXP(1);
      incrementStat('shoulders_smoked', 1);
    }
  }
}

function tickChop(gs: GameState, dt: number): void {
  if (gs.chopStored > 0 && gs.chopProgress > 0) {
    gs.chopProgress += dt;
    if (gs.chopProgress >= 2000) {
      gs.chopStored--;
      gs.chopOutput += 4;
      gs.chopProgress = 0;
      gs.chopOutputTimer = 0; gs.chopOutputSpoiled = false;
      awardXP(1); incrementStat('bbq_chops', 1);
    }
  }
}

function spawnOrder(gs: GameState): void {
  const lvl  = LEVELS[gs.level - 1];

  let chosen: import('./config').OrderDef | undefined;
  if (gs.tutorialOrderQueue.length > 0) {
    const name = gs.tutorialOrderQueue.shift()!;
    chosen = ORDER_DEFS.find(o => o.name === name);
  }
  if (!chosen) {
    const pool = ORDER_DEFS.filter(o => !o.hasPork || gs.level > 1);
    let total = 0;
    for (const o of pool) total += o.weight;
    let r = Math.random() * total;
    chosen = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].weight;
      if (r <= 0) { chosen = pool[i]; break; }
    }
  }

  gs.orders.push({
    id: _orderId++,
    name: chosen.name,
    items: chosen.items.map(food => ({ food, done: false })),
    timeLimit: lvl.orderTimeLimit,
    elapsed: 0,
    status: 'active',
    spoilTimer: 0,
    burnedCount: 0,
  });
}

// ─── Player movement ──────────────────────────────────────────────────────────

function tickPlayer(gs: GameState, dt: number): void {
  if (gs.activeMenu !== null && (gs.activeMenu.owner === 1 || !gs.coop)) {
    gs.player.walkFrame = 0;
    return;
  }
  if (gs.chopProgress > 0) {
    gs.player.walkFrame = 0;
    return;
  }
  const p = gs.player;
  let dx = 0, dy = 0;
  if (remoteInput.useRemote) {
    // Online co-op host: P1 uses arrow keys (P2/3/4 use separate remoteInput channels)
    if (keys.has('ArrowUp'))    dy -= 1;
    if (keys.has('ArrowDown'))  dy += 1;
    if (keys.has('ArrowLeft'))  dx -= 1;
    if (keys.has('ArrowRight')) dx += 1;
  } else if (gs.coop) {
    // Local co-op: P1 uses WASD, P2 uses arrows
    if (keys.has('KeyW')) dy -= 1;
    if (keys.has('KeyS')) dy += 1;
    if (keys.has('KeyA')) dx -= 1;
    if (keys.has('KeyD')) dx += 1;
  } else {
    if (keys.has('KeyW') || keys.has('ArrowUp'))    dy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  dy += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft'))  dx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
  }
  if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  const spd = PLAYER_SPEED * dt / 1000;
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

function tickPlayer2(gs: GameState, dt: number): void {
  if (!gs.player2) return;
  if (gs.activeMenu !== null && gs.activeMenu.owner === 2) {
    gs.player2.walkFrame = 0;
    return;
  }
  const p = gs.player2;
  let dx = 0, dy = 0;
  const pk = remoteInput.useRemote ? remoteInput.p2 : { up: keys.has('ArrowUp'), down: keys.has('ArrowDown'), left: keys.has('ArrowLeft'), right: keys.has('ArrowRight') };
  if (pk.up)    dy -= 1;
  if (pk.down)  dy += 1;
  if (pk.left)  dx -= 1;
  if (pk.right) dx += 1;
  if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  const spd = PLAYER_SPEED * dt / 1000;
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

function tickPlayer3(gs: GameState, dt: number): void {
  if (!gs.player3) return;
  if (gs.activeMenu?.owner === 3) { gs.player3.walkFrame = 0; return; }
  const p = gs.player3;
  let dx = 0, dy = 0;
  const pk = remoteInput.p3;
  if (pk.up)    dy -= 1;
  if (pk.down)  dy += 1;
  if (pk.left)  dx -= 1;
  if (pk.right) dx += 1;
  if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  const spd = PLAYER_SPEED * dt / 1000;
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

function tickPlayer4(gs: GameState, dt: number): void {
  if (!gs.player4) return;
  if (gs.activeMenu?.owner === 4) { gs.player4.walkFrame = 0; return; }
  const p = gs.player4;
  let dx = 0, dy = 0;
  const pk = remoteInput.p4;
  if (pk.up)    dy -= 1;
  if (pk.down)  dy += 1;
  if (pk.left)  dx -= 1;
  if (pk.right) dx += 1;
  if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  const spd = PLAYER_SPEED * dt / 1000;
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

// Push player circle out of station rectangles (AABB vs circle)
export function resolveCollisions(p: import('./types').Player, stations: import('./types').Station[]): void {
  const R = p.radius;
  for (const s of stations) {
    // Expand rect by player radius, find closest point on rect to circle center
    const nearX = Math.max(s.x, Math.min(p.x, s.x + s.w));
    const nearY = Math.max(s.y, Math.min(p.y, s.y + s.h));
    const distX = p.x - nearX;
    const distY = p.y - nearY;
    const dist2 = distX * distX + distY * distY;
    if (dist2 >= R * R) continue; // no overlap

    if (dist2 === 0) {
      // Center exactly on rect edge — push up as fallback
      p.y = s.y - R;
      continue;
    }
    const dist = Math.sqrt(dist2);
    const push = (R - dist) / dist;
    p.x += distX * push;
    p.y += distY * push;
  }
}

// ─── Interaction ──────────────────────────────────────────────────────────────

const PLATE_SENTINEL = '_plate_' as FoodId;

function doInteract(gs: GameState, playerNum: 1 | 2 | 3 | 4 = 1): void {
  const p = playerNum === 4 && gs.player4 ? gs.player4
          : playerNum === 3 && gs.player3 ? gs.player3
          : playerNum === 2 && gs.player2 ? gs.player2
          : gs.player;
  const s = nearestStation(p.x, p.y, gs.stations, INTERACT_RANGE);
  if (!s) return;

  // Close this player's menu if they interact with a different station
  if (gs.activeMenu?.owner === playerNum && gs.activeMenu.stationId !== s.id) {
    gs.activeMenu = null;
  }

  // Cooler / Freezer: toggles the menu open or closed for this player
  if (s.kind === 'cooler' || s.kind === 'freezer') {
    if (gs.activeMenu?.stationId === s.id && gs.activeMenu.owner === playerNum) {
      gs.activeMenu = null;
    } else {
      gs.activeMenu = { stationId: s.id, owner: playerNum };
    }
    return;
  }

  // ── Supply: stack same ingredient up to 3; swap out anything else instantly ──
  if (s.kind === 'supply') {
    if (!s.produces) return;
    if (p.held === null) {
      p.held = { food: s.produces, count: 1, burned: false };
    } else if (p.held.food === s.produces && !p.held.burned && p.held.count < MAX_STACK) {
      p.held.count++;
    } else {
      // Different ingredient, burned item, or plate — swap it out
      p.held = { food: s.produces, count: 1, burned: false };
    }
    return;
  }

  // ── Trash: discard anything ──
  if (s.kind === 'trash') {
    if (p.held?.burned) {
      gs.levelWaste += getIngredientCost(p.held.food) * p.held.count;
      incrementStat('food_burned', p.held.count);
    }
    p.held = null;
    return;
  }

  // ── Cook stations ──
  if (s.kind === 'grill' || s.kind === 'fryer' || s.kind === 'smoker') {
    const def = p.held ? FOOD.get(p.held.food) : null;

    // Cheese on ready patties: convert up to (cheese count) ready patties instantly
    if (p.held?.food === 'cheese' && !p.held.burned && s.kind === 'grill') {
      const readyPatties = s.slots.filter(sl => sl.state === 'ready' && sl.food === 'raw_patty');
      const converts = Math.min(p.held.count, readyPatties.length, MAX_STACK);
      if (converts > 0) {
        const cheeseCost = (FOOD.get('cheese')?.cost ?? 0) * converts;
        gs.score -= cheeseCost; gs.levelCOGS += cheeseCost;
        for (let i = 0; i < converts; i++) {
          readyPatties[i].food = null; readyPatties[i].state = 'empty'; readyPatties[i].timer = 0;
        }
        p.held = { food: 'cheese_patty', count: converts, burned: false };
        awardXP(converts); incrementStat('cheese_melted', converts);
      }
      return;
    }

    // Place raw food (consume one from stack) — charge cost on use
    if (p.held && !p.held.burned && def?.isRaw && def.station === s.kind) {
      if (placeOnStation(s, p.held.food)) {
        const cost = def.cost ?? 0;
        gs.score -= cost; gs.levelCOGS += cost;
        if (s.kind === 'grill')  incrementStat('grill_uses', 1);
        if (s.kind === 'fryer')  incrementStat('fryer_uses', 1);
        if (p.held.food === 'raw_pork' && s.kind === 'smoker') {
          const newSlot = s.slots.find(sl => sl.food === 'raw_pork' && sl.state === 'cooking' && sl.smokerPlacedLevel === undefined);
          if (newSlot) {
            newSlot.smokerPlacedLevel = gs.level;
            if (gs.prepTimer > 0) {
              // Placed during prep: track prep timer remaining so it fires at the
              // same point in the NEXT level's prep period.
              newSlot.smokerPlacedAtTimer    = gs.prepTimer;
              newSlot.smokerPlacedDuringPrep = true;
            } else {
              // Placed during gameplay: track level countdown timer as before.
              newSlot.smokerPlacedAtTimer    = gs.levelTimer;
              newSlot.smokerPlacedDuringPrep = false;
            }
          }
        }
        p.held.count--;
        if (p.held.count <= 0) p.held = null;
      }
      return;
    }
    // Pick up ready or burned — peek first so we don't remove without being able to hold it
    const readySlot = s.slots.find(sl => sl.state === 'ready' || sl.state === 'burned');
    if (readySlot && readySlot.food) {
      const slotDef = FOOD.get(readySlot.food)!;
      const isBurned = readySlot.state === 'burned';
      const cookedId: FoodId | undefined = isBurned ? readySlot.food : slotDef.rawOf;
      if (cookedId) {
        const heldIsRaw = p.held ? FOOD.get(p.held.food)?.isRaw ?? false : false;
        const canStack = p.held === null ||
          (isBurned && p.held.burned && p.held.food === cookedId && p.held.count < MAX_STACK) ||
          (!p.held.burned && !heldIsRaw && p.held.food === cookedId &&
           p.held.count < MAX_STACK && !isBurned);
        if (canStack) {
          const result = pickupFromStation(s);
          if (result) {
            if (p.held === null) p.held = { food: result.food, count: 1, burned: result.burned };
            else p.held.count++;
          }
        }
      }
    }
    return;
  }

  // ── Chop table ──
  if (s.kind === 'chop') {
    // Step 1: place whole_pork on the table
    if (p.held?.food === 'whole_pork' && !p.held.burned && gs.chopStored === 0 && gs.chopProgress === 0) {
      gs.chopStored++;
      p.held.count--;
      if (p.held.count <= 0) p.held = null;
      return;
    }
    // Step 2: start chopping (pork is loaded, not yet chopping)
    if (gs.chopStored > 0 && gs.chopProgress === 0) {
      gs.chopProgress = 1;
      return;
    }
    // Step 3: pick up output pork (spoiled pork gives burned item for trashing)
    if (gs.chopOutput > 0) {
      if (gs.chopOutputSpoiled) {
        if (p.held === null) { p.held = { food: 'pork', count: 1, burned: true }; gs.chopOutput--; }
        else if (p.held.food === 'pork' && p.held.burned && p.held.count < MAX_STACK) { p.held.count++; gs.chopOutput--; }
      } else if (p.held === null || (p.held.food === 'pork' && !p.held.burned && p.held.count < MAX_STACK)) {
        if (p.held === null) p.held = { food: 'pork', count: 1, burned: false };
        else p.held.count++;
        gs.chopOutput--;
      }
      if (gs.chopOutput === 0) { gs.chopOutputTimer = 0; gs.chopOutputSpoiled = false; }
    }
    return;
  }

  // ── Prep table ──
  if (s.kind === 'prep') {
    if (p.held === null) {
      // Pick up completed plate first, then a spoiled item
      if (gs.plates.length > 0) {
        p.held = { food: PLATE_SENTINEL, count: 1, burned: false };
        return;
      }
      const spoiledIdx = gs.staged.findIndex(si => si.spoiled);
      if (spoiledIdx !== -1) {
        const si = gs.staged.splice(spoiledIdx, 1)[0];
        p.held = { food: si.food, count: 1, burned: true };
      }
      return;
    }
    // Carrying a plate — go to counter
    if (p.held.food === PLATE_SENTINEL) return;
    // Stack a spoiled item onto a matching burned held item
    if (p.held.burned) {
      const spoiledIdx = gs.staged.findIndex(si => si.spoiled && si.food === p.held!.food && p.held!.count < MAX_STACK);
      if (spoiledIdx !== -1) {
        gs.staged.splice(spoiledIdx, 1);
        p.held.count++;
      }
      return;
    }
    // Drop a cooked (non-burned) item onto an active order or stage it
    const def = FOOD.get(p.held.food);
    if (def && !def.isRaw && p.held.food !== 'whole_pork') {
      for (const o of gs.orders) {
        if (o.status !== 'active') continue;
        const slot = o.items.find(i => i.food === p.held!.food && !i.done);
        if (slot) {
          const food = p.held!.food;
          slot.done = true;
          p.held.count--;
          if (p.held.count <= 0) p.held = null;
          if (food === 'fries' || food === 'rings') {
            gs.staged.push({ food, spoilTimer: 0, spoiled: false, count: 1 });
          }
          if (o.items.every(i => i.done)) {
            o.status = 'plating';
            gs.plates.push({ orderId: o.id, name: o.name, spoilTimer: o.spoilTimer });
            awardXP(1); incrementStat('plates_completed', 1);
          }
          return;
        }
      }
      // No order needs it yet — stage it on the prep table
      const stageCount = (p.held.food === 'fries' || p.held.food === 'rings') ? 2 : 1;
      gs.staged.push({ food: p.held.food, spoilTimer: 0, spoiled: false, count: stageCount });
      p.held.count--;
      if (p.held.count <= 0) p.held = null;
    }
    return;
  }

  // ── Warmer: interact toggles the menu; arrow keys handle place/pickup ──
  if (s.kind === 'warmer') {
    if (gs.activeMenu?.stationId === s.id && gs.activeMenu.owner === playerNum) {
      gs.activeMenu = null;
    } else {
      gs.activeMenu = { stationId: s.id, owner: playerNum };
    }
    return;
  }

  // ── Counter ──
  if (s.kind === 'counter') {
    if (p.held?.food === PLATE_SENTINEL && gs.plates.length > 0) {
      const plate = gs.plates.shift()!;
      const order = gs.orders.find(o => o.id === plate.orderId);
      if (order) {
        const price = MEAL_PRICES[order.name] ?? 0;
        gs.score += price;
        gs.levelSales += price;
        const sbi = gs.salesByItem[order.name];
        if (sbi) { sbi.count++; sbi.revenue += price; }
        else gs.salesByItem[order.name] = { count: 1, revenue: price };
        checkThresholds(gs);
        gs.completed++;
        gs.levelSatisfactionSum += calcOrderSatisfaction(order);
        gs.levelSatisfactionCount++;
        order.status = 'failed'; // remove from ticket board
        awardXP(1);
        const [base] = order.name.split('+');
        const mealStat = MEAL_STAT_MAP[base.trim()];
        if (mealStat) incrementStat(mealStat, 1);
        if (order.name.includes('+')) incrementStat('sold_combo', 1);
      }
      p.held = null;
    }
    return;
  }
}
