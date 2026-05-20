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
    // ── Back wall: 3 grills + 3 fryers ────────────────────────────────────────
    {
      id: 'grill1', kind: 'grill',
      x: KX + 10, y: KY + 8, w: 130, h: 90,
      label: 'GRILL 1', color: '#555',
      slotRows: 2,
      slots: Array.from({ length: 8 }, () => slot()),
    },
    {
      id: 'grill2', kind: 'grill',
      x: KX + 148, y: KY + 8, w: 130, h: 90,
      label: 'GRILL 2', color: '#555',
      slotRows: 2,
      slots: Array.from({ length: 8 }, () => slot()),
    },
    {
      id: 'grill3', kind: 'grill',
      x: KX + 286, y: KY + 8, w: 130, h: 90,
      label: 'GRILL 3', color: '#555',
      slotRows: 2,
      slots: Array.from({ length: 8 }, () => slot()),
    },
    {
      id: 'fryer1', kind: 'fryer',
      x: KX + 424, y: KY + 8, w: 76, h: 90,
      label: 'FRYER 1', color: '#446',
      slots: Array.from({ length: 2 }, () => slot()),
    },
    {
      id: 'fryer2', kind: 'fryer',
      x: KX + 508, y: KY + 8, w: 76, h: 90,
      label: 'FRYER 2', color: '#446',
      slots: Array.from({ length: 2 }, () => slot()),
    },
    {
      id: 'fryer3', kind: 'fryer',
      x: KX + 592, y: KY + 8, w: 76, h: 90,
      label: 'FRYER 3', color: '#446',
      slots: Array.from({ length: 2 }, () => slot()),
    },

    // ── Right wall: cooler & freezer ──────────────────────────────────────────
    {
      id: 'cooler', kind: 'cooler',
      x: KX + KW - 92, y: KY + 20, w: 92, h: 130,
      label: 'COOLER', color: '#1a2a3a',
      slots: [],
      menu: ['raw_patty', 'raw_hotdog', 'raw_pork', 'cheese'],
    },
    {
      id: 'freezer', kind: 'freezer',
      x: KX + KW - 92, y: KY + 165, w: 92, h: 120,
      label: 'FREEZER', color: '#0a1a2e',
      slots: [],
      menu: ['raw_fries', 'raw_rings'],
    },

    // ── Left wall: 2 smokers + 2 warmers ─────────────────────────────────────
    // x=10, w=100 → right edge=110; gap to grill1 (x=170) = 60px so the
    // player (radius 18, needs 36px) can walk the corridor to reach them.
    // Vertical gaps of 50px between stations for the same reason.
    {
      id: 'smoker', kind: 'smoker',
      x: 10, y: KY + 10, w: 100, h: 65,
      label: 'SMOKER 1', color: '#543',
      slotRows: 2,
      slots: Array.from({ length: 4 }, () => slot()),
    },
    {
      id: 'smoker2', kind: 'smoker',
      x: 10, y: KY + 125, w: 100, h: 65,
      label: 'SMOKER 2', color: '#543',
      slotRows: 2,
      slots: Array.from({ length: 4 }, () => slot()),
    },
    {
      id: 'warmer', kind: 'warmer',
      x: 10, y: KY + 240, w: 100, h: 65,
      label: 'WARMER 1', color: '#7a4020',
      slotRows: 2,
      slots: Array.from({ length: 4 }, () => slot()),
    },
    {
      id: 'warmer2', kind: 'warmer',
      x: 10, y: KY + 355, w: 100, h: 65,
      label: 'WARMER 2', color: '#7a4020',
      slotRows: 2,
      slots: Array.from({ length: 4 }, () => slot()),
    },

    // ── Front wall (left → right) ─────────────────────────────────────────────
    {
      id: 'trash', kind: 'trash',
      x: 155, y: KY + KH - 98, w: 58, h: 90,
      label: 'TRASH', color: '#333',
      slots: [],
    },
    {
      id: 'chop', kind: 'chop',
      x: 351, y: KY + KH - 98, w: 100, h: 90,
      label: 'CHOP', color: '#765',
      slots: [],
    },
    {
      id: 'prep', kind: 'prep',
      x: 461, y: KY + KH - 98, w: 184, h: 90,
      label: 'PREP 1', color: '#484',
      slots: [],
    },
    {
      id: 'prep2', kind: 'prep',
      x: 655, y: KY + KH - 98, w: 184, h: 90,
      label: 'PREP 2', color: '#484',
      slots: [],
    },
    {
      id: 'service_counter', kind: 'counter',
      x: 849, y: KY + KH - 98, w: 118, h: 90,
      label: 'SERVICE', color: '#448',
      slots: [],
    },
  ];
}

// ─── Cooking tick ─────────────────────────────────────────────────────────────

export function tickCooking(
  stations: Station[], dt: number,
  onSlotReady?: (food: FoodId, kind: Station['kind']) => void,
): void {
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
        onSlotReady?.(slot.food!, s.kind);
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
      delete slot.smokerPlacedLevel; delete slot.smokerPlacedAtTimer; delete slot.smokerPlacedDuringPrep;
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
      delete slot.smokerPlacedLevel; delete slot.smokerPlacedAtTimer; delete slot.smokerPlacedDuringPrep;
      if (!cooked) return null;
      return { food: cooked, burned: false };
    }
    if (slot.state === 'burned') {
      const food = slot.food!;
      slot.food = null; slot.state = 'empty'; slot.timer = 0;
      delete slot.smokerPlacedLevel; delete slot.smokerPlacedAtTimer; delete slot.smokerPlacedDuringPrep;
      return { food, burned: true };
    }
  }
  return null;
}
