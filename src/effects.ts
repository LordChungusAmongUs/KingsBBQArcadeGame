export interface FloatEffect {
  x: number; y: number;
  text: string; color: string;
  age: number; lifetime: number;
}

const _effects: FloatEffect[] = [];

export function spawnFloat(x: number, y: number, text: string, color: string, lifetime = 1300): void {
  _effects.push({ x, y, text, color, age: 0, lifetime });
}

export function tickFloats(dt: number): void {
  for (let i = _effects.length - 1; i >= 0; i--) {
    _effects[i].age += dt;
    if (_effects[i].age >= _effects[i].lifetime) _effects.splice(i, 1);
  }
}

export function getFloats(): readonly FloatEffect[] { return _effects; }

// ── Per-game XP breakdown ─────────────────────────────────────────────────────

export interface XPBreakdown {
  cooking:  number;  // grill / fryer / smoker completions
  orders:   number;  // plating completed orders
  delivery: number;  // serving at counter
  actions:  number;  // chops, cheese melts
}

export const xpBreakdown: XPBreakdown = { cooking: 0, orders: 0, delivery: 0, actions: 0 };

export function resetXPBreakdown(): void {
  xpBreakdown.cooking = 0;
  xpBreakdown.orders  = 0;
  xpBreakdown.delivery = 0;
  xpBreakdown.actions  = 0;
}

export function xpBreakdownTotal(): number {
  return xpBreakdown.cooking + xpBreakdown.orders + xpBreakdown.delivery + xpBreakdown.actions;
}
