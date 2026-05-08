import type { GameState, Station, Order, FoodId, CookSlot, StagedItem } from './types';
import { FOOD, LEVELS, INTERACT_RANGE, PARTIAL_SPOIL_TIME, STAGED_SPOIL_TIME, OVERHEAD_COST } from './config';
import { nearestStation } from './kitchen';
import { getFloats, tickFloats } from './effects';
import { xpProgress, getProfile } from './profile';

// ─── Order name abbreviations ─────────────────────────────────────────────────

const ORDER_ABBR: Record<string, string> = {
  'Hamburger':        'HMB',
  'Cheeseburger':     'CHZ BRGR',
  'Dbl Burger':       'DBL HMB',
  'Dbl Cheeseburger': 'DBL CHZ BRGR',
  'BBQ Sand.':        'BBQ SAND',
  'BBQ Plate':        'BBQ PLATE',
  'Hotdog':           'HOT DOG',
  'Sm Fry':           'SM FF',
  'Lg Fry':           'LG FF',
  'Sm Pup':           'SM PUPS',
  'Lg Pup':           'LG PUPS',
};

function abbrOrder(name: string): [string, string] {
  if (ORDER_ABBR[name]) return [ORDER_ABBR[name], ''];
  const plus = name.indexOf('+');
  if (plus !== -1) {
    const sandwich = name.slice(0, plus);
    const side     = name.slice(plus + 1);
    return [`${ORDER_ABBR[sandwich] ?? sandwich} COMBO`, ORDER_ABBR[side] ?? side];
  }
  return [name, ''];
}

let ctx: CanvasRenderingContext2D;
let W = 0, H = 0;

// Run-level financial stats for the HUD (updated each frame from main.ts)
let _hudRun = { sales: 0, cogs: 0, labor: 0, waste: 0, overhead: 0, satSum: 0, satCount: 0 };
export function updateHUDRunStats(sales: number, cogs: number, labor: number, waste: number, overhead: number, satSum = 0, satCount = 0): void {
  _hudRun = { sales, cogs, labor, waste, overhead, satSum, satCount };
}

// ─── Sprite cache ─────────────────────────────────────────────────────────────

const _sprites: Partial<Record<string, HTMLImageElement>> = {};

export function loadSprites(): void {
  const keys = [
    'p1m_down_idle',  'p1m_down_walk1',  'p1m_down_walk2',
    'p1m_up_idle',    'p1m_up_walk1',    'p1m_up_walk2',
    'p1m_left_idle',  'p1m_left_walk1',  'p1m_left_walk2',
  ];
  for (const key of keys) {
    const img = new Image();
    img.src = `/images/${key}.png`;
    img.onload = () => { _sprites[key] = img; };
  }
}

export function initRenderer(canvas: HTMLCanvasElement): void {
  ctx = canvas.getContext('2d')!;
  W = canvas.width; H = canvas.height;
}

export function resizeRenderer(canvas: HTMLCanvasElement): void {
  W = canvas.width; H = canvas.height;
}

export function render(gs: GameState): void {
  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#1a1008';
  ctx.fillRect(0, 0, W, H);

  drawKitchenFloor();
  drawStations(gs);
  drawPlayer(gs);
  drawOrderStrip(gs);
  drawHUD(gs);

  if (gs.prepTimer > 0) drawPrepOverlay(gs);
  if (gs.phase === 'level_end') drawOverlay(gs, true);
  if (gs.phase === 'game_over') drawOverlay(gs, false);
  drawFloats();
}

let _lastFloatTick = 0;
function drawFloats(): void {
  const now = performance.now();
  const dt = _lastFloatTick ? Math.min(now - _lastFloatTick, 100) : 16;
  _lastFloatTick = now;
  tickFloats(dt);
  const effects = getFloats();
  if (!effects.length) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const e of effects) {
    const t = e.age / e.lifetime;
    const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const yOff  = -t * 48; // rise 48px over lifetime
    ctx.globalAlpha = alpha;
    const isLevelUp = e.text === 'LVL UP!';
    ctx.font = isLevelUp ? 'bold 18px monospace' : 'bold 14px monospace';
    // outline for readability
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 3;
    ctx.strokeText(e.text, e.x, e.y + yOff);
    ctx.fillStyle = e.color;
    ctx.fillText(e.text, e.x, e.y + yOff);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─── Kitchen floor ────────────────────────────────────────────────────────────

function drawKitchenFloor(): void {
  const kx = 160, ky = 130, kw = 820, kh = 490;
  ctx.fillStyle = '#3a2e20';
  ctx.fillRect(kx - 120, ky, kw + 120, kh);
  // Floor tiles
  ctx.strokeStyle = '#2e2418';
  ctx.lineWidth = 1;
  for (let x = kx - 120; x < kx + kw; x += 60) {
    ctx.beginPath(); ctx.moveTo(x, ky); ctx.lineTo(x, ky + kh); ctx.stroke();
  }
  for (let y = ky; y < ky + kh; y += 60) {
    ctx.beginPath(); ctx.moveTo(kx - 120, y); ctx.lineTo(kx + kw, y); ctx.stroke();
  }
  // Walls
  ctx.fillStyle = '#2a1e14';
  ctx.fillRect(kx + kw, ky, 200, kh);
  ctx.fillRect(0, ky, kx - 120, kh);
}

// ─── Stations ─────────────────────────────────────────────────────────────────

function drawStations(gs: GameState): void {
  const nearSt  = nearestStation(gs.player.x,  gs.player.y,  gs.stations, INTERACT_RANGE);
  const nearSt2 = gs.player2 ? nearestStation(gs.player2.x, gs.player2.y, gs.stations, INTERACT_RANGE) : null;
  const nearSt3 = gs.player3 ? nearestStation(gs.player3.x, gs.player3.y, gs.stations, INTERACT_RANGE) : null;
  const nearSt4 = gs.player4 ? nearestStation(gs.player4.x, gs.player4.y, gs.stations, INTERACT_RANGE) : null;

  for (const s of gs.stations) {
    const hl1 = s === nearSt;
    const hl2 = s === nearSt2;
    const hl3 = s === nearSt3;
    const hl4 = s === nearSt4;

    if (s.kind === 'supply') continue; // no supply stations in current layout

    if (s.kind === 'cooler' || s.kind === 'freezer') {
      drawCoolerFreezer(gs, s, hl1, hl2);
      continue;
    }

    // Station body
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    if (hl1) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
    }
    if (hl2) {
      ctx.strokeStyle = '#44aaff';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 3, s.y + 3, s.w - 6, s.h - 6);
    }
    if (hl3) {
      ctx.strokeStyle = '#44cc44';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 5, s.y + 5, s.w - 10, s.h - 10);
    }
    if (hl4) {
      ctx.strokeStyle = '#f0c020';
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 7, s.y + 7, s.w - 14, s.h - 14);
    }

    // Label
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(s.label, s.x + s.w / 2, s.y + 14);

    // Cook slots
    if (s.kind === 'warmer') {
      ctx.strokeStyle = '#c06020';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      drawWarmerSlots(s);
      if (gs.activeMenu?.stationId === s.id) drawWarmerMenu(gs, s);
    } else if (s.slots.length > 0) {
      drawCookSlots(s);
    }

    // Chop table — three states: empty, loaded (press E to chop), chopping, output ready
    if (s.kind === 'chop') {
      const cx = s.x + s.w / 2;
      if (gs.chopOutput > 0) {
        const spoiled = gs.chopOutputSpoiled;
        const def = FOOD.get('pork');
        ctx.fillStyle = spoiled ? '#c44' : (def?.color ?? '#c8806a');
        ctx.beginPath(); ctx.arc(cx, s.y + s.h / 2 - 6, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
        ctx.fillText(spoiled ? 'BAD!' : `×${gs.chopOutput}`, cx, s.y + s.h / 2 + 10);
        if (!spoiled && gs.chopOutputTimer > 0) {
          const frac = Math.min(1, gs.chopOutputTimer / STAGED_SPOIL_TIME);
          const barW = s.w - 8;
          ctx.fillStyle = '#222'; ctx.fillRect(s.x + 4, s.y + s.h - 12, barW, 4);
          ctx.fillStyle = frac > 0.6 ? '#f44' : frac > 0.3 ? '#fa0' : '#8f4';
          ctx.fillRect(s.x + 4, s.y + s.h - 12, barW * frac, 4);
        }
      } else if (gs.chopStored > 0) {
        const def = FOOD.get('whole_pork');
        ctx.fillStyle = def?.color ?? '#b06050';
        ctx.beginPath(); ctx.arc(cx, s.y + s.h / 2 - 6, 12, 0, Math.PI * 2); ctx.fill();
        if (gs.chopProgress === 0) {
          ctx.fillStyle = '#ff8'; ctx.font = '7px monospace'; ctx.textAlign = 'center';
          ctx.fillText('E to chop', cx, s.y + s.h / 2 + 10);
        }
      } else {
        ctx.fillStyle = '#777'; ctx.font = '7px monospace'; ctx.textAlign = 'center';
        ctx.fillText('place whole', cx, s.y + s.h / 2);
        ctx.fillText('pork here', cx, s.y + s.h / 2 + 10);
      }
      if (gs.chopProgress > 1) {
        const frac = Math.min(1, gs.chopProgress / 2000);
        ctx.fillStyle = '#222'; ctx.fillRect(s.x + 4, s.y + s.h - 12, s.w - 8, 6);
        ctx.fillStyle = '#fa0';  ctx.fillRect(s.x + 4, s.y + s.h - 12, (s.w - 8) * frac, 6);
      }
    }

    // Prep table — order progress cards + completed plates
    if (s.kind === 'prep') {
      drawPrepTable(gs, s);
    }

    // Counter prompt
    if (s.kind === 'counter') {
      ctx.fillStyle = '#aaf';
      ctx.font = '10px monospace';
      ctx.fillText('deliver here', s.x + s.w / 2, s.y + s.h / 2 + 4);
    }

    if (s.kind === 'trash') {
      ctx.fillStyle = '#888';
      ctx.font = '18px monospace';
      ctx.fillText('🗑', s.x + s.w / 2, s.y + s.h / 2 + 6);
    }
  }
}

function drawCookSlots(s: Station): void {
  const rows = s.slotRows ?? 1;
  const cols = Math.ceil(s.slots.length / rows);
  const PAD = 6, HEADER = 16;
  const sw = Math.floor((s.w - PAD * 2) / cols);
  const sh = Math.floor((s.h - HEADER - PAD) / rows);
  const dotR = Math.max(3, Math.floor(Math.min(sw, sh) * 0.28));
  const barH = Math.max(2, Math.floor(sh * 0.14));
  const blink = Math.floor(Date.now() / 300) % 2 === 0;

  for (let i = 0; i < s.slots.length; i++) {
    const slot = s.slots[i];
    if (!slot) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sx = s.x + PAD + col * sw;
    const sy = s.y + HEADER + row * sh;
    const cx = sx + sw / 2;
    const cy = sy + sh / 2 - barH / 2;

    ctx.fillStyle = slotBg(slot);
    ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);

    if (slot.food) {
      const def = FOOD.get(slot.food);
      ctx.fillStyle = def?.color ?? '#888';
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fill();

      if (slot.state === 'cooking' && slot.smokerPlacedLevel !== undefined) {
        ctx.fillStyle = '#88aacc';
        ctx.font = `bold ${Math.max(6, dotR - 1)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('NEXT', cx, sy + sh - barH - 2);
      } else if (slot.state === 'cooking' && def) {
        const pct = slot.timer / def.cookTime;
        ctx.fillStyle = '#0a0';
        ctx.fillRect(sx + 2, sy + sh - barH - 2, (sw - 4) * pct, barH);
      }
      if (slot.state === 'ready') {
        const def2 = FOOD.get(slot.food)!;
        const burnPct = slot.timer / def2.burnTime;
        if (burnPct > 0.6) {
          ctx.fillStyle = `rgba(255,60,0,${0.3 + 0.4 * burnPct})`;
          ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);
        }
        if (blink) {
          ctx.strokeStyle = '#0f0'; ctx.lineWidth = 1;
          ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
        }
      }
      if (slot.state === 'burned') {
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);
        ctx.strokeStyle = '#f44'; ctx.lineWidth = 1;
        ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
        if (dotR >= 5) {
          ctx.fillStyle = '#f44';
          ctx.font = `bold ${dotR + 2}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText('✕', cx, cy + Math.floor(dotR * 0.4));
        }
      }
    }
  }
}

function slotBg(slot: CookSlot): string {
  if (slot.state === 'empty')  return '#222';
  if (slot.state === 'burned') return '#300';
  if (slot.state === 'ready')  return '#030';
  return '#1a1a1a';
}

function drawWarmerSlots(s: Station): void {
  const rows = s.slotRows ?? 2;
  const cols = Math.ceil(s.slots.length / rows);
  const PAD = 6, HEADER = 16;
  const sw = Math.floor((s.w - PAD * 2) / cols);
  const sh = Math.floor((s.h - HEADER - PAD) / rows);
  const dotR = Math.max(4, Math.floor(Math.min(sw, sh) * 0.3));

  for (let i = 0; i < s.slots.length; i++) {
    const slot = s.slots[i];
    if (!slot) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const sx = s.x + PAD + col * sw;
    const sy = s.y + HEADER + row * sh;
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;

    const isBurned = slot.state === 'burned';
    ctx.fillStyle = isBurned ? '#2a0000' : slot.food ? '#2a1800' : '#111008';
    ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);

    if (slot.food) {
      const def = FOOD.get(slot.food);
      ctx.fillStyle = isBurned ? '#555' : (def?.color ?? '#aaa');
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isBurned ? '#c00' : '#f84';
      ctx.lineWidth = isBurned ? 2 : 1;
      ctx.strokeRect(sx + 1, sy + 1, sw - 2, sh - 2);
    }
  }
}

// Direction → slot-index mapping (mirrors game.ts logic)
function menuSlotLayout(count: number): Array<{ idx: number; dx: number; dy: number; arrow: string }> {
  if (count === 1) return [{ idx: 0, dx: 0, dy: -1, arrow: '↑' }];
  if (count === 2) return [
    { idx: 0, dx: -1, dy: 0, arrow: '←' },
    { idx: 1, dx:  1, dy: 0, arrow: '→' },
  ];
  if (count === 3) return [
    { idx: 0, dx:  0, dy: -1, arrow: '↑' },
    { idx: 1, dx: -1, dy:  0, arrow: '←' },
    { idx: 2, dx:  1, dy:  0, arrow: '→' },
  ];
  return [
    { idx: 0, dx:  0, dy: -1, arrow: '↑' },
    { idx: 1, dx: -1, dy:  0, arrow: '←' },
    { idx: 2, dx:  1, dy:  0, arrow: '→' },
    { idx: 3, dx:  0, dy:  1, arrow: '↓' },
  ];
}

function drawWarmerMenu(gs: GameState, s: Station): void {
  const slotCount = Math.min(s.slots.length, 4);
  if (slotCount === 0) return;

  const layout = menuSlotLayout(slotCount);
  const CW = 72, CH = 58, STEP = 72;
  const popCX = s.x + s.w + 90;
  const popCY = s.y + s.h / 2;

  const xs = layout.map(p => popCX + p.dx * STEP);
  const ys = layout.map(p => popCY + p.dy * STEP);
  const bx = Math.min(...xs) - CW / 2 - 14;
  const by = Math.min(...ys) - CH / 2 - 14;
  const bw = Math.max(...xs) - Math.min(...xs) + CW + 28;
  const bh = Math.max(...ys) - Math.min(...ys) + CH + 28;

  ctx.fillStyle = 'rgba(18,8,0,0.94)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = '#c06020'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.stroke();

  ctx.fillStyle = '#f84'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
  ctx.fillText('WARMER', bx + bw / 2, by + 14);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (const pos of layout) {
    ctx.beginPath();
    ctx.moveTo(popCX, popCY);
    ctx.lineTo(popCX + pos.dx * STEP, popCY + pos.dy * STEP);
    ctx.stroke();
  }

  for (const pos of layout) {
    const slot = s.slots[pos.idx];
    const isBurned = slot?.state === 'burned';
    const food = (slot?.state === 'ready' || isBurned) ? slot!.food : null;
    const def = food ? FOOD.get(food) : null;
    const cx = popCX + pos.dx * STEP;
    const cy = popCY + pos.dy * STEP;
    const lx = cx - CW / 2, ly = cy - CH / 2;

    ctx.fillStyle = isBurned ? '#2a0000' : food ? '#2a1400' : '#111008';
    ctx.beginPath(); ctx.roundRect(lx, ly, CW, CH, 5); ctx.fill();
    ctx.strokeStyle = isBurned ? '#c00' : food ? '#c06020' : '#444';
    ctx.lineWidth = isBurned ? 2 : 1.5;
    ctx.beginPath(); ctx.roundRect(lx, ly, CW, CH, 5); ctx.stroke();

    ctx.fillStyle = '#f84';
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left';
    ctx.fillText(pos.arrow, lx + 5, ly + 14);

    if (food && def) {
      ctx.fillStyle = isBurned ? '#555' : def.color ?? '#aaa';
      ctx.beginPath(); ctx.arc(cx, cy - 2, 13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isBurned ? '#c00' : 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = isBurned ? '#f44' : '#ccd'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(isBurned ? 'SPOILED' : (def.name ?? food), cx, ly + CH - 6);
    } else {
      ctx.fillStyle = '#555'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('EMPTY', cx, cy + 4);
    }
  }

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.arc(popCX, popCY, 5, 0, Math.PI * 2); ctx.fill();
}

function drawCoolerFreezer(gs: GameState, s: Station, highlight: boolean, highlight2 = false): void {
  const isCooler = s.kind === 'cooler';
  const accent = isCooler ? '#5ac8fa' : '#4a8fff';

  // Station body
  ctx.fillStyle = isCooler ? '#182430' : '#0e1828';
  ctx.fillRect(s.x, s.y, s.w, s.h);
  ctx.strokeStyle = accent; ctx.lineWidth = 1;
  ctx.strokeRect(s.x, s.y, s.w, s.h);
  if (highlight) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  }
  if (highlight2) {
    ctx.strokeStyle = '#44aaff'; ctx.lineWidth = 2;
    ctx.strokeRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
  }

  ctx.fillStyle = accent;
  ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
  ctx.fillText(s.label, s.x + s.w / 2, s.y + 14);

  // Item dots on the station face
  const menu = s.menu ?? [];
  const step = (s.w - 20) / Math.max(menu.length, 1);
  menu.forEach((food, i) => {
    const def = FOOD.get(food);
    const cx = s.x + 10 + step * i + step / 2;
    const cy = s.y + s.h / 2 + 8;
    ctx.fillStyle = def?.color ?? '#888';
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
  });

  // Radial popup (Skyward Sword style)
  if (gs.activeMenu?.stationId !== s.id) return;

  const layout = menuSlotLayout(menu.length);
  const CW = 72, CH = 58, STEP = 72; // cell size & radial offset
  const popCX = s.x + s.w / 2;
  const popCY = s.y + s.h + 20 + CH; // below station

  // Background panel — bounding box of all slots + padding
  const xs = layout.map(p => popCX + p.dx * STEP);
  const ys = layout.map(p => popCY + p.dy * STEP);
  const bx = Math.min(...xs) - CW / 2 - 14;
  const by = Math.min(...ys) - CH / 2 - 14;
  const bw = Math.max(...xs) - Math.min(...xs) + CW + 28;
  const bh = Math.max(...ys) - Math.min(...ys) + CH + 28;

  ctx.fillStyle = 'rgba(6,10,18,0.94)';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.stroke();

  // Station name inside panel
  ctx.fillStyle = accent; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
  ctx.fillText(s.label, bx + bw / 2, by + 14);

  // Cross connectors
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  for (const pos of layout) {
    ctx.beginPath();
    ctx.moveTo(popCX, popCY);
    ctx.lineTo(popCX + pos.dx * STEP, popCY + pos.dy * STEP);
    ctx.stroke();
  }

  // Item cells
  for (const pos of layout) {
    const food = menu[pos.idx];
    const def = FOOD.get(food);
    const cx = popCX + pos.dx * STEP;
    const cy = popCY + pos.dy * STEP;
    const lx = cx - CW / 2, ly = cy - CH / 2;

    // Cell background
    ctx.fillStyle = '#1c2438';
    ctx.beginPath(); ctx.roundRect(lx, ly, CW, CH, 5); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(lx, ly, CW, CH, 5); ctx.stroke();

    // Arrow key badge (top-left)
    ctx.fillStyle = accent;
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left';
    ctx.fillText(pos.arrow, lx + 5, ly + 14);

    // Food dot
    ctx.fillStyle = def?.color ?? '#888';
    ctx.beginPath(); ctx.arc(cx, cy - 2, 13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.stroke();

    // Food name
    ctx.fillStyle = '#ccd'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
    const shortName = (def?.name ?? food).replace('Raw ', '');
    ctx.fillText(shortName, cx, ly + CH - 6);
  }

  // Center dot
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath(); ctx.arc(popCX, popCY, 5, 0, Math.PI * 2); ctx.fill();
}

function drawPrepTable(gs: GameState, s: Station): void {
  const CARD_W = 86;
  const CARD_H = s.h - 14;
  const GAP = 5;
  let slotX = s.x + 6;
  const slotY = s.y + 7;

  const partials = gs.orders.filter(o => o.status === 'active' && o.items.some(i => i.done));

  // Partial plates
  for (const o of partials) {
    if (slotX + CARD_W > s.x + s.w) break;
    const spoilFrac = Math.min(1, o.spoilTimer / PARTIAL_SPOIL_TIME);
    const urgent = spoilFrac > 0.65;

    ctx.fillStyle = urgent ? '#3a1500' : '#182018';
    ctx.fillRect(slotX, slotY, CARD_W, CARD_H);
    ctx.strokeStyle = urgent ? '#f84' : '#4a6040';
    ctx.lineWidth = 1;
    ctx.strokeRect(slotX, slotY, CARD_W, CARD_H);

    // Order name
    ctx.fillStyle = '#99a'; ctx.font = '7px monospace'; ctx.textAlign = 'left';
    ctx.fillText(o.name.slice(0, 11), slotX + 4, slotY + 9);

    // Plate oval
    const plateCY = slotY + CARD_H / 2 - 4;
    ctx.fillStyle = '#e8e8d8';
    ctx.beginPath();
    ctx.ellipse(slotX + CARD_W / 2, plateCY, CARD_W / 2 - 6, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    // Food dots for done items
    const doneItems = o.items.filter(i => i.done);
    const dotR = 7;
    const dotSpacing = Math.min(20, (CARD_W - 20) / Math.max(doneItems.length, 1));
    const dotStartX = slotX + CARD_W / 2 - (doneItems.length - 1) * dotSpacing / 2;
    doneItems.forEach((item, j) => {
      const def = FOOD.get(item.food);
      ctx.fillStyle = def?.color ?? '#888';
      ctx.beginPath();
      ctx.arc(dotStartX + j * dotSpacing, plateCY, dotR, 0, Math.PI * 2);
      ctx.fill();
    });

    // Spoil timer bar (green → yellow → red)
    const barY = slotY + CARD_H - 9;
    ctx.fillStyle = '#222';
    ctx.fillRect(slotX + 4, barY, CARD_W - 8, 5);
    const barColor = spoilFrac < 0.5 ? '#4c4' : spoilFrac < 0.75 ? '#fc4' : '#f44';
    ctx.fillStyle = barColor;
    ctx.fillRect(slotX + 4, barY, (CARD_W - 8) * (1 - spoilFrac), 5);

    slotX += CARD_W + GAP;
  }

  // Completed ready-to-serve plates
  for (const plate of gs.plates) {
    if (slotX + CARD_W > s.x + s.w) break;

    const plateFrac = Math.min(1, plate.spoilTimer / STAGED_SPOIL_TIME);
    const plateUrgent = plateFrac > 0.65;

    ctx.fillStyle = plateUrgent ? '#3a1500' : '#1a3020';
    ctx.fillRect(slotX, slotY, CARD_W, CARD_H);
    ctx.strokeStyle = plateUrgent ? '#f84' : '#4f4'; ctx.lineWidth = 2;
    ctx.strokeRect(slotX, slotY, CARD_W, CARD_H);

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(slotX + CARD_W / 2, slotY + CARD_H / 2 - 4, CARD_W / 2 - 6, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = plateUrgent ? '#f84' : '#4f4'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
    ctx.fillText('★ READY', slotX + CARD_W / 2, slotY + CARD_H - 18);
    ctx.fillStyle = '#bbb'; ctx.font = '7px monospace';
    ctx.fillText(plate.name.slice(0, 10), slotX + CARD_W / 2, slotY + 10);

    const barY = slotY + CARD_H - 9;
    ctx.fillStyle = '#222'; ctx.fillRect(slotX + 4, barY, CARD_W - 8, 5);
    const barColor = plateFrac < 0.5 ? '#4c4' : plateFrac < 0.75 ? '#fc4' : '#f44';
    ctx.fillStyle = barColor;
    ctx.fillRect(slotX + 4, barY, (CARD_W - 8) * (1 - plateFrac), 5);

    slotX += CARD_W + GAP;
  }

  // Staged items — good (green timer) and spoiled (red, must trash)
  const TOKEN = 36;
  for (const si of gs.staged) {
    if (slotX + TOKEN > s.x + s.w) break;
    const def = FOOD.get(si.food);

    if (si.spoiled) {
      ctx.fillStyle = '#2a0808';
      ctx.fillRect(slotX, slotY, TOKEN, CARD_H);
      ctx.strokeStyle = '#f44'; ctx.lineWidth = 1;
      ctx.strokeRect(slotX, slotY, TOKEN, CARD_H);
      ctx.fillStyle = '#1a0a00';
      ctx.beginPath(); ctx.arc(slotX + TOKEN / 2, slotY + CARD_H / 2 - 4, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f44'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#f44'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('✕', slotX + TOKEN / 2, slotY + CARD_H / 2 - 1);
    } else {
      const frac = Math.min(1, si.spoilTimer / STAGED_SPOIL_TIME);
      ctx.fillStyle = '#1a1a12';
      ctx.fillRect(slotX, slotY, TOKEN, CARD_H);
      ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
      ctx.strokeRect(slotX, slotY, TOKEN, CARD_H);
      ctx.fillStyle = def?.color ?? '#888';
      ctx.beginPath(); ctx.arc(slotX + TOKEN / 2, slotY + CARD_H / 2 - 4, 10, 0, Math.PI * 2); ctx.fill();
      if (si.count > 1) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
        ctx.fillText(`×${si.count}`, slotX + TOKEN / 2, slotY + 10);
      }
      const barY = slotY + CARD_H - 9;
      ctx.fillStyle = '#222'; ctx.fillRect(slotX + 3, barY, TOKEN - 6, 4);
      ctx.fillStyle = frac < 0.5 ? '#4c4' : frac < 0.75 ? '#fc4' : '#f44';
      ctx.fillRect(slotX + 3, barY, (TOKEN - 6) * (1 - frac), 4);
    }

    slotX += TOKEN + 3;
  }

  if (partials.length === 0 && gs.plates.length === 0 && gs.staged.length === 0) {
    ctx.fillStyle = '#444'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('prep table', s.x + s.w / 2, s.y + s.h / 2 + 4);
  }
}


// ─── Player ───────────────────────────────────────────────────────────────────

const SPRITE_W = 128, SPRITE_H = 144;

function facingDir(angle: number): 'up' | 'down' | 'left' | 'right' {
  if (Math.abs(angle) < Math.PI / 4) return 'right';
  if (Math.abs(angle) > (3 * Math.PI) / 4) return 'left';
  return angle > 0 ? 'down' : 'up';
}

function spriteFrame(wf: number, menuOpen: boolean, dir: 'up' | 'down' | 'left' | 'right'): 'idle' | 'walk1' | 'walk2' {
  if (menuOpen || wf === 0) return 'idle';
  const beat = Math.floor((wf / (Math.PI / 2)) % 2) === 0;
  if (dir === 'left' || dir === 'right') return beat ? 'idle' : 'walk1';
  return beat ? 'walk1' : 'walk2';
}

function drawPlayer(gs: GameState): void {
  drawPlayerSprite(gs.player, '#c8402a', gs.activeMenu?.owner === 1);
  if (gs.coop && gs.player2) drawPlayerSprite(gs.player2, '#2060c8', gs.activeMenu?.owner === 2);
  if (gs.player3) drawPlayerSprite(gs.player3, '#28a028', gs.activeMenu?.owner === 3);
  if (gs.player4) drawPlayerSprite(gs.player4, '#c8a020', gs.activeMenu?.owner === 4);
}

function drawPlayerSprite(p: import('./types').Player, apronColor: string, menuOpen = false): void {
  ctx.save();
  ctx.translate(p.x, p.y);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(0, 16, p.radius, 6, 0, 0, Math.PI * 2); ctx.fill();

  const dir = facingDir(p.facing);
  const frame = spriteFrame(p.walkFrame, menuOpen, dir);
  const mirrorRight = dir === 'right';
  const spriteKey = `p1m_${mirrorRight ? 'left' : dir}_${frame}`;
  const img = _sprites[spriteKey];

  // Body
  ctx.save();
  if (mirrorRight) ctx.scale(-1, 1);
  if (img) {
    ctx.drawImage(img, -SPRITE_W / 2, -SPRITE_H / 2, SPRITE_W, SPRITE_H);
  } else {
    // Fallback: procedural character while sprites load
    const bob = menuOpen ? 0 : Math.sin(p.walkFrame) * 2;
    ctx.translate(0, bob);
    ctx.fillStyle = '#e8c87a';
    ctx.beginPath(); ctx.arc(0, 0, p.radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = apronColor;
    ctx.beginPath(); ctx.ellipse(0, 4, p.radius - 4, p.radius * 0.6, 0, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(-8, -p.radius - 10, 16, 12);
    ctx.beginPath(); ctx.ellipse(0, -p.radius - 10, 10, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#333';
    ctx.beginPath(); ctx.arc(Math.cos(p.facing) * 10, Math.sin(p.facing) * 10, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();

  // Held item (world space — never mirrored)
  if (p.held) {
    const holdX = Math.cos(p.facing) * (p.radius + 16);
    const holdY = Math.sin(p.facing) * (p.radius + 16);
    if ((p.held.food as string) === '_plate_') {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(holdX, holdY, 14, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1; ctx.stroke();
    } else if (p.held.burned) {
      ctx.fillStyle = '#1a0a00';
      ctx.beginPath(); ctx.arc(holdX, holdY, 11, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#f44'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#f44'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
      ctx.fillText('✕', holdX, holdY + 3);
    } else {
      const def = FOOD.get(p.held.food);
      ctx.fillStyle = def?.color ?? '#aaa';
      ctx.beginPath(); ctx.arc(holdX, holdY, 11, 0, Math.PI * 2); ctx.fill();
      if (p.held.count > 1) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(holdX + 8, holdY - 8, 8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#222'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
        ctx.fillText(String(p.held.count), holdX + 8, holdY - 5);
      }
    }
  }

  ctx.restore();
}

// ─── Order strip ──────────────────────────────────────────────────────────────

function drawOrderStrip(gs: GameState): void {
  ctx.fillStyle = '#1e1206';
  ctx.fillRect(0, 0, W, 120);
  ctx.fillStyle = '#362010';
  ctx.fillRect(0, 118, W, 2);

  const active = gs.orders.filter(o => o.status === 'active' || o.status === 'plating');
  const stripW = W - 260; // leave right side for HUD
  const tw = Math.min(200, Math.max(130, (stripW - 20) / Math.max(active.length, 1) - 4));

  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    const ox = 10 + i * (tw + 4);
    if (ox + tw > stripW) break;
    const oy = 5;
    const oh = 110;

    const pct = o.elapsed / o.timeLimit;
    const urgent = pct > 0.7;
    const bg = o.status === 'plating' ? '#1a3a1a' : urgent ? '#3a1a0a' : '#2a1a0a';

    ctx.fillStyle = bg;
    ctx.fillRect(ox, oy, tw, oh);
    ctx.strokeStyle = o.status === 'plating' ? '#4f4' : urgent ? '#f84' : '#654';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, tw, oh);

    // Guest number
    const guestNum = String(o.id).padStart(3, '0');
    ctx.fillStyle = urgent ? '#f84' : '#aaa';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`GUEST #${guestNum}`, ox + tw / 2, oy + 14);

    ctx.strokeStyle = '#443'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox + 4, oy + 18); ctx.lineTo(ox + tw - 4, oy + 18); ctx.stroke();

    if (o.status === 'plating') {
      ctx.fillStyle = 'rgba(0,30,0,0.80)';
      ctx.fillRect(ox + 2, oy + 20, tw - 4, oh - 30);
      ctx.fillStyle = '#4f4';
      ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
      ctx.fillText('★ READY ★', ox + tw / 2, oy + oh / 2 + 4);
    } else {
      const [line1, line2] = abbrOrder(o.name);
      ctx.fillStyle = '#ffd';
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      if (line2) {
        ctx.fillText(line1, ox + tw / 2, oy + 42);
        ctx.fillStyle = '#cc9';
        ctx.font = '11px monospace';
        ctx.fillText(line2, ox + tw / 2, oy + 58);
      } else {
        ctx.fillText(line1, ox + tw / 2, oy + 52);
      }
    }

    // Timer bar
    const barY = oy + oh - 9;
    ctx.fillStyle = '#111';
    ctx.fillRect(ox + 3, barY, tw - 6, 5);
    const barColor = pct < 0.5 ? '#4f4' : pct < 0.75 ? '#ff4' : '#f44';
    ctx.fillStyle = barColor;
    ctx.fillRect(ox + 3, barY, (tw - 6) * (1 - pct), 5);
  }

  if (active.length === 0) {
    ctx.fillStyle = '#554';
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('No orders yet...', 20, 62);
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────

function drawHUD(gs: GameState): void {
  const sec = Math.ceil(Math.max(0, gs.levelTimer) / 1000);
  const mm = sec > 5999 ? '99' : String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = sec > 5999 ? '99' : String(sec % 60).padStart(2, '0');

  // Anchor HUD to right wall area (fixed, not window-relative)
  const hudX = Math.min(W - 15, 1168);

  // Compute financials early so we can display sales at the top
  const totSales    = _hudRun.sales    + gs.levelSales;
  const totCOGS     = _hudRun.cogs     + gs.levelCOGS;
  const totLabor    = _hudRun.labor    + gs.levelLabor;
  const totWaste    = _hudRun.waste    + gs.levelWaste;
  const totOverhead = _hudRun.overhead + OVERHEAD_COST;
  const totProfit   = totSales - totCOGS - totLabor - totWaste - totOverhead;
  const totSatSum   = _hudRun.satSum   + gs.levelSatisfactionSum;
  const totSatCount = _hudRun.satCount + gs.levelSatisfactionCount;
  const satPct      = totSatCount > 0 ? Math.round(totSatSum / totSatCount) : null;

  const pct = (n: number) => totSales > 0 ? `${Math.round((n / totSales) * 100)}%` : '--';
  const dollar = (n: number) => {
    const abs = Math.abs(n); const sign = n < 0 ? '-' : '';
    return `${sign}$${(abs / 100).toFixed(2)}`;
  };

  // Semi-transparent backing panel
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  ctx.fillRect(hudX - 183, 125, 188, 460);

  ctx.textAlign = 'right';
  let y = 147;

  // ── STAGE (game level) — top of HUD ──────────────────────────────────────
  ctx.font = 'bold 30px monospace';
  ctx.fillStyle = '#ffd';
  ctx.fillText(`STAGE ${gs.level}`, hudX, y); y += 14;

  // ── Account rank + XP bar ─────────────────────────────────────────────────
  const prof = getProfile();
  const xpp  = prof ? xpProgress(prof.xp) : null;

  ctx.font = '10px monospace'; ctx.fillStyle = '#668';
  ctx.fillText(`RANK ${xpp ? xpp.level : '--'}`, hudX, y); y += 4;

  const barW = 170, barH = 7;
  const barX = hudX - barW;
  const xpFrac = xpp ? Math.min(1, xpp.current / Math.max(1, xpp.needed)) : 0;
  ctx.fillStyle = '#222';
  ctx.fillRect(barX, y, barW, barH);
  ctx.fillStyle = '#4af';
  ctx.fillRect(barX, y, Math.round(barW * xpFrac), barH);
  ctx.strokeStyle = '#335'; ctx.lineWidth = 1;
  ctx.strokeRect(barX, y, barW, barH);
  y += barH + 3;

  ctx.font = '9px monospace'; ctx.fillStyle = '#4af';
  if (xpp && xpp.level < 20) {
    ctx.fillText(`${xpp.current}/${xpp.needed} XP`, hudX, y);
  } else if (xpp) {
    ctx.fillText('MAX RANK', hudX, y);
  }
  y += 13;

  // Divider
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hudX - 175, y); ctx.lineTo(hudX - 8, y); ctx.stroke();
  y += 14;

  // ── TODAY'S SALES ─────────────────────────────────────────────────────────
  ctx.font = '11px monospace';
  ctx.fillStyle = '#668';
  ctx.fillText("TODAY'S SALES", hudX, y); y += 24;

  ctx.font = 'bold 26px monospace';
  ctx.fillStyle = '#4f8';
  ctx.fillText(dollar(gs.levelSales), hudX, y); y += 10;

  ctx.font = '11px monospace';
  ctx.fillStyle = '#668';
  ctx.fillText('SEASON TOTAL', hudX, y); y += 20;

  ctx.font = 'bold 20px monospace';
  ctx.fillStyle = '#ffc';
  ctx.fillText(dollar(totSales), hudX, y); y += 14;

  // Divider
  ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hudX - 175, y); ctx.lineTo(hudX - 8, y); ctx.stroke();
  y += 16;

  const cents = gs.score;
  const moneyStr = cents < 0
    ? `-$${(Math.abs(cents) / 100).toFixed(2)}`
    : `$${(cents / 100).toFixed(2)}`;
  ctx.fillStyle = cents < 0 ? '#f88' : '#4f4';
  ctx.fillText(moneyStr, hudX, y); y += 38;

  ctx.fillStyle = gs.levelTimer <= 0 ? '#f84' : '#ffd';
  ctx.fillText(`${mm}:${ss}`, hudX, y); y += 36;

  // Stars / fails
  const displayMax    = Math.min(gs.maxFails, 6);
  const displayFilled = Math.min(gs.failed, displayMax);
  const starStr   = '★'.repeat(displayFilled) + '☆'.repeat(displayMax - displayFilled);
  const extraBadge = gs.maxFails > 6 ? '+' : '';
  ctx.font = 'bold 20px monospace';
  ctx.fillStyle = gs.failed >= gs.maxFails - 1 ? '#f44' : gs.failed > 0 ? '#f84' : '#888';
  ctx.fillText(starStr + extraBadge, hudX, y); y += 22;

  ctx.font = 'bold 16px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText(`${gs.failed} / ${gs.maxFails}`, hudX, y); y += 20;

  ctx.font = '12px monospace';
  ctx.fillStyle = '#8f8';
  ctx.fillText(`✓ ${gs.completed} served`, hudX, y); y += 16;

  // ── Financial breakdown ───────────────────────────────────────────────────
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(hudX - 175, y); ctx.lineTo(hudX - 8, y); ctx.stroke();
  y += 12;

  const rows: [string, string, string][] = [
    ['SALES',   dollar(totSales),                          '#ffd'],
    ['LABOR',   pct(totLabor),                             '#f84'],
    ['COGS',    pct(totCOGS),                              '#fb8'],
    ['WASTE',   pct(totWaste),                             '#f66'],
    ['O.HEAD',  pct(totOverhead),                          '#aaa'],
    ['PROFIT',  pct(totProfit),                            totProfit >= 0 ? '#4f4' : '#f44'],
    ['SAT',     satPct !== null ? `${satPct}%` : '--',     satPct === null ? '#888' : satPct >= 80 ? '#4f4' : satPct >= 50 ? '#fc4' : '#f44'],
  ];

  ctx.font = '11px monospace';
  for (const [label, val, color] of rows) {
    ctx.fillStyle = '#666'; ctx.textAlign = 'left';
    ctx.fillText(label, hudX - 175, y);
    ctx.fillStyle = color; ctx.textAlign = 'right';
    ctx.fillText(val, hudX - 8, y);
    y += 17;
  }

  // Overtime warning
  if (gs.levelTimer <= 0 && gs.phase === 'playing') {
    const blink = Math.floor(Date.now() / 400) % 2 === 0;
    if (blink) {
      ctx.fillStyle = '#f84';
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('OVERTIME — trash all spoiled & burned food!', W / 2, H - 10);
    }
  } else {
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#666';
    ctx.fillText('WASD: move   E/Space: interact', 10, H - 10);
  }
}

// ─── Level end / game over overlay ────────────────────────────────────────────

function drawPrepOverlay(gs: GameState): void {
  const secs = Math.ceil(gs.prepTimer / 1000);
  // Dim banner at bottom of order strip area
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, W, 120);

  ctx.textAlign = 'center';
  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = secs <= 3 ? '#f84' : '#ff4';
  ctx.fillText(`PREP TIME  —  ${secs}s`, W / 2, 48);

  ctx.font = '13px monospace';
  ctx.fillStyle = '#888';
  ctx.fillText('Load your stations. Orders open when timer hits 0.', W / 2, 74);

  // Big countdown when 3 or under
  if (secs <= 3) {
    ctx.fillStyle = `rgba(0,0,0,${0.3 + 0.1 * (3 - secs)})`;
    ctx.fillRect(0, 120, W, H - 120);
    ctx.font = `bold ${100 + (3 - secs) * 20}px monospace`;
    ctx.fillStyle = '#f84';
    ctx.textAlign = 'center';
    ctx.fillText(String(secs), W / 2, H / 2 + 40);
  }
}

function drawOverlay(gs: GameState, win: boolean): void {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  if (win) {
    drawDailyReport(gs);
    return;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 48px monospace';
  ctx.fillText('GAME OVER', W / 2, H / 2 - 30);

  const overlayMoney = gs.score < 0
    ? `-$${(Math.abs(gs.score) / 100).toFixed(2)}`
    : `$${(gs.score / 100).toFixed(2)}`;
  ctx.fillStyle = gs.score < 0 ? '#f88' : '#ffd';
  ctx.font = 'bold 22px monospace';
  ctx.fillText(overlayMoney, W / 2, H / 2 + 14);
}

function drawDailyReport(gs: GameState): void {
  const panelW = 500, panelH = 470;
  const px = (W - panelW) / 2;
  const py = (H - panelH) / 2;

  ctx.fillStyle = 'rgba(12, 18, 8, 0.98)';
  ctx.beginPath(); ctx.roundRect(px, py, panelW, panelH, 10); ctx.fill();
  ctx.strokeStyle = '#7a6030'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(px, py, panelW, panelH, 10); ctx.stroke();

  const cx = px + panelW / 2;
  let y = py + 30;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe080';
  ctx.font = 'bold 22px monospace';
  ctx.fillText('DAILY REPORT', cx, y); y += 22;

  const lvlName = LEVELS[gs.level - 1]?.name ?? '';
  ctx.fillStyle = '#aaa';
  ctx.font = '12px monospace';
  ctx.fillText(`Level ${gs.level}: ${lvlName}`, cx, y); y += 18;

  ctx.strokeStyle = '#554430'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 14;

  ctx.fillStyle = '#cc9'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left';
  ctx.fillText('SALES BREAKDOWN', px + 24, y); y += 16;

  const items = Object.entries(gs.salesByItem).sort((a, b) => b[1].revenue - a[1].revenue);
  if (items.length === 0) {
    ctx.fillStyle = '#666'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText('No orders completed', cx, y); y += 16;
  } else {
    const maxShow = Math.min(items.length, 7);
    for (let i = 0; i < maxShow; i++) {
      const [name, data] = items[i];
      ctx.fillStyle = '#ccc'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${name.slice(0, 22)}  ×${data.count}`, px + 30, y);
      ctx.textAlign = 'right';
      ctx.fillText(`$${(data.revenue / 100).toFixed(2)}`, px + panelW - 24, y); y += 14;
    }
    if (items.length > 7) {
      ctx.fillStyle = '#666'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`+${items.length - 7} more items`, cx, y); y += 14;
    }
  }

  y += 4;
  ctx.strokeStyle = '#443322'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 14;

  function plLine(label: string, cents: number, color: string, bold = false): void {
    ctx.fillStyle = color;
    ctx.font = `${bold ? 'bold ' : ''}11px monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(label, px + 30, y);
    ctx.textAlign = 'right';
    const sign = cents >= 0 ? '+' : '-';
    ctx.fillText(`${sign}$${(Math.abs(cents) / 100).toFixed(2)}`, px + panelW - 24, y);
    y += 17;
  }

  plLine('Total Sales',     gs.levelSales,    '#ffd');
  plLine('Food Cost',      -gs.levelCOGS,     '#f99');
  if (gs.levelWaste > 0) {
    plLine('  incl. Waste', -gs.levelWaste,    '#c77');
  }
  plLine('Labor',          -gs.levelLabor,    '#f99');
  plLine('Overhead',       -OVERHEAD_COST,    '#f99');

  y += 4;
  ctx.strokeStyle = '#554430'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 14;

  const profit = gs.levelSales - gs.levelCOGS - gs.levelLabor - OVERHEAD_COST;
  plLine('NET PROFIT', profit, profit >= 0 ? '#4f4' : '#f44', true);

  y += 6;
  const balStr = gs.score < 0
    ? `-$${(Math.abs(gs.score) / 100).toFixed(2)}`
    : `$${(gs.score / 100).toFixed(2)}`;
  ctx.fillStyle = gs.score < 0 ? '#f88' : '#aad';
  ctx.font = '11px monospace'; ctx.textAlign = 'center';
  ctx.fillText(`Cash Balance: ${balStr}`, cx, y); y += 20;

  const countdown = Math.max(0, Math.ceil(gs.levelEndTimer / 1000));
  if (gs.level < LEVELS.length) {
    ctx.fillStyle = '#88aaff';
    ctx.fillText(`Press Space to continue  (auto in ${countdown}s)`, cx, y);
  } else {
    ctx.fillStyle = '#ff8';
    ctx.font = 'bold 13px monospace';
    ctx.fillText('You conquered all 10 levels!', cx, y);
  }
}

// ─── Pause overlay ────────────────────────────────────────────────────────────

const PAUSE_OPTS = ['RESUME', 'MAIN MENU', 'FOOD MENU', 'CONTROLS', 'LEADERBOARD'];

export function drawPauseMenu(selectedIdx: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 340, panelH = 330;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;

  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#f84'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  const cx = px + panelW / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f84';
  ctx.font = 'bold 26px monospace';
  ctx.fillText('PAUSED', cx, py + 44);

  ctx.strokeStyle = '#332'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, py + 58); ctx.lineTo(px + panelW - 20, py + 58); ctx.stroke();

  ctx.font = 'bold 17px monospace';
  const optY = py + 94;
  const optSpacing = 42;

  for (let i = 0; i < PAUSE_OPTS.length; i++) {
    const y = optY + i * optSpacing;
    const sel = i === selectedIdx;
    if (sel) {
      ctx.fillStyle = 'rgba(255,136,68,0.13)';
      ctx.fillRect(px + 12, y - 20, panelW - 24, 30);
    }
    ctx.fillStyle = sel ? '#f84' : '#665544';
    ctx.fillText((sel ? '► ' : '    ') + PAUSE_OPTS[i], cx, y);
  }

  ctx.fillStyle = '#443';
  ctx.font = '12px monospace';
  ctx.fillText('W/S  ↑↓  navigate   ·   E  select   ·   P  resume', cx, py + panelH - 16);
}

export function drawControlsOverlay(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.80)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 400, panelH = 310;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;

  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#4af'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#234'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  const cx = px + panelW / 2;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4af';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('CONTROLS', cx, py + 38);

  ctx.strokeStyle = '#223'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, py + 52); ctx.lineTo(px + panelW - 20, py + 52); ctx.stroke();

  const rows: [string, string][] = [
    ['PLAYER 1', ''],
    ['Move', 'W  A  S  D'],
    ['Interact', 'E'],
    ['', ''],
    ['PLAYER 2', ''],
    ['Move', 'Arrow Keys'],
    ['Interact', 'Space'],
    ['', ''],
    ['Pause / Resume', 'P'],
    ['Fullscreen', 'F'],
    ['Main Menu', 'R'],
  ];

  const lx = px + 28, rx = px + panelW - 28;
  let y = py + 76;
  for (const [label, value] of rows) {
    if (!label && !value) { y += 6; continue; }
    const isHdr = !value;
    ctx.font = isHdr ? 'bold 13px monospace' : '13px monospace';
    ctx.fillStyle = isHdr ? '#f84' : '#665544';
    ctx.textAlign = 'left';
    ctx.fillText(label, lx, y);
    if (value) {
      ctx.fillStyle = '#cca';
      ctx.textAlign = 'right';
      ctx.fillText(value, rx, y);
    }
    y += isHdr ? 22 : 19;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#443';
  ctx.font = '12px monospace';
  ctx.fillText('E or P to close', cx, py + panelH - 16);
}

// ─── Restaurant menu overlay ──────────────────────────────────────────────────

export function drawRestaurantMenu(): void {
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 720, panelH = 400;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;

  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#c8802a'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#3a2010'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  ctx.textAlign = 'center'; ctx.fillStyle = '#c8802a';
  ctx.font = 'bold 20px monospace';
  ctx.fillText("KING'S BBQ — MENU", px + panelW / 2, py + 34);
  ctx.strokeStyle = '#3a2010'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, py + 48); ctx.lineTo(px + panelW - 20, py + 48); ctx.stroke();

  const cols: Array<{ title: string; icon: string; items: [string, string][] }> = [
    { title: 'GRILL', icon: '🔥', items: [
      ['HMB',           '1× Patty (15s)'],
      ['CHZ BRGR',      'Patty + Cheese'],
      ['DBL HMB',       '2× Patty'],
      ['DBL CHZ BRGR',  '2× Cheese Patty'],
      ['HOT DOG',       '1× Hot Dog (7.5s)'],
    ]},
    { title: 'FRYER', icon: '🍟', items: [
      ['SM FF',   '1× Fries (7.5s)'],
      ['LG FF',   '2× Fries'],
      ['SM PUPS', '1× Pups (5s)'],
      ['LG PUPS', '2× Pups'],
    ]},
    { title: 'SMOKER', icon: '💨', items: [
      ['BBQ SAND',  '1× Pulled Pork'],
      ['BBQ PLATE', '2× Pork + FF + PUPS'],
      ['', ''],
      ['Raw Pork → Smoker', '→ Chop → 4× Pork'],
    ]},
  ];

  const colW = (panelW - 48) / 3;
  for (let c = 0; c < cols.length; c++) {
    const col = cols[c];
    const cx2 = px + 24 + c * (colW + 0) + colW / 2;
    const bx  = px + 20 + c * (colW + 4);
    const by  = py + 62;
    const bh  = panelH - 82;

    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fillRect(bx, by, colW, bh);
    ctx.strokeStyle = '#2a1e10'; ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, colW, bh);

    ctx.textAlign = 'center';
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#c8802a';
    ctx.fillText(`${col.icon} ${col.title}`, cx2, by + 22);
    ctx.strokeStyle = '#2a1e10'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx + 8, by + 30); ctx.lineTo(bx + colW - 8, by + 30); ctx.stroke();

    let iy = by + 50;
    for (const [abbr, desc] of col.items) {
      if (!abbr && !desc) { iy += 8; continue; }
      const isNote = abbr.includes('→');
      ctx.font = isNote ? '10px monospace' : '12px monospace';
      ctx.textAlign = 'left';
      ctx.fillStyle = isNote ? '#554' : '#d4a84a';
      ctx.fillText(abbr, bx + 10, iy);
      ctx.font = '11px monospace';
      ctx.fillStyle = isNote ? '#554' : '#887060';
      ctx.textAlign = 'right';
      ctx.fillText(desc, bx + colW - 10, iy);
      iy += isNote ? 14 : 18;
    }
  }

  ctx.textAlign = 'center'; ctx.fillStyle = '#443';
  ctx.font = '12px monospace';
  ctx.fillText('E or P to close', px + panelW / 2, py + panelH - 14);
}

// ─── Name entry (arcade initials) ─────────────────────────────────────────────

export function drawNameEntry(chars: string[], cursor: number, score: number, level: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 440, panelH = 330;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;

  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#f84'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  const cx = px + panelW / 2;
  let y = py + 38;

  const blink = Math.floor(Date.now() / 500) % 2 === 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = blink ? '#f84' : '#b52';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('ENTER YOUR INITIALS', cx, y); y += 52;

  // Three character slots
  const slotW = 76, slotH = 84, slotGap = 18;
  const totalW = 3 * slotW + 2 * slotGap;
  const slotX0 = cx - totalW / 2;

  for (let i = 0; i < 3; i++) {
    const sx = slotX0 + i * (slotW + slotGap);
    const isCur = i === cursor;

    ctx.fillStyle = isCur ? '#1c0e04' : '#0c0804';
    ctx.fillRect(sx, y, slotW, slotH);
    ctx.strokeStyle = isCur ? '#f84' : '#432';
    ctx.lineWidth = isCur ? 2 : 1;
    ctx.strokeRect(sx, y, slotW, slotH);

    if (isCur) {
      ctx.fillStyle = '#f84'; ctx.font = '13px monospace'; ctx.textAlign = 'center';
      ctx.fillText('▲', sx + slotW / 2, y - 5);
      ctx.fillText('▼', sx + slotW / 2, y + slotH + 14);
    }

    const charVis = !isCur || Math.floor(Date.now() / 400) % 2 === 0;
    if (charVis) {
      ctx.fillStyle = isCur ? '#ffd' : '#887';
      ctx.font = 'bold 54px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(chars[i] === ' ' ? '_' : chars[i], sx + slotW / 2, y + slotH - 10);
    }
  }

  y += slotH + 42;

  const moneyStr = score < 0 ? `-$${(Math.abs(score) / 100).toFixed(2)}` : `$${(score / 100).toFixed(2)}`;
  ctx.fillStyle = '#887'; ctx.font = '13px monospace'; ctx.textAlign = 'center';
  ctx.fillText(`SCORE: ${moneyStr}   |   LEVEL: ${level}`, cx, y); y += 24;

  ctx.fillStyle = '#554'; ctx.font = '11px monospace';
  ctx.fillText('W/S  ↑↓ : change letter      A/D  ←→ : move cursor', cx, y); y += 18;
  ctx.fillStyle = blink ? '#4af' : '#268';
  ctx.fillText('E or SPACE to confirm', cx, y);
}

// ─── Leaderboard screen ────────────────────────────────────────────────────────

export function drawLeaderboard(
  entries: import('./leaderboard').LeaderboardEntry[],
  highlightScore: number,
  mode: import('./leaderboard').LeaderboardMode = 'rookie',
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 520, panelH = 490;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;

  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#f84'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  const cx = px + panelW / 2;
  const blink = Math.floor(Date.now() / 500) % 2 === 0;

  let y = py + 36;
  ctx.textAlign = 'center';
  ctx.fillStyle = blink ? '#f84' : '#b52';
  ctx.font = 'bold 22px monospace';
  const lbTitle = mode === 'pro_coop' ? '★  PRO CO-OP HIGH SCORES  ★'
                : mode === 'pro_solo' ? '★  PRO HIGH SCORES  ★'
                : '★  ROOKIE HIGH SCORES  ★';
  ctx.fillText(lbTitle, cx, y); y += 24;

  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 14;

  // Headers
  ctx.fillStyle = '#654'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'left';
  ctx.fillText('RNK', px + 28, y);
  ctx.fillText('NAME', px + 90, y);
  ctx.fillText('SALES', px + 185, y);
  ctx.fillText('PROFIT%', px + 365, y);
  y += 12;
  ctx.strokeStyle = '#321'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 12;

  const rankColors = ['#ffd700', '#c0c0c0', '#cd7f32'];

  // Track if the player's score made it into the list
  let highlightFound = false;

  for (let i = 0; i < 10; i++) {
    const e = entries[i];
    const eSales = e ? (e.sales ?? e.score) : 0;
    const isHL = e && eSales === highlightScore && !highlightFound;
    if (isHL) highlightFound = true;

    if (isHL) {
      ctx.fillStyle = 'rgba(255,136,0,0.13)';
      ctx.fillRect(px + 12, y - 13, panelW - 24, 22);
    }

    ctx.font = `${isHL ? 'bold ' : ''}13px monospace`;
    ctx.fillStyle = e ? (isHL ? '#ffd' : (rankColors[i] ?? '#998')) : '#333';
    ctx.textAlign = 'left';
    ctx.fillText(`${String(i + 1).padStart(2)}.`, px + 28, y);

    if (e) {
      ctx.fillText(e.name, px + 90, y);
      const sv = e.sales ?? e.score;
      const ms = sv < 0 ? `-$${(Math.abs(sv) / 100).toFixed(2)}` : `$${(sv / 100).toFixed(2)}`;
      ctx.fillText(ms, px + 185, y);
      const pct = e.profitPct !== undefined ? `${e.profitPct}%` : '—';
      ctx.fillText(pct, px + 365, y);
      if (isHL) {
        ctx.fillStyle = '#f84'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'right';
        ctx.fillText('◄ YOU', px + panelW - 18, y);
      }
    } else {
      ctx.fillText('---', px + 90, y);
      ctx.fillText('---', px + 185, y);
    }
    y += 28;
  }

  // If score didn't make top 10, note it
  if (!highlightFound && highlightScore !== undefined) {
    ctx.strokeStyle = '#321'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 14;
    const ms = highlightScore < 0 ? `-$${(Math.abs(highlightScore) / 100).toFixed(2)}` : `$${(highlightScore / 100).toFixed(2)}`;
    ctx.fillStyle = '#665'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`your sales: ${ms} — not in top 10`, cx, y);
  }

  // Footer
  ctx.fillStyle = blink ? '#4af' : '#268';
  ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
  ctx.fillText('E or SPACE to continue', cx, py + panelH - 20);
}

// ─── Game-over total report ───────────────────────────────────────────────────

export function drawGameReport(
  runSales: number, runCOGS: number, runLabor: number,
  runWaste: number, runOverhead: number,
  runCompleted: number, runFailed: number,
  level: number,
  xp?: { cooking: number; orders: number; delivery: number; actions: number; stage: number },
  xpTotal?: number,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.93)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 500, panelH = 540;
  const px = (W - panelW) / 2, py = (H - panelH) / 2;
  ctx.fillStyle = '#060402';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#f84'; ctx.lineWidth = 2;
  ctx.strokeRect(px, py, panelW, panelH);
  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.strokeRect(px + 4, py + 4, panelW - 8, panelH - 8);

  const cx = px + panelW / 2;
  let y = py + 38;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f84';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('★  SEASON TOTAL REPORT  ★', cx, y); y += 26;

  ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 22;

  const totalExpenses = runCOGS + runLabor + runWaste + runOverhead;
  const totalProfit = runSales - totalExpenses;
  const pct = (v: number) => runSales > 0 ? Math.round((v / runSales) * 100) : 0;
  const totalOrders = runCompleted + runFailed;
  const satPct = totalOrders > 0 ? Math.round((runCompleted / totalOrders) * 100) : 100;

  // rows: [label, dollar value (negative = expense), color, pct-of-sales or null]
  const rows: Array<[string, number, string, number | null]> = [
    ['TOTAL SALES',  runSales,     '#fff',                   null],
    ['FOOD COSTS',   -runCOGS,     '#f88',                   pct(runCOGS)],
    ['LABOR',        -runLabor,    '#fa8',                   pct(runLabor)],
    ['WASTE',        -runWaste,    '#f86',                   pct(runWaste)],
    ['OVERHEAD',     -runOverhead, '#f64',                   pct(runOverhead)],
    ['NET PROFIT',   totalProfit,  totalProfit >= 0 ? '#4f8' : '#f44', pct(totalProfit)],
  ];

  const dolX = px + panelW - 110;
  const pctX = px + panelW - 22;

  for (const [label, value, color, p] of rows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#998'; ctx.font = '13px monospace';
    ctx.fillText(label, px + 44, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = color;
    const sign = value < 0 ? '-$' : '$';
    ctx.fillText(`${sign}${(Math.abs(value) / 100).toFixed(2)}`, dolX, y);
    if (p !== null) {
      ctx.fillStyle = '#665'; ctx.font = '10px monospace';
      ctx.fillText(`${p}%`, pctX, y);
    }
    y += 25;
  }

  ctx.strokeStyle = '#321'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 16;

  const satColor = satPct >= 90 ? '#4f8' : satPct >= 70 ? '#ff8' : '#f44';
  const metaRows: Array<[string, string, string]> = [
    ['CUSTOMER SAT.', `${satPct}%  (${runCompleted}/${totalOrders} orders)`, satColor],
    ['STAGES REACHED', String(level), '#fff'],
  ];
  for (const [label, val, color] of metaRows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#998'; ctx.font = '13px monospace';
    ctx.fillText(label, px + 44, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = color;
    ctx.fillText(val, pctX, y); y += 22;
  }

  // XP breakdown
  if (xp && xpTotal !== undefined && xpTotal > 0) {
    y += 6;
    ctx.strokeStyle = '#432'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + 20, y); ctx.lineTo(px + panelW - 20, y); ctx.stroke(); y += 16;
    ctx.textAlign = 'left'; ctx.fillStyle = '#6af'; ctx.font = 'bold 12px monospace';
    ctx.fillText('XP EARNED', px + 44, y); y += 18;
    const xpRows: Array<[string, number]> = [
      ['  COOKING',  xp.cooking],
      ['  STAGING',  xp.orders],
      ['  DELIVERY', xp.delivery],
      ['  ACTIONS',  xp.actions],
      ['  STAGES',   xp.stage ?? 0],
    ];
    for (const [label, val] of xpRows) {
      if (val === 0) continue;
      ctx.textAlign = 'left'; ctx.fillStyle = '#88b'; ctx.font = '11px monospace';
      ctx.fillText(label, px + 44, y);
      ctx.textAlign = 'right'; ctx.fillStyle = '#6af';
      ctx.fillText(`+${val}`, pctX, y); y += 17;
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#adf'; ctx.font = 'bold 12px monospace';
    ctx.fillText('  TOTAL', px + 44, y);
    ctx.textAlign = 'right';
    ctx.fillText(`+${xpTotal}`, pctX, y); y += 14;
  }

  const blink = Math.floor(Date.now() / 500) % 2 === 0;
  ctx.fillStyle = blink ? '#4af' : '#268';
  ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
  ctx.fillText('E or SPACE to enter leaderboard', cx, py + panelH - 20);
}

// ─── Tutorial overlay ─────────────────────────────────────────────────────────

export interface TutorialStepDef { title: string; sub: string }

// Bottom-left reminder shown while step is active (after modal dismissed).
export function drawTutorialHint(step: number, steps: readonly TutorialStepDef[]): void {
  if (step >= steps.length) return;
  const { title, sub } = steps[step];
  const BOX_W = 400;
  const BOX_H = 50;
  const x = 8;
  const y = H - BOX_H - 8;

  ctx.fillStyle = 'rgba(8,4,0,0.90)';
  ctx.fillRect(x, y, BOX_W, BOX_H);
  ctx.strokeStyle = '#b05018';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, BOX_W, BOX_H);

  ctx.fillStyle = '#f84';
  ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left';
  ctx.fillText(title, x + 8, y + 18);

  ctx.fillStyle = '#bbb';
  ctx.font = '11px monospace';
  ctx.fillText(sub, x + 8, y + 36);
}

// Centered modal — pauses the game while shown.
export function drawTutorialModal(step: number, steps: readonly TutorialStepDef[]): void {
  if (step >= steps.length) return;
  const { title, sub } = steps[step];
  const total = steps.length;

  // Dim overlay
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, W, H);

  // Centered box
  const BOX_W = 540;
  const BOX_H = 120;
  const bx = (W - BOX_W) / 2;
  const by = (H - BOX_H) / 2;

  ctx.fillStyle = 'rgba(14,7,0,0.97)';
  ctx.fillRect(bx, by, BOX_W, BOX_H);
  ctx.strokeStyle = '#f84';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, BOX_W, BOX_H);

  // Step counter
  ctx.fillStyle = '#664';
  ctx.font = '10px monospace'; ctx.textAlign = 'right';
  ctx.fillText(`${step + 1} / ${total}`, bx + BOX_W - 10, by + 16);

  // Title
  ctx.fillStyle = '#f84';
  ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, by + 46);

  // Sub-text
  ctx.fillStyle = '#eee';
  ctx.font = '13px monospace'; ctx.textAlign = 'center';
  ctx.fillText(sub, W / 2, by + 74);

  // Prompt
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace'; ctx.textAlign = 'center';
  ctx.fillText('Tap or press SPACE to continue', W / 2, by + BOX_H - 10);
}
