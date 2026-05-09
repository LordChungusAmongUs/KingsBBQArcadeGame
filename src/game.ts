import type { GameState, Order, FoodId, HeldItem, StagedItem, CookSlot } from './types';
import { LEVELS, ORDERS, FOOD, MEAL_PRICES, INTERACT_RANGE, PLAYER_SPEED, PARTIAL_SPOIL_TIME, STAGED_SPOIL_TIME, LABOR_RATE, OVERTIME_LABOR_RATE, BASE_MAX_FAILS, UPSET_THRESHOLDS, ORDER_DEFS } from './config';
import { buildStations, tickCooking, nearestStation, distToStation, placeOnStation, pickupFromStation } from './kitchen';
import { input, keys, wasdDash, arrowDash, wasdPressTime, arrowPressTime, jumpPressed, isJump1Held, isJump2Held, notifyDashEnd } from './input';
import { awardXP, incrementStat, hasUnlock, getProfile } from './profile';
import { spawnFloat, xpBreakdown } from './effects';

// Remote player input — set by net handlers; avoids injecting into the shared keys Set
export const remoteInput = {
  useRemote: false,  // true when this machine is an online co-op host
  p2: { up: false, down: false, left: false, right: false },
  p3: { up: false, down: false, left: false, right: false },
  p4: { up: false, down: false, left: false, right: false },
};

// ── Familiar state ────────────────────────────────────────────────────────────
let _famX = 0, _famY = 0, _famEatTimer = 0;
export function getFamiliarPos(): { x: number; y: number } { return { x: _famX, y: _famY }; }

// ── Dash mechanic ─────────────────────────────────────────────────────────────
const DASH_DISTANCE = 240; // ~4 floor tiles at 2× speed

interface _DashState { remaining: number; dx: number; dy: number; }
const _dash: _DashState[] = Array.from({ length: 4 }, () => ({ remaining: 0, dx: 0, dy: 0 }));

export function triggerDash(slot: number, dx: number, dy: number): void {
  if (slot < 0 || slot > 3) return;
  const d = _dash[slot]; d.dx = dx; d.dy = dy; d.remaining = DASH_DISTANCE;
}

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
function carryLimit(gs: GameState, owner: number): number {
  return (owner === 1 && ((hasUnlock('familiar') && getProfile()?.familiarAbility === 'carry') || gs.meterActive)) ? 3 : MAX_STACK;
}
let _orderId = 1;

export function createGame(level: number, carryScore = 0, playerCount = 1, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): GameState {
  const lvl = LEVELS[level - 1];
  const coop = playerCount > 1;
  const game: GameState = {
    player:  { x: 540, y: 430, vx: 0, vy: 0, held: null, familiarHeld: null, radius: 18, facing: 0, walkFrame: 0, jumping: false, jumpTimer: 0 },
    player2: playerCount >= 2 ? { x: 630, y: 430, vx: 0, vy: 0, held: null, familiarHeld: null, radius: 18, facing: Math.PI, walkFrame: 0, jumping: false, jumpTimer: 0 } : null,
    player3: playerCount >= 3 ? { x: 540, y: 540, vx: 0, vy: 0, held: null, familiarHeld: null, radius: 18, facing: 0, walkFrame: 0, jumping: false, jumpTimer: 0 } : null,
    player4: playerCount >= 4 ? { x: 630, y: 540, vx: 0, vy: 0, held: null, familiarHeld: null, radius: 18, facing: Math.PI, walkFrame: 0, jumping: false, jumpTimer: 0 } : null,
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
    meter: 0, meterActive: false, meterTimer: 0,
  };
  if (smokerSlots) {
    const smoker = game.stations.find(s => s.kind === 'smoker');
    if (smoker) smoker.slots = smokerSlots.map(sl => ({ ...sl }));
  }
  for (let i = 0; i < 4; i++) _dash[i].remaining = 0;
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

// ── Player-player collision ───────────────────────────────────────────────────

function resolvePlayerCollision(gs: GameState): void {
  const players = [gs.player, gs.player2, gs.player3, gs.player4].filter(Boolean) as import('./types').Player[];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (a.jumping || b.jumping) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minD = a.radius + b.radius;
      if (dist > 0 && dist < minD) {
        const push = (minD - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }
}

// ── Familiar ──────────────────────────────────────────────────────────────────

function tickFamiliar(gs: GameState, dt: number): void {
  if (!hasUnlock('familiar') && !gs.meterActive) return;
  const ability = gs.meterActive ? 'all' : getProfile()?.familiarAbility;

  // Spring-follow player
  const targetX = gs.player.x + Math.cos(gs.player.facing + Math.PI) * 32;
  const targetY = gs.player.y + Math.sin(gs.player.facing + Math.PI) * 32 + 10;
  const spd = Math.min(1, dt / 140);
  _famX += (targetX - _famX) * spd;
  _famY += (targetY - _famY) * spd;

  if (ability === 'cook_speed' || ability === 'all') {
    if (input.interactHeld) {
      const nearby = gs.stations.find(s =>
        (s.kind === 'grill' || s.kind === 'fryer') &&
        Math.hypot(s.x + s.w / 2 - gs.player.x, s.y + s.h / 2 - gs.player.y) < INTERACT_RANGE * 1.6
      );
      if (nearby) {
        let boosted = false;
        for (const slot of nearby.slots) {
          if (slot.state === 'cooking') { slot.timer += dt; boosted = true; }
        }
        if (boosted && Math.random() < 0.04) spawnFloat(_famX, _famY - 18, '⚡', '#f84');
      }
    }
  }

  if (ability === 'eat_leftovers' || ability === 'all') {
    _famEatTimer += dt;
    if (_famEatTimer >= 5000) {
      _famEatTimer = 0;
      const idx = gs.staged.findIndex(s => s.spoiled);
      if (idx !== -1) {
        gs.staged.splice(idx, 1);
        spawnFloat(_famX, _famY - 20, 'NOM!', '#4f8');
      }
    }
  }

  // carry ability: no per-frame logic needed — stack limit is raised in doInteract/tickMenu via carryLimit()
}

// ── Special meter (level 13) ──────────────────────────────────────────────────

function tickMeter(gs: GameState, dt: number): void {
  if (!hasUnlock('spec_meter') && !gs.meterActive) return;
  if (gs.meterActive) {
    gs.meterTimer -= dt;
    if (gs.meterTimer <= 0) {
      gs.meterActive = false; gs.meterTimer = 0;
      spawnFloat(gs.player.x, gs.player.y - 60, 'FULL SEND OVER', '#888', 1500);
    }
    return;
  }
  // Spin detection: all 4 WASD keys pressed within 700ms
  if (gs.meter >= 100) {
    const { up, down, left, right } = wasdPressTime;
    if (up > 0 && down > 0 && left > 0 && right > 0) {
      const oldest = Math.min(up, down, left, right);
      const newest = Math.max(up, down, left, right);
      if (newest - oldest < 700) {
        gs.meterActive = true; gs.meterTimer = 10000; gs.meter = 0;
        spawnFloat(gs.player.x, gs.player.y - 60, 'FULL SEND!', '#ff8', 2500);
      }
    }
  }
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
        const stageXP = awardXP(10 * gs.level);
        xpBreakdown.stage += stageXP;
        spawnFloat(gs.player.x, gs.player.y - 40, `+${stageXP} XP!`, '#ff8', 2500);
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
  tickFamiliar(gs, dt);
  tickMeter(gs, dt);
  tickPlayer(gs, dt);
  if (gs.coop && gs.player2) tickPlayer2(gs, dt);
  if (gs.player3) tickPlayer3(gs, dt);
  if (gs.player4) tickPlayer4(gs, dt);
  resolvePlayerCollision(gs);
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
        } else if (!wasBurned && p.held.food === food && !p.held.burned && p.held.count < carryLimit(gs, owner)) {
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
    } else if (p.held.food === food && !p.held.burned && p.held.count < carryLimit(gs, owner)) {
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
            incrementStat('plates_completed', 1);
            xpBreakdown.orders += awardXP(1);
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
          incrementStat('plates_completed', 1);
          xpBreakdown.orders += awardXP(1);
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
      incrementStat('shoulders_smoked', 1);
    }
  }
}

function tickChop(gs: GameState, dt: number): void {
  if (gs.chopStored > 0 && gs.chopProgress > 0) {
    const chopMult = (hasUnlock('familiar') || gs.meterActive) &&
      (getProfile()?.familiarAbility === 'chop_speed' || gs.meterActive) ? 2 : 1;
    gs.chopProgress += dt * chopMult;
    if (gs.chopProgress >= 2000) {
      gs.chopStored--;
      gs.chopOutput += 4;
      gs.chopProgress = 0;
      gs.chopOutputTimer = 0; gs.chopOutputSpoiled = false;
      const chopXP = awardXP(2); xpBreakdown.actions += chopXP; incrementStat('bbq_chops', 1);
      spawnFloat(gs.player.x, gs.player.y - 30, `+${chopXP} XP`, '#6af');
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
  let up = false, dn = false, lt = false, rt = false;
  if (remoteInput.useRemote) {
    // Online co-op host: P1 uses arrow keys
    up = keys.has('ArrowUp'); dn = keys.has('ArrowDown'); lt = keys.has('ArrowLeft'); rt = keys.has('ArrowRight');
  } else if (gs.coop) {
    // Local co-op: P1 uses WASD
    up = keys.has('KeyW'); dn = keys.has('KeyS'); lt = keys.has('KeyA'); rt = keys.has('KeyD');
  } else {
    up = keys.has('KeyW') || keys.has('ArrowUp'); dn = keys.has('KeyS') || keys.has('ArrowDown');
    lt = keys.has('KeyA') || keys.has('ArrowLeft'); rt = keys.has('KeyD') || keys.has('ArrowRight');
  }
  // Jump (level 10 mount unlock or meter active)
  if (jumpPressed.p1 && (hasUnlock('mount') || gs.meterActive)) {
    p.jumping = true; p.jumpTimer = 600;
  }
  if (p.jumping) {
    p.jumpTimer -= dt;
    if (p.jumpTimer <= 0) { p.jumping = false; p.jumpTimer = 0; }
  }

  // Consume dash trigger — gated behind level 3 or meter active
  const canDash = hasUnlock('dash') || gs.meterActive;
  if (remoteInput.useRemote) {
    if (arrowDash.active) { if (canDash) triggerDash(0, arrowDash.dx, arrowDash.dy); arrowDash.active = false; }
  } else if (gs.coop) {
    if (wasdDash.active) { if (canDash) triggerDash(0, wasdDash.dx, wasdDash.dy); wasdDash.active = false; }
  } else {
    if (wasdDash.active) { if (canDash) triggerDash(0, wasdDash.dx, wasdDash.dy); wasdDash.active = false; }
    else if (arrowDash.active) { if (canDash) triggerDash(0, arrowDash.dx, arrowDash.dy); arrowDash.active = false; }
  }
  const dash = _dash[0];
  let dx = 0, dy = 0, spd: number;
  const held0 = (dash.dx < 0 && lt) || (dash.dx > 0 && rt) || (dash.dy < 0 && up) || (dash.dy > 0 && dn);
  if (dash.remaining > 0 && held0) {
    dx = dash.dx; dy = dash.dy;
    spd = PLAYER_SPEED * 2 * dt / 1000;
    const prevR = dash.remaining;
    dash.remaining = Math.max(0, dash.remaining - spd);
    // Notify double-dash system when this dash completes
    if (prevR > 0 && dash.remaining <= 0 && (hasUnlock('double_dash') || gs.meterActive)) {
      notifyDashEnd(0, dash.dx, dash.dy);
    }
  } else {
    if (!held0) dash.remaining = 0;
    // Moonwalk: both opposing directions held → move in direction of EARLIER-pressed key, face opposite
    const pt = remoteInput.useRemote ? arrowPressTime : wasdPressTime;
    const bothLR = lt && rt, bothUD = up && dn;
    if (bothLR) { dx = pt.right < pt.left ? 1 : -1; }
    else        { if (lt) dx -= 1; if (rt) dx += 1; }
    if (bothUD) { dy = pt.down < pt.up ? 1 : -1; }
    else        { if (up) dy -= 1; if (dn) dy += 1; }
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
    // Mount speed bonus (level 10)
    const mountMult = (hasUnlock('mount') || gs.meterActive) ? (hasUnlock('mount_up') ? 2.0 : 1.6) : 1.0;
    spd = PLAYER_SPEED * dt / 1000 * mountMult;
    if (dx !== 0 || dy !== 0) {
      if (bothLR || bothUD) p.facing = Math.atan2(-dy, -dx);
      else p.facing = Math.atan2(dy, dx);
    }
  }
  if (dx !== 0 || dy !== 0) { p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
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
  const pk = remoteInput.useRemote ? remoteInput.p2 : { up: keys.has('ArrowUp'), down: keys.has('ArrowDown'), left: keys.has('ArrowLeft'), right: keys.has('ArrowRight') };
  // Jump P2
  if (jumpPressed.p2 && (hasUnlock('mount') || gs.meterActive)) {
    p.jumping = true; p.jumpTimer = 600;
  }
  if (p.jumping) {
    p.jumpTimer -= dt;
    if (p.jumpTimer <= 0) { p.jumping = false; p.jumpTimer = 0; }
  }

  // Local coop P2 gets arrowDash; online P2 gets triggerDash via network
  const canDash2 = hasUnlock('dash') || gs.meterActive;
  if (!remoteInput.useRemote && arrowDash.active) {
    if (canDash2) triggerDash(1, arrowDash.dx, arrowDash.dy); arrowDash.active = false;
  }
  const dash = _dash[1];
  let dx = 0, dy = 0, spd: number;
  const held1 = (dash.dx < 0 && pk.left) || (dash.dx > 0 && pk.right) || (dash.dy < 0 && pk.up) || (dash.dy > 0 && pk.down);
  if (dash.remaining > 0 && held1) {
    dx = dash.dx; dy = dash.dy;
    spd = PLAYER_SPEED * 2 * dt / 1000;
    const prevR2 = dash.remaining;
    dash.remaining = Math.max(0, dash.remaining - spd);
    if (prevR2 > 0 && dash.remaining <= 0 && (hasUnlock('double_dash') || gs.meterActive)) {
      notifyDashEnd(1, dash.dx, dash.dy);
    }
  } else {
    if (!held1) dash.remaining = 0;
    // Moonwalk for local P2 (arrow keys) — only when not online
    const bothLR2 = pk.left && pk.right, bothUD2 = pk.up && pk.down;
    if (!remoteInput.useRemote && bothLR2) { dx = arrowPressTime.right < arrowPressTime.left ? 1 : -1; }
    else { if (pk.left) dx -= 1; if (pk.right) dx += 1; }
    if (!remoteInput.useRemote && bothUD2) { dy = arrowPressTime.down < arrowPressTime.up ? 1 : -1; }
    else { if (pk.up) dy -= 1; if (pk.down) dy += 1; }
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
    const mountMult2 = (hasUnlock('mount') || gs.meterActive) ? (hasUnlock('mount_up') ? 2.0 : 1.6) : 1.0;
    spd = PLAYER_SPEED * dt / 1000 * mountMult2;
    const moonwalking2 = !remoteInput.useRemote && (bothLR2 || bothUD2);
    if (dx !== 0 || dy !== 0) {
      if (moonwalking2) p.facing = Math.atan2(-dy, -dx);
      else p.facing = Math.atan2(dy, dx);
    }
  }
  if (dx !== 0 || dy !== 0) { p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

function tickPlayer3(gs: GameState, dt: number): void {
  if (!gs.player3) return;
  if (gs.activeMenu?.owner === 3) { gs.player3.walkFrame = 0; return; }
  const p = gs.player3;
  const pk = remoteInput.p3;
  const dash = _dash[2];
  let dx = 0, dy = 0, spd: number;
  const held2 = (dash.dx < 0 && pk.left) || (dash.dx > 0 && pk.right) || (dash.dy < 0 && pk.up) || (dash.dy > 0 && pk.down);
  if (dash.remaining > 0 && held2) {
    dx = dash.dx; dy = dash.dy;
    spd = PLAYER_SPEED * 2 * dt / 1000;
    dash.remaining = Math.max(0, dash.remaining - spd);
  } else {
    if (!held2) dash.remaining = 0;
    if (pk.up) dy -= 1; if (pk.down) dy += 1; if (pk.left) dx -= 1; if (pk.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
    spd = PLAYER_SPEED * dt / 1000;
  }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
  p.x = Math.max(40, Math.min(1060, p.x + dx * spd));
  p.y = Math.max(155, Math.min(690, p.y + dy * spd));
  resolveCollisions(p, gs.stations);
}

function tickPlayer4(gs: GameState, dt: number): void {
  if (!gs.player4) return;
  if (gs.activeMenu?.owner === 4) { gs.player4.walkFrame = 0; return; }
  const p = gs.player4;
  const pk = remoteInput.p4;
  const dash = _dash[3];
  let dx = 0, dy = 0, spd: number;
  const held3 = (dash.dx < 0 && pk.left) || (dash.dx > 0 && pk.right) || (dash.dy < 0 && pk.up) || (dash.dy > 0 && pk.down);
  if (dash.remaining > 0 && held3) {
    dx = dash.dx; dy = dash.dy;
    spd = PLAYER_SPEED * 2 * dt / 1000;
    dash.remaining = Math.max(0, dash.remaining - spd);
  } else {
    if (!held3) dash.remaining = 0;
    if (pk.up) dy -= 1; if (pk.down) dy += 1; if (pk.left) dx -= 1; if (pk.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
    spd = PLAYER_SPEED * dt / 1000;
  }
  if (dx !== 0 || dy !== 0) { p.facing = Math.atan2(dy, dx); p.walkFrame += dt / 180; }
  else { p.walkFrame = 0; }
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
  const MS = carryLimit(gs, playerNum);
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
    } else if (p.held.food === s.produces && !p.held.burned && p.held.count < MS) {
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
      const converts = Math.min(p.held.count, readyPatties.length, MS);
      if (converts > 0) {
        const cheeseCost = (FOOD.get('cheese')?.cost ?? 0) * converts;
        gs.score -= cheeseCost; gs.levelCOGS += cheeseCost;
        for (let i = 0; i < converts; i++) {
          readyPatties[i].food = null; readyPatties[i].state = 'empty'; readyPatties[i].timer = 0;
        }
        p.held = { food: 'cheese_patty', count: converts, burned: false };
        incrementStat('cheese_melted', converts);
        { const xp = awardXP(1); xpBreakdown.actions += xp;
          spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
      }
      return;
    }

    // Place raw food (consume one from stack) — charge cost on use
    if (p.held && !p.held.burned && def?.isRaw && def.station === s.kind) {
      if (placeOnStation(s, p.held.food)) {
        const cost = def.cost ?? 0;
        gs.score -= cost; gs.levelCOGS += cost;
        if (s.kind === 'grill') {
          incrementStat('grill_uses', 1);
          { const xp = awardXP(1); xpBreakdown.cooking += xp;
            spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
        }
        if (s.kind === 'fryer') {
          incrementStat('fryer_uses', 1);
          const fryXP = p.held?.food === 'raw_rings' ? 10000 : 1;
          { const xp = awardXP(fryXP); xpBreakdown.cooking += xp;
            spawnFloat(p.x, p.y - 30, `+${xp} XP${fryXP === 1000 ? ' 🐶' : ''}`, '#6af'); }
        }
        if (p.held.food === 'raw_pork' && s.kind === 'smoker') {
          { const xp = awardXP(3); xpBreakdown.cooking += xp;
            spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
        }
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
          (isBurned && p.held.burned && p.held.food === cookedId && p.held.count < MS) ||
          (!p.held.burned && !heldIsRaw && p.held.food === cookedId &&
           p.held.count < MS && !isBurned);
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
        else if (p.held.food === 'pork' && p.held.burned && p.held.count < MS) { p.held.count++; gs.chopOutput--; }
      } else if (p.held === null || (p.held.food === 'pork' && !p.held.burned && p.held.count < MS)) {
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
      const spoiledIdx = gs.staged.findIndex(si => si.spoiled && si.food === p.held!.food && p.held!.count < MS);
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
          { const xp = awardXP(1); xpBreakdown.orders += xp;
            spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
          if (o.items.every(i => i.done)) {
            o.status = 'plating';
            gs.plates.push({ orderId: o.id, name: o.name, spoilTimer: o.spoilTimer });
            incrementStat('plates_completed', 1);
            { const xp = awardXP(1); xpBreakdown.orders += xp;
              spawnFloat(p.x, p.y - 50, `+${xp} XP (plate!)`, '#adf'); }
          }
          return;
        }
      }
      // No order needs it yet — stage it on the prep table (+1 XP for placing food)
      const stageCount = (p.held.food === 'fries' || p.held.food === 'rings') ? 2 : 1;
      gs.staged.push({ food: p.held.food, spoilTimer: 0, spoiled: false, count: stageCount });
      { const xp = awardXP(1); xpBreakdown.orders += xp;
        spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
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
        const sat = calcOrderSatisfaction(order);
        gs.levelSatisfactionSum += sat;
        gs.levelSatisfactionCount++;
        order.status = 'failed'; // remove from ticket board
        // Charge the special meter
        if (hasUnlock('spec_meter')) gs.meter = Math.min(100, gs.meter + 25);
        { const xp = awardXP(1); xpBreakdown.delivery += xp;
          spawnFloat(p.x, p.y - 30, `+${xp} XP`, '#6af'); }
        if (sat === 100) {
          const xp = awardXP(5); xpBreakdown.delivery += xp;
          spawnFloat(p.x, p.y - 50, `+${xp} XP!`, '#4f8');
        }
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
