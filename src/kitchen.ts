import type { Station, CookSlot, FoodId } from './types';
import { FOOD } from './config';

// ─── Kitchen layout constants ─────────────────────────────────────────────────

export const KX = 160;   // kitchen left edge (world x)
export const KY = 130;   // kitchen top edge (world y)
export const KW = 820;   // kitchen width
export const KH = 490;   // kitchen height

function slot(food: FoodId | null = null): CookSlot {
  return { food, timer: 0, state: food ? 'cooking' : 'empty' };
}

export function buildStations(): Station[] {
  return [
    // ── Back wall ──────────────────────────────────────────────────────────────
    {
      id: 'grill1', kind: 'grill',
      x: KX + 30, y: KY + 8, w: 130, h: 90,
      label: 'GRILL 1', color: '#555',
      slotRows: 2,
      slots: Array.from({ length: 8 }, () => slot()),
    },
    {
      id: 'grill2', kind: 'grill',
      x: KX + 168, y: KY + 8, w: 130, h: 90,
      label: 'GRILL 2', color: '#555',
      slotRows: 2,
      slots: Array.from({ length: 8 }, () => slot()),
    },
    {
      id: 'fryer1', kind: 'fryer',
      x: KX + 306, y: KY + 8, w: 76, h: 90,
      label: 'FRYER 1', color: '#446',
      slots: Array.from({ length: 2 }, () => slot()),
    },
    {
      id: 'fryer2', kind: 'fryer',
      x: KX + 390, y: KY + 8, w: 76, h: 90,
      label: 'FRYER 2', color: '#446',
      slots: Array.from({ length: 2 }, () => slot()),
    },

    // ── Cooler & Freezer (back wall right) ────────────────────────────────────
    {
      id: 'cooler', kind: 'cooler',
      x: KX + 480, y: KY + 8, w: 155, h: 90,
      label: 'COOLER', color: '#1a2a3a',
      slots: [],
      menu: ['raw_patty', 'raw_hotdog', 'raw_pork', 'cheese'],
    },
    {
      id: 'freezer', kind: 'freezer',
      x: KX + 645, y: KY + 8, w: 130, h: 90,
      label: 'FREEZER', color: '#0a1a2e',
      slots: [],
      menu: ['raw_fries', 'raw_rings'],
    },

    // ── Smoker (left wall) ────────────────────────────────────────────────────
    {
      id: 'smoker', kind: 'smoker',
      x: KX - 130, y: KY + 20, w: 120, h: 100,
      label: 'SMOKER', color: '#543',
      slotRows: 2,
      slots: Array.from({ length: 4 }, () => slot()),
    },

    // ── Front area ─────────────────────────────────────────────────────────────
    {
      id: 'chop', kind: 'chop',
      x: 50, y: KY + KH - 98, w: 100, h: 90,
      label: 'CHOP', color: '#765',
      slots: [],
    },
    {
      id: 'prep', kind: 'prep',
      x: KX + 30, y: KY + KH - 98, w: 390, h: 90,
      label: 'PREP TABLE', color: '#484',
      slots: [],
    },
    {
      id: 'counter', kind: 'counter',
      x: KX + 440, y: KY + KH - 98, w: 200, h: 90,
      label: 'COUNTER', color: '#448',
      slots: [],
    },
    {
      id: 'trash', kind: 'trash',
      x: KX + 655, y: KY + KH - 98, w: 80, h: 90,
      label: 'TRASH', color: '#333',
      slots: [],
    },
  ];
}

// ─── Cooking tick ─────────────────────────────────────────────────────────────

export function tickCooking(stations: Station[], dt: number): void {
  for (const s of stations) {
    if (s.kind !== 'grill' && s.kind !== 'fryer' && s.kind !== 'smoker') continue;
    for (const slot of s.slots) {
      if (slot.state !== 'cooking' && slot.state !== 'ready') continue;
      if (slot.smokerPlacedLevel !== undefined && slot.state === 'cooking') continue;
      const def = slot.food ? FOOD.get(slot.food) : null;
      if (!def) continue;
      slot.timer += dt;
      if (slot.state === 'cooking' && slot.timer >= def.cookTime) {
        slot.state = 'ready';
        slot.timer = 0;
      } else if (slot.state === 'ready' && slot.timer >= def.burnTime) {
        slot.state = 'burned';
      }
    }
  }
}

// ─── Interaction helpers ──────────────────────────────────────────────────────

export function distToStation(px: number, py: number, s: Station): number {
  // Distance from point to nearest edge of station rect (0 if inside)
  const nearX = Math.max(s.x, Math.min(px, s.x + s.w));
  const nearY = Math.max(s.y, Math.min(py, s.y + s.h));
  return Math.hypot(px - nearX, py - nearY);
}

export function nearestStation(px: number, py: number, stations: Station[], range: number): Station | null {
  let best: Station | null = null;
  let bestD = range;
  for (const s of stations) {
    const d = distToStation(px, py, s);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

export function placeOnStation(s: Station, food: FoodId): boolean {
  for (const slot of s.slots) {
    if (slot.state === 'empty') {
      slot.food = food;
      slot.state = 'cooking';
      slot.timer = 0;
      slot.smokerPlacedLevel = undefined;
      slot.smokerPlacedAtTimer = undefined;
      return true;
    }
  }
  return false;
}

// Returns { food, burned } for the first ready-or-burned slot, null if none.
export function pickupFromStation(s: Station): { food: FoodId; burned: boolean } | null {
  for (const slot of s.slots) {
    if (slot.state === 'ready') {
      const def = slot.food ? FOOD.get(slot.food) : null;
      const cooked = def?.rawOf ?? null;
      slot.food = null; slot.state = 'empty'; slot.timer = 0;
      slot.smokerPlacedLevel = undefined; slot.smokerPlacedAtTimer = undefined;
      if (!cooked) return null;
      return { food: cooked, burned: false };
    }
    if (slot.state === 'burned') {
      const food = slot.food!;
      slot.food = null; slot.state = 'empty'; slot.timer = 0;
      slot.smokerPlacedLevel = undefined; slot.smokerPlacedAtTimer = undefined;
      return { food, burned: true };
    }
  }
  return null;
}
