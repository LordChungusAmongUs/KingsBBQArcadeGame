import { initInput, flushFrame, input, virtualKeyDown, virtualKeyUp } from './input';
import { createGame, tickGame } from './game';
import { initRenderer, render, resizeRenderer, drawNameEntry, drawLeaderboard, drawPauseMenu, drawControlsOverlay } from './renderer';
import type { GameState, CookSlot } from './types';
import { LEVELS, STARTING_MONEY } from './config';
import { loadLeaderboard, saveEntry, type LeaderboardEntry } from './leaderboard';

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const menu   = document.getElementById('menu')!;

// Fixed native resolution — CSS scales canvas to fit any screen
const GAME_W = 1183, GAME_H = 680;
canvas.width  = GAME_W;
canvas.height = GAME_H;
resizeRenderer(canvas);

initInput();
initRenderer(canvas);

// ─── Touch controls ───────────────────────────────────────────────────────────

const touchControls = document.getElementById('touchControls')!;

function initTouchControls(): void {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch) return;
  touchControls.classList.add('touch-visible');

  function bindKey(id: string, code: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); virtualKeyDown(code); }, { passive: false });
    el.addEventListener('touchend',   e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
    el.addEventListener('touchcancel',e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
  }

  bindKey('dUp',    'KeyW');
  bindKey('dDown',  'KeyS');
  bindKey('dLeft',  'KeyA');
  bindKey('dRight', 'KeyD');
  bindKey('dInteract', 'KeyE');

  document.getElementById('dPause')?.addEventListener('touchstart', e => {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
  }, { passive: false });
}

initTouchControls();

// ─── App state ────────────────────────────────────────────────────────────────

let gs: GameState | null = null;
let currentLevel = 1;
let lastTime = 0;
let isCoop = false;

type Screen = 'game' | 'name_entry' | 'leaderboard';
let screen: Screen = 'game';
let isPaused = false;
let pauseMenuIdx = 0;
let pauseSubScreen: 'controls' | null = null;
let leaderboardReturn: 'menu' | 'pause' = 'menu';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
let nameChars = ['A', 'A', 'A'];
let nameCursor = 0;
let leaderboardEntries: LeaderboardEntry[] = [];
let lastGameScore = 0;
let lastGameLevel = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const menuBtns = ['startBtn', 'coopBtn', 'fsBtn'].map(id => document.getElementById(id) as HTMLButtonElement);
let menuFocusIdx = 0;

function focusMenuBtn(idx: number): void {
  menuFocusIdx = (idx + menuBtns.length) % menuBtns.length;
  menuBtns[menuFocusIdx].focus();
}

function showMenu(): void {
  gs = null;
  menu.style.display = 'flex';
  touchControls.classList.remove('game-active');
  updateMenuLeaderboard();
  setTimeout(() => focusMenuBtn(0), 0);
}

function goToNameEntry(g: GameState): void {
  lastGameScore = g.score;
  lastGameLevel = g.level;
  nameChars = ['A', 'A', 'A'];
  nameCursor = 0;
  screen = 'name_entry';
}

function handleNameEntry(): void {
  if (input.menuPickUp   || input.p2MenuPickUp) {
    const idx = CHARS.indexOf(nameChars[nameCursor]);
    nameChars[nameCursor] = CHARS[(idx + 1) % CHARS.length];
  }
  if (input.menuPickDown || input.p2MenuPickDown) {
    const idx = CHARS.indexOf(nameChars[nameCursor]);
    nameChars[nameCursor] = CHARS[(idx - 1 + CHARS.length) % CHARS.length];
  }
  if ((input.menuPickRight || input.p2MenuPickRight) && nameCursor < 2) nameCursor++;
  if ((input.menuPickLeft  || input.p2MenuPickLeft)  && nameCursor > 0) nameCursor--;
  if (input.interactPressed || input.p2InteractPressed) {
    const name = nameChars.join('').trim() || 'AAA';
    leaderboardEntries = saveEntry(name, lastGameScore, lastGameLevel);
    screen = 'leaderboard';
  }
}

function updateMenuLeaderboard(): void {
  const entries = loadLeaderboard();
  const list = document.getElementById('hiscores-list');
  if (!list) return;
  if (entries.length === 0) {
    list.innerHTML = '<div class="hs-empty">no scores yet — get cooking!</div>';
    return;
  }
  list.innerHTML = entries.map((e, i) =>
    `<div class="hs-row">
      <span class="hs-rank">${String(i + 1).padStart(2, '0')}.</span>
      <span class="hs-name">${e.name}</span>
      <span class="hs-score">${e.score < 0 ? '-' : ''}$${(Math.abs(e.score) / 100).toFixed(2)}</span>
      <span class="hs-level">LVL ${e.level}</span>
    </div>`
  ).join('');
}

// ─── Level management ─────────────────────────────────────────────────────────

function startLevel(n: number, carryScore = 0, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0): void {
  currentLevel = n;
  screen = 'game';
  isPaused = false;
  gs = createGame(n, carryScore, isCoop, smokerSlots, carryFailed, thresholdsUnlocked);
  menu.style.display = 'none';
  touchControls.classList.add('game-active');
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ─── Game loop ────────────────────────────────────────────────────────────────

function loop(now: number): void {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;

  // R always exits to main menu from anywhere
  if (input.restartPressed) {
    flushFrame();
    screen = 'game';
    showMenu();
    return;
  }

  // Name entry screen
  if (screen === 'name_entry') {
    handleNameEntry();
    if (gs) render(gs);
    drawNameEntry(nameChars, nameCursor, lastGameScore, lastGameLevel);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  // Leaderboard screen
  if (screen === 'leaderboard') {
    if (input.interactPressed || input.p2InteractPressed) {
      screen = 'game';
      flushFrame();
      if (leaderboardReturn === 'pause') {
        requestAnimationFrame(loop);
      } else {
        showMenu();
      }
      return;
    }
    if (gs) render(gs);
    drawLeaderboard(leaderboardEntries, lastGameScore);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  // Game
  if (!gs) return;

  // Pause menu (only during active play)
  if (isPaused && gs.phase === 'playing') {
    lastTime = now;

    if (pauseSubScreen === 'controls') {
      if (input.interactPressed || input.p2InteractPressed) pauseSubScreen = null;
    } else {
      if (input.menuPickUp   || input.p2MenuPickUp)   pauseMenuIdx = (pauseMenuIdx - 1 + 5) % 5;
      if (input.menuPickDown || input.p2MenuPickDown) pauseMenuIdx = (pauseMenuIdx + 1) % 5;
      if (input.interactPressed || input.p2InteractPressed) {
        switch (pauseMenuIdx) {
          case 0: isPaused = false; pauseSubScreen = null; break;                          // RESUME
          case 1: isPaused = false; flushFrame(); showMenu(); return;                       // QUIT
          case 2: isPaused = false; flushFrame(); showMenu(); return;                       // MENU
          case 3: pauseSubScreen = 'controls'; break;                                      // CONTROLS
          case 4:                                                                           // LEADERBOARD
            leaderboardEntries = loadLeaderboard();
            leaderboardReturn = 'pause';
            screen = 'leaderboard';
            break;
        }
      }
    }

    render(gs);
    if (pauseSubScreen === 'controls') drawControlsOverlay();
    else drawPauseMenu(pauseMenuIdx);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  tickGame(gs, dt);

  // Level transition — tap/Space/E skips or auto after timer
  if (gs.phase === 'level_end' && (gs.levelEndTimer <= 0 || input.p2InteractPressed || input.interactPressed)) {
    if (gs.level < LEVELS.length) {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      const smokerSlots = smoker?.slots.map(sl => ({ ...sl }));
      startLevel(gs.level + 1, gs.score, smokerSlots, Math.max(0, gs.failed - 1), gs.thresholdsUnlocked);
      return;
    }
    // All levels done — name entry
    goToNameEntry(gs);
    requestAnimationFrame(loop);
    return;
  }

  if (gs.phase === 'game_over') {
    if (gs.levelEndTimer <= 0) {
      goToNameEntry(gs);
      requestAnimationFrame(loop);
      return;
    }
    render(gs);
    flushFrame();
    requestAnimationFrame(loop);
    return;
  }

  render(gs);
  flushFrame();
  requestAnimationFrame(loop);
}

// ─── Menu buttons ─────────────────────────────────────────────────────────────

document.getElementById('startBtn')!.addEventListener('click', () => { isCoop = false; startLevel(1, STARTING_MONEY); });
document.getElementById('coopBtn')!.addEventListener('click', () => { isCoop = true;  startLevel(1, STARTING_MONEY); });

function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}
document.getElementById('fsBtn')!.addEventListener('click', toggleFullscreen);
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyP' && screen === 'game' && gs?.phase === 'playing') {
    isPaused = !isPaused;
    if (isPaused) { pauseMenuIdx = 0; pauseSubScreen = null; }
    else pauseSubScreen = null;
  }

  // Menu keyboard navigation (only when menu is visible)
  if (menu.style.display === 'none') return;
  if (e.code === 'ArrowLeft' || e.code === 'ArrowUp')    { e.preventDefault(); focusMenuBtn(menuFocusIdx - 1); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { e.preventDefault(); focusMenuBtn(menuFocusIdx + 1); }
  if (e.code === 'Space' || e.code === 'Enter')          { e.preventDefault(); menuBtns[menuFocusIdx].click(); }
});

// Populate leaderboard on initial load
updateMenuLeaderboard();
setTimeout(() => focusMenuBtn(0), 0);
