import { initAudio, playMusic, playPlaylist, stopMusic } from './audio';

// ── Soundtrack playlists ────────────────────────────────────────────────────
const GAME_TRACKS = [
  '/audio/game%20play.mp3',
  '/audio/gameplay%202.mp3',
  '/audio/gameplay%203.mp3',
  '/audio/gameplay%204.mp3',
  '/audio/gameplay%205.mp3',
  '/audio/gameplay%206.mp3',
  '/audio/gameplay%207.mp3',
  '/audio/gameplay%208.mp3',
];
const LOBBY_TRACKS = [
  '/audio/Lobby.mp3',
  '/audio/lobby%202.mp3',
  '/audio/lobby%203.mp3',
  '/audio/lobby%204.mp3',
  '/audio/lobby%205.mp3',
  '/audio/lobby%206.mp3',
  '/audio/lobby%207.mp3',
  '/audio/lobby%208.mp3',
];
const AFTER_GAME_TRACKS = [
  '/audio/after%20game%20menu.mp3',
  '/audio/after%20game%20menu%202.mp3',
  '/audio/after%20game%20menu%203.mp3',
  '/audio/after%20game%20menu%204.mp3',
];
const TUTORIAL_TRACKS = [
  '/audio/Tutorial.mp3',
  '/audio/Tutorial%202.mp3',
];
import { initInput, flushFrame, input, virtualKeyDown, virtualKeyUp, keys } from './input';
import { spawnFloat, resetXPBreakdown, xpBreakdown, xpBreakdownTotal } from './effects';
import { createGame, tickGame, resolveCollisions, remoteInput } from './game';
import { initRenderer, render, resizeRenderer, loadSprites, drawNameEntry, drawLeaderboard, drawPauseMenu, drawControlsOverlay, drawRestaurantMenu, drawTutorialHint, drawTutorialModal, drawGameReport, updateHUDRunStats } from './renderer';
import type { GameState, CookSlot } from './types';
import { LEVELS, STARTING_MONEY, PLAYER_SPEED, STAGED_SPOIL_TIME } from './config';
import { loadLeaderboard, saveEntry, type LeaderboardEntry, type LeaderboardMode } from './leaderboard';
import { initAuth, signInWithGoogle, signOutUser, checkRedirectResult } from './auth';
import type { User } from 'firebase/auth';
import {
  loadProfile, clearProfile, flushSession, getProfile,
  setOnLevelUp, setOnEarlyLevelUp, setOnAchievementUnlocked, setOnSkinUnlock,
  incrementStat, recordMaxStat,
  xpProgress, ACHIEVEMENTS, clearPendingXP,
  resetProfile, setGender, setActiveSkin, setFamiliarAbility, saveProfilePrefs,
  LEVEL_UNLOCKS, SKIN_POOL,
  type UserProfile, type FamiliarAbility, type SkinDef,
} from './profile';
import {
  saveCloudScore, loadCloudLeaderboard,
  createLobby, joinLobby, deleteLobby, setLobbyStatus, watchLobby,
  sendGlobalMessage, watchGlobalChat, type GlobalChatMsg,
  sendInvite, respondToInvite, deleteInvite, watchIncomingInvites, watchSentInvite,
  type InviteData, type LobbyData,
} from './cloud';
import {
  startHostSync, stopHostSync, startGuestSync, stopGuestSync, pushGuestInput,
  setPresence, clearPresence, watchPresence,
  seekMatch, notifyMatch, watchForMatch, leaveMatchmaking,
  joinSizedQueue, leaveSizedQueue, watchSizedQueue,
  type P2InputData, type PresenceUser,
} from './netplay';

// ─── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;
const menu   = document.getElementById('menu')!;
const GAME_W = 1183, GAME_H = 680;
canvas.width = GAME_W; canvas.height = GAME_H;
resizeRenderer(canvas);
initAudio();
initInput();
initRenderer(canvas);
loadSprites();

// ─── Touch controls ───────────────────────────────────────────────────────────

const touchControls = document.getElementById('touchControls')!;

function initTouchControls(): void {
  if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
  touchControls.classList.add('touch-visible');
  function bindKey(id: string, code: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', e => { e.preventDefault(); _lastInputTime = Date.now(); virtualKeyDown(code); }, { passive: false });
    el.addEventListener('touchend',   e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
    el.addEventListener('touchcancel',e => { e.preventDefault(); virtualKeyUp(code); },   { passive: false });
  }
  bindKey('dUp','KeyW'); bindKey('dDown','KeyS'); bindKey('dLeft','KeyA'); bindKey('dRight','KeyD');
  bindKey('dInteract','KeyE');
  document.getElementById('dPause')?.addEventListener('touchstart', e => {
    e.preventDefault();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyP', bubbles: true }));
  }, { passive: false });
}
initTouchControls();

// ─── Auth ─────────────────────────────────────────────────────────────────────

let user: User | null = null;

// Must be called before any auth state is read; resolves any pending redirect sign-in.
checkRedirectResult().catch(console.error);

initAuth(u => {
  user = u;
  if (u) {
    loadProfile(u.uid).then(() => {
      updateAuthUI();
      localStorage.removeItem('kbbq_pendingLobby');
      // Show gender picker for first-time users
      if (!getProfile()?.gender) showGenderPicker();
      if (lobbyScreen.style.display !== 'none' && !unsubPresence) {
        openLobbyScreen();
      }
    }).catch(console.error);
  } else {
    clearProfile();
    updateAuthUI();
  }
  updateMenuLeaderboard();
});

function updateAuthUI(): void {
  const authOut = document.getElementById('authOut')!;
  const authIn  = document.getElementById('authIn')!;
  if (user) {
    authOut.style.display = 'none'; authIn.style.display = 'flex';
    const photo = document.getElementById('userPhoto') as HTMLImageElement;
    photo.src = user.photoURL ?? ''; photo.style.display = user.photoURL ? 'block' : 'none';
    document.getElementById('userName')!.textContent = user.displayName ?? user.email ?? '';
    const prof = getProfile();
    const lvlEl = document.getElementById('userLevel')!;
    lvlEl.textContent = prof ? (prof.level >= 20 ? 'Lv MAX' : `Lv ${prof.level}`) : '';
  } else {
    authOut.style.display = 'flex'; authIn.style.display = 'none';
    document.getElementById('userLevel')!.textContent = '';
  }
}

document.getElementById('signInBtn')!.addEventListener('click', () => signInWithGoogle().catch(console.error));
document.getElementById('signOutBtn')!.addEventListener('click', () => signOutUser().catch(console.error));

// ─── Toast system ─────────────────────────────────────────────────────────────

const toastQueue: { title: string; sub: string }[] = [];
let toastActive = false;

function showToast(title: string, sub: string): void {
  toastQueue.push({ title, sub });
  if (!toastActive) _nextToast();
}

function _nextToast(): void {
  if (toastQueue.length === 0) { toastActive = false; return; }
  toastActive = true;
  const { title, sub } = toastQueue.shift()!;
  const el = document.getElementById('achievementToast')!;
  document.getElementById('toastTitle')!.textContent = title;
  document.getElementById('toastSub')!.textContent   = sub;
  el.classList.add('toast-show');
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(_nextToast, 400);
  }, 3200);
}

// Fires immediately during gameplay when XP crosses a threshold → in-game toast
setOnEarlyLevelUp((_, newLv) => {
  showToast('LEVEL UP!', `You are now Level ${newLv >= 20 ? 'MAX' : newLv}`);
  if (gs?.player) spawnFloat(gs.player.x, gs.player.y - 50, 'LVL UP!', '#4f8', 2000);
});

// Fires at session end (flushSession) → update UI with the now-official level
setOnLevelUp((oldLv, newLv) => {
  updateAuthUI();
  updateLobbyXPBar();
  // Show familiar ability picker if this is the first time reaching level 5
  if (oldLv < 5 && newLv >= 5 && !getProfile()?.familiarAbility) {
    setTimeout(() => showFamiliarPicker(), 1200);
  }
});

setOnAchievementUnlocked((id, tier, name) => {
  const TIER_LABELS = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  showToast('ACHIEVEMENT UNLOCKED', `${name} — Tier ${TIER_LABELS[tier] ?? tier + 1}`);
});

setOnSkinUnlock((skin: SkinDef) => {
  const toast = document.getElementById('skinUnlockToast')!;
  const nameEl = document.getElementById('skinUnlockName')!;
  const swatch = document.getElementById('skinUnlockSwatch')!;
  nameEl.textContent = skin.name;
  swatch.style.background = skin.apronColor;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
});

// ─── Game state ───────────────────────────────────────────────────────────────

let gs: GameState | null = null;
let currentLevel = 1;
let lastTime = 0;
let isCoop = false;
let _lastInputTime = Date.now();
const INACTIVITY_MS = 60_000; // 60 s of no input → game over, no XP

// ─── Tutorial state ───────────────────────────────────────────────────────────
let isTutorial = false;
let tutorialStep = 0;
let tutorialHintTimer = 0;
let tutorialBaseCompleted = 0;
let tutorialPlayerMoved = false;
let tutorialModalActive = false;

type Screen = 'game' | 'name_entry' | 'leaderboard' | 'game_report';
let screen: Screen = 'game';
let isPaused = false, pauseMenuIdx = 0;
let pauseSubScreen: 'controls' | 'restaurant_menu' | null = null;
let leaderboardReturn: 'menu' | 'pause' = 'menu';
let leaderboardMode: LeaderboardMode = 'rookie';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ';
let nameChars = ['A','A','A'], nameCursor = 0;
let leaderboardEntries: LeaderboardEntry[] = [];
let lastGameWasCoop = false;
let lastGameWasOnline = false;
let lastGameScore = 0, lastGameLevel = 1;
let runSales = 0, runCOGS = 0, runLabor = 0, runWaste = 0, runOverhead = 0, runCompleted = 0, runFailed = 0;
let runSatisfactionSum = 0, runSatisfactionCount = 0;
let lastRunSales = 0, lastRunProfitPct = 0, lastRunExpenses = 0, lastRunSatisfactionPct = 0;
let isProMode = false;
let lastGameWasPro = false;
let pgFocusIdx = 0;

// ─── Online co-op state ───────────────────────────────────────────────────────

let isOnlineGame = false, isOnlineHost = false;
let activeLobbyId: string | null = null;
let remoteGs: GameState | null = null;
let guestInteractSeq = 0;
let hostSeqs = [0, 0, 0]; // seq counters for slots 2, 3, 4
let lastSentInput: P2InputData | null = null;
let unsubHostLobby: (() => void) | null = null;
let guestSlot = 2;         // which player slot this guest occupies (2, 3, or 4)
let lobbyPlayerCount = 2;  // total players in the current online game (host knows; guest derives from snapshot)
// Guest-side own-player prediction (so guest sees their own movement instantly)
let p2PredX: number | null = null;
let p2PredY: number | null = null;
let p2PredFacing = 0, p2PredWalk = 0;
// Last authoritative own-player position received from host (used only when standing still)
let p2AuthX: number | null = null;
let p2AuthY: number | null = null;
// Frames own-player has been stopped; correction is delayed until auth catches up
let p2StoppedFrames = 0;
// Guest-side P1 interpolation (smooth P1 between snapshots)
type P1Sample = { x: number; y: number; facing: number; walkFrame: number; t: number };
let p1Prev: P1Sample | null = null;
let p1Curr: P1Sample | null = null;
// Previous network input per slot — for rising-edge menu-nav detection on host
let _prevP2: P2InputData = { up: false, down: false, left: false, right: false, interactSeq: 0 };
let _prevP3: P2InputData = { up: false, down: false, left: false, right: false, interactSeq: 0 };
let _prevP4: P2InputData = { up: false, down: false, left: false, right: false, interactSeq: 0 };

// ─── Lobby state ──────────────────────────────────────────────────────────────

let unsubGlobalChat: (() => void) | null = null;
let unsubPresence:   (() => void) | null = null;
let unsubInvites:    (() => void) | null = null;
let unsubSentInvite: (() => void) | null = null;
let pendingInviteId: string | null = null;      // invite I sent
let pendingInviteLobbyId: string | null = null; // lobby I created for invite
let pendingInviteToUid: string | null = null;   // uid of the player I invited
let isMatchmaking = false;
let stopMatchwatch: (() => void) | null = null;
let coopQueueSize = 2;
let showSizePicker = false;
let stopQueueWatch: (() => void) | null = null;
let receivedInvites: InviteData[] = [];         // invites I received
let onlineUsers: PresenceUser[] = [];

// ─── Menu helpers ─────────────────────────────────────────────────────────────

const menuBtns = ['tutorialBtn','startBtn','lobbyBtn'].map(id => document.getElementById(id) as HTMLButtonElement);
let menuFocusIdx = 0;

function focusMenuBtn(idx: number): void {
  menuFocusIdx = (idx + menuBtns.length) % menuBtns.length;
  menuBtns[menuFocusIdx].focus();
}

function enterFullscreenLandscape(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  (window.screen.orientation as any)?.lock?.('landscape').catch(() => {});
}

function showMenu(): void {
  if (gs) flushSession().catch(console.error); // save any pending XP earned before quitting
  gs = null;
  menu.style.display = 'flex';
  touchControls.classList.remove('game-active');
  updateMenuLeaderboard();
  setTimeout(() => focusMenuBtn(0), 0);
  enterFullscreenLandscape();
  playMusic('/audio/Main%20Theme.mp3');
}

function recordLevelStats(g: GameState): void {
  incrementStat('total_sales',     g.levelSales);
  incrementStat('total_food_cost', g.levelCOGS);
  incrementStat('total_labor',     g.levelLabor);
  incrementStat('total_waste',     g.levelWaste);
  const profit = Math.max(0, g.levelSales - g.levelCOGS - g.levelLabor - g.levelWaste);
  incrementStat('total_profit', profit);
  recordMaxStat('max_stage', g.level);
}

function updateLobbyXPBar(): void {
  const prof = getProfile();
  const barEl  = document.getElementById('selfXPBar');
  const lblEl  = document.getElementById('selfLevelLabel');
  const fillEl = document.getElementById('selfXPFill');
  const txtEl  = document.getElementById('selfXPText');
  if (!barEl || !lblEl || !fillEl) return;
  if (!prof) { barEl.style.display = 'none'; return; }
  barEl.style.display = 'block';
  const { current, needed, level } = xpProgress(prof.xp);
  lblEl.textContent = level >= 20 ? 'LEVEL MAX' : `LEVEL ${level}`;
  fillEl.style.width = level >= 20 ? '100%' : `${Math.round((current / needed) * 100)}%`;
  if (txtEl) {
    txtEl.textContent = level >= 20
      ? 'MAX LEVEL'
      : `${current.toLocaleString()} / ${needed.toLocaleString()} XP`;
  }
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

async function updateMenuLeaderboard(): Promise<void> {
  const list = document.getElementById('hiscores-list');
  if (!list) return;
  try {
    const entries = await loadCloudLeaderboard();
    if (entries.length > 0) {
      list.innerHTML = entries.map((e, i) =>
        `<div class="hs-row">
          <span class="hs-rank">${String(i+1).padStart(2,'0')}.</span>
          ${e.photoURL ? `<img class="hs-photo" src="${e.photoURL}" />` : ''}
          <span class="hs-name">${e.name}</span>
          <span class="hs-score">${e.score < 0 ? '-' : ''}$${(Math.abs(e.score)/100).toFixed(2)}</span>
          <span class="hs-level">LVL ${e.level}</span>
        </div>`
      ).join('');
      return;
    }
  } catch { /* fall through */ }
  const entries = loadLeaderboard('rookie');
  list.innerHTML = entries.length === 0
    ? '<div class="hs-empty">no scores yet — get cooking!</div>'
    : entries.map((e,i) =>
        `<div class="hs-row">
          <span class="hs-rank">${String(i+1).padStart(2,'0')}.</span>
          <span class="hs-name">${e.name}</span>
          <span class="hs-score">${e.score<0?'-':''}$${(Math.abs(e.score)/100).toFixed(2)}</span>
          <span class="hs-level">LVL ${e.level}</span>
        </div>`
      ).join('');
}

// ─── Name entry ───────────────────────────────────────────────────────────────

function preparePostGame(g: GameState): void {
  lastGameWasCoop = isCoop;
  lastGameWasOnline = isOnlineGame;
  lastGameWasPro = isProMode;
  if (isOnlineGame && isOnlineHost) cleanupOnlineGame();
  flushSession().catch(console.error);
  const totalExpenses = runCOGS + runLabor + runWaste + runOverhead;
  const totalProfit = runSales - totalExpenses;
  const totalOrders = runCompleted + runFailed;
  lastRunSales = runSales;
  lastRunProfitPct = runSales > 0 ? Math.round((totalProfit / runSales) * 100) : 0;
  lastRunExpenses = runCOGS + runLabor;
  lastRunSatisfactionPct = runSatisfactionCount > 0 ? Math.round(runSatisfactionSum / runSatisfactionCount) : 100;
  lastGameScore = runSales;
  lastGameLevel = g.level;
  leaderboardReturn = 'menu'; // always show postgame overlay after leaderboard
  nameChars = ['A','A','A']; nameCursor = 0;
  if (user?.displayName) {
    const initials = user.displayName.slice(0, 3).toUpperCase().replace(/[^A-Z ]/g, 'A');
    for (let i = 0; i < 3; i++) nameChars[i] = CHARS.includes(initials[i]) ? initials[i] : 'A';
  }
}

function goToNameEntry(g: GameState): void {
  preparePostGame(g);
  showMobileNameEntry();
  screen = 'name_entry';
}

function goToGameReport(g: GameState): void {
  preparePostGame(g);
  playPlaylist(AFTER_GAME_TRACKS);
  screen = 'game_report';
}

function handleNameEntry(): void {
  if (input.menuPickUp   || input.p2MenuPickUp)   { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i+1)%CHARS.length]; }
  if (input.menuPickDown || input.p2MenuPickDown) { const i = CHARS.indexOf(nameChars[nameCursor]); nameChars[nameCursor] = CHARS[(i-1+CHARS.length)%CHARS.length]; }
  if ((input.menuPickRight||input.p2MenuPickRight) && nameCursor < 2) nameCursor++;
  if ((input.menuPickLeft ||input.p2MenuPickLeft)  && nameCursor > 0) nameCursor--;
  if (input.interactPressed || input.p2InteractPressed) submitName();
}

function submitName(): void {
  const name = nameChars.join('').trim() || 'AAA';
  hideMobileNameEntry();
  leaderboardMode = lastGameWasPro ? (lastGameWasCoop ? 'pro_coop' : 'pro_solo') : 'rookie';
  leaderboardEntries = saveEntry(name, lastGameScore, lastGameLevel, lastRunProfitPct, lastRunExpenses, lastRunSatisfactionPct, leaderboardMode);
  if (user) saveCloudScore(user.uid, user.displayName??'', user.photoURL??'', name, lastGameScore, lastGameLevel).catch(()=>{});
  enterLeaderboard();
}

function enterLeaderboard(): void {
  screen = 'leaderboard';
  if (leaderboardReturn !== 'menu') return;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) document.getElementById('lbTapHint')!.style.display = 'flex';
  playMusic('/audio/Score%20Screen.mp3');
}

function dismissLeaderboard(): void {
  if (screen !== 'leaderboard') return;
  document.getElementById('lbTapHint')!.style.display = 'none';
  if (leaderboardReturn === 'pause') {
    screen = 'game'; flushFrame(); requestAnimationFrame(loop);
  } else {
    showPostgameOverlay();
  }
}

function showPostgameOverlay(): void {
  const sign = lastGameScore < 0 ? '-' : '';
  document.getElementById('pgScoreDisplay')!.textContent =
    `SCORE: ${sign}$${(Math.abs(lastGameScore)/100).toFixed(2)}  ·  STAGE ${lastGameLevel}`;
  const btn = document.getElementById('pgPlayAgain')!;
  if (lastGameWasCoop && lastGameWasOnline) {
    btn.textContent = 'PLAY CO-OP AGAIN';
  } else if (lastGameWasCoop) {
    btn.textContent = 'PLAY LOCAL CO-OP AGAIN';
  } else {
    btn.textContent = 'PLAY SOLO AGAIN';
  }
  document.getElementById('pgLobby')!.style.display = lastGameWasPro ? '' : 'none';
  pgFocusIdx = 0;
  document.getElementById('postgameOverlay')!.style.display = 'flex';
  screen = 'game';
  (document.getElementById('pgPlayAgain') as HTMLButtonElement).focus();
  flushFrame();
  lastTime = performance.now();
  requestAnimationFrame(loop); // keep the loop alive so arrow-key navigation works
}

function hidePostgameOverlay(): void {
  document.getElementById('postgameOverlay')!.style.display = 'none';
}

function showMobileNameEntry(): void {
  const el = document.getElementById('nameEntryMobile')!;
  if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;
  const inp = document.getElementById('neInput') as HTMLInputElement;
  inp.value = nameChars.join('').trim();
  const scoreEl = document.getElementById('neScore')!;
  const sign = lastGameScore < 0 ? '-' : '';
  scoreEl.textContent = `SCORE: ${sign}$${(Math.abs(lastGameScore)/100).toFixed(2)}`;
  el.style.display = 'flex';
  setTimeout(() => inp.focus(), 50);
}

function hideMobileNameEntry(): void {
  document.getElementById('nameEntryMobile')!.style.display = 'none';
}

// ─── Level management ─────────────────────────────────────────────────────────

function startLevel(n: number, carryScore = 0, smokerSlots?: CookSlot[], carryFailed = 0, thresholdsUnlocked = 0, carryMeter = 0): void {
  if (n === 1) {
    incrementStat(isCoop ? 'coop_sessions' : 'solo_sessions', 1);
    runSales = 0; runCOGS = 0; runLabor = 0; runWaste = 0; runOverhead = 0; runCompleted = 0; runFailed = 0;
    runSatisfactionSum = 0; runSatisfactionCount = 0;
    resetXPBreakdown();
    // Small delay so the Play-button click unlocks audio before we switch tracks
    setTimeout(() => playPlaylist(GAME_TRACKS), 80);
  }
  currentLevel = n; screen = 'game'; isPaused = false; _lastInputTime = Date.now();
  const pCount = isCoop ? lobbyPlayerCount : 1;
  gs = createGame(n, carryScore, pCount, smokerSlots, carryFailed, thresholdsUnlocked, carryMeter);
  menu.style.display = 'none';
  touchControls.classList.add('game-active');
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ─── Online co-op ─────────────────────────────────────────────────────────────

function handlePlayerFromNet(slot: number, inp: P2InputData): void {
  const ri = slot === 3 ? remoteInput.p3 : slot === 4 ? remoteInput.p4 : remoteInput.p2;
  ri.up    = inp.up;
  ri.down  = inp.down;
  ri.left  = inp.left;
  ri.right = inp.right;

  const prev  = slot === 3 ? _prevP3 : slot === 4 ? _prevP4 : _prevP2;
  const menuPickUp    = slot === 3 ? 'p3MenuPickUp'    : slot === 4 ? 'p4MenuPickUp'    : 'p2MenuPickUp'    as any;
  const menuPickDown  = slot === 3 ? 'p3MenuPickDown'  : slot === 4 ? 'p4MenuPickDown'  : 'p2MenuPickDown'  as any;
  const menuPickLeft  = slot === 3 ? 'p3MenuPickLeft'  : slot === 4 ? 'p4MenuPickLeft'  : 'p2MenuPickLeft'  as any;
  const menuPickRight = slot === 3 ? 'p3MenuPickRight' : slot === 4 ? 'p4MenuPickRight' : 'p2MenuPickRight' as any;
  if (inp.up    && !prev.up)    (input as any)[menuPickUp]    = true;
  if (inp.down  && !prev.down)  (input as any)[menuPickDown]  = true;
  if (inp.left  && !prev.left)  (input as any)[menuPickLeft]  = true;
  if (inp.right && !prev.right) (input as any)[menuPickRight] = true;

  const idx = slot - 2; // 0, 1, or 2
  if (inp.interactSeq !== hostSeqs[idx]) {
    hostSeqs[idx] = inp.interactSeq;
    const pRef = slot === 3 ? gs?.player3 : slot === 4 ? gs?.player4 : gs?.player2;
    if (pRef && inp.ix !== undefined) { pRef.x = inp.ix; pRef.y = inp.iy!; }
    const flag = slot === 3 ? 'p3InteractPressed' : slot === 4 ? 'p4InteractPressed' : 'p2InteractPressed';
    (input as any)[flag] = true;
  }

  if (slot === 3) _prevP3 = { ...inp };
  else if (slot === 4) _prevP4 = { ...inp };
  else _prevP2 = { ...inp };
}

function cleanupOnlineGame(): void {
  unsubHostLobby?.(); unsubHostLobby = null;
  if (isOnlineHost && activeLobbyId) {
    stopHostSync(activeLobbyId);
    deleteLobby(activeLobbyId).catch(()=>{});
  } else {
    stopGuestSync();
  }
  isOnlineGame = false; isOnlineHost = false; activeLobbyId = null;
  remoteInput.useRemote = false;
  remoteInput.p2 = { up: false, down: false, left: false, right: false };
  remoteInput.p3 = { up: false, down: false, left: false, right: false };
  remoteInput.p4 = { up: false, down: false, left: false, right: false };
  remoteGs = null; lastSentInput = null;
  p2PredX = null; p2PredY = null; p2AuthX = null; p2AuthY = null; p2StoppedFrames = 0;
  p1Prev = null; p1Curr = null;
  _prevP2 = { up: false, down: false, left: false, right: false, interactSeq: 0 };
  _prevP3 = { up: false, down: false, left: false, right: false, interactSeq: 0 };
  _prevP4 = { up: false, down: false, left: false, right: false, interactSeq: 0 };
  hostSeqs = [0, 0, 0]; guestSlot = 2;
  touchControls.classList.remove('game-active');
}

function startOnlineGame(lobbyId: string, asHost: boolean, slot = 2, playerCount = 2): void {
  closeLobbyScreen();
  isOnlineGame = true; isOnlineHost = asHost; activeLobbyId = lobbyId; isProMode = true;
  guestSlot = slot; lobbyPlayerCount = playerCount;
  if (asHost) {
    isCoop = true; hostSeqs = [0, 0, 0];
    remoteInput.useRemote = true;
    startHostSync(lobbyId, () => gs, handlePlayerFromNet);
    startLevel(1, STARTING_MONEY + 2500 * (playerCount - 1));
    if (gs) render(gs); flushFrame();
  } else {
    incrementStat('coop_sessions', 1);
    guestInteractSeq = 0; lastSentInput = null;
    p2PredX = null; p2PredY = null; p2AuthX = null; p2AuthY = null; p2StoppedFrames = 0;
    menu.style.display = 'none';
    touchControls.classList.add('game-active');
    remoteGs = null;
    startGuestSync(lobbyId, slot, gs => {
      remoteGs = gs;
      // Track own player's authoritative position for prediction correction
      const ownP = slot === 3 ? gs.player3 : slot === 4 ? gs.player4 : gs.player2;
      if (ownP) {
        if (p2PredX === null) {
          p2PredX = ownP.x; p2PredY = ownP.y;
          p2PredFacing = ownP.facing; p2PredWalk = ownP.walkFrame;
        }
        p2AuthX = ownP.x; p2AuthY = ownP.y;
      }
      p1Prev = p1Curr ?? { x: gs.player.x, y: gs.player.y, facing: gs.player.facing, walkFrame: gs.player.walkFrame, t: Date.now() };
      p1Curr = { x: gs.player.x, y: gs.player.y, facing: gs.player.facing, walkFrame: gs.player.walkFrame, t: Date.now() };
    });
    unsubHostLobby = watchLobby(lobbyId, data => {
      if (!data) { cleanupOnlineGame(); showMenu(); }
    });
    lastTime = performance.now();
    requestAnimationFrame(guestLoop);
  }
}

function guestLoop(now: number): void {
  if (!isOnlineGame || isOnlineHost) return;
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;
  let justInteracted = false;
  if (input.p2InteractPressed) { guestInteractSeq++; justInteracted = true; }
  const inp: P2InputData = {
    up: keys.has('ArrowUp'), down: keys.has('ArrowDown'),
    left: keys.has('ArrowLeft'), right: keys.has('ArrowRight'),
    interactSeq: guestInteractSeq,
    // Send interact position so host can warp P2 to the right spot
    ...(justInteracted && p2PredX !== null ? { ix: p2PredX, iy: p2PredY! } : {}),
  };
  if (!lastSentInput ||
      inp.up !== lastSentInput.up || inp.down !== lastSentInput.down ||
      inp.left !== lastSentInput.left || inp.right !== lastSentInput.right ||
      inp.interactSeq !== lastSentInput.interactSeq) {
    lastSentInput = inp; pushGuestInput(inp);
  }
  if (remoteGs) {
    let displayGs = remoteGs;

    // P1 interpolation: lerp between last two snapshots for smooth P1 movement
    if (p1Prev && p1Curr && p1Curr.t !== p1Prev.t) {
      const interval = p1Curr.t - p1Prev.t;
      const t = Math.min(1, (Date.now() - p1Curr.t) / interval);
      let df = p1Curr.facing - p1Prev.facing;
      if (df > Math.PI) df -= 2 * Math.PI; if (df < -Math.PI) df += 2 * Math.PI;
      displayGs = { ...displayGs, player: { ...displayGs.player,
        x: p1Prev.x + (p1Curr.x - p1Prev.x) * t,
        y: p1Prev.y + (p1Curr.y - p1Prev.y) * t,
        facing:    p1Prev.facing + df * t,
        walkFrame: p1Prev.walkFrame + (p1Curr.walkFrame - p1Prev.walkFrame) * t,
      }};
    }

    // Local prediction: advance own player position so movement feels instant
    const ownAuthP = guestSlot === 3 ? displayGs.player3 : guestSlot === 4 ? displayGs.player4 : displayGs.player2;
    if (ownAuthP && p2PredX !== null) {
      if (remoteGs.activeMenu?.owner === guestSlot) {
        p2PredWalk = 0;
      } else {
        let dx = 0, dy = 0;
        if (inp.up)    dy -= 1;
        if (inp.down)  dy += 1;
        if (inp.left)  dx -= 1;
        if (inp.right) dx += 1;
        if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }
        if (dx !== 0 || dy !== 0) { p2PredFacing = Math.atan2(dy, dx); p2PredWalk += dt / 180; }
        const spd = PLAYER_SPEED * dt / 1000;
        p2PredX = Math.max(40, Math.min(1060, p2PredX! + dx * spd));
        p2PredY = Math.max(155, Math.min(690, p2PredY! + dy * spd));
        const ptmp = { x: p2PredX, y: p2PredY, radius: 18 } as any;
        resolveCollisions(ptmp, remoteGs.stations);
        p2PredX = ptmp.x; p2PredY = ptmp.y;
      }
      const isMoving = inp.up || inp.down || inp.left || inp.right;
      p2StoppedFrames = isMoving ? 0 : p2StoppedFrames + 1;
      if (!isMoving && p2StoppedFrames > 12 && p2AuthX !== null) {
        const err = Math.hypot(p2PredX! - p2AuthX, p2PredY! - p2AuthY!);
        if (err > 120)     { p2PredX = p2AuthX; p2PredY = p2AuthY!; }
        else if (err > 3)  { p2PredX = p2PredX! + (p2AuthX - p2PredX!) * 0.1; p2PredY = p2PredY! + (p2AuthY! - p2PredY!) * 0.1; }
      }
      const predPatch = { x: p2PredX!, y: p2PredY!, facing: p2PredFacing, walkFrame: p2PredWalk };
      if (guestSlot === 3 && displayGs.player3)
        displayGs = { ...displayGs, player3: { ...displayGs.player3, ...predPatch } };
      else if (guestSlot === 4 && displayGs.player4)
        displayGs = { ...displayGs, player4: { ...displayGs.player4, ...predPatch } };
      else if (displayGs.player2)
        displayGs = { ...displayGs, player2: { ...displayGs.player2, ...predPatch } };
    }

    try { render(displayGs); } catch (e) { console.error('[guest render]', e); }
  } else {
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0804'; ctx.fillRect(0, 0, GAME_W, GAME_H);
    ctx.fillStyle = '#f84'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText('CONNECTING TO HOST...', GAME_W/2, GAME_H/2);
  }
  flushFrame();
  requestAnimationFrame(guestLoop);
}

// ─── Tutorial ────────────────────────────────────────────────────────────────

interface TutorialStep {
  title: string;
  sub: string;
  done?: (gs: GameState) => boolean;
  timedMs?: number;
  onEnter?: (gs: GameState) => void;
  minLevel?: number;  // step only runs/shows at this level or higher
}

const TUTORIAL_STEPS: TutorialStep[] = [
  // ── Level 1 ──────────────────────────────────────────────────────────────────
  { title: 'WELCOME!',
    sub: 'Use the arrow buttons to move around the kitchen.',
    done: () => tutorialPlayerMoved,
    timedMs: 4000 },
  { title: 'PREP TIME',
    sub: 'In a real run you get 15 seconds to prep before orders start coming in. Use it wisely!',
    timedMs: 5000 },
  { title: 'OPEN THE COOLER',
    sub: 'Walk to the blue COOLER (back wall). Tap or press SPACE to open and close.',
    done: gs => gs.activeMenu?.stationId === 'cooler' },
  { title: 'GET RAW PORK',
    sub: 'Press the corresponding arrow button on screen to select Raw Pork.',
    done: gs => gs.player.held?.food === 'raw_pork' },
  { title: 'START THE SMOKER',
    sub: 'Walk to the SMOKER (far left wall). Tap or press SPACE to place the pork.',
    done: gs => gs.stations.some(s => s.kind === 'smoker' && s.slots.some(sl => sl.food !== null)) },
  { title: 'PORK IS SMOKING!',
    sub: 'It will be ready at the start of Level 2. Now let\'s take some orders!',
    timedMs: 3000 },
  { title: 'ORDER 1: HAMBURGER',
    sub: 'Get a RAW PATTY from COOLER. Walk to GRILL (top wall). Tap or SPACE to place.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Hamburger'); gs.nextOrderIn = 0; },
    done: gs => gs.stations.some(s => s.kind === 'grill' && s.slots.some(sl => sl.food !== null)) },
  { title: 'WAIT & PICK UP',
    sub: 'Green bar fills, then blinks when done. Tap or SPACE to pick up the patty.',
    done: gs => !!(gs.player.held?.food === 'patty' && !gs.player.held!.burned) },
  { title: 'PREP & DELIVER',
    sub: 'Tap/SPACE at PREP TABLE to stage. Grab the plate, walk to COUNTER to serve.',
    done: gs => gs.completed >= 1 },
  { title: 'ORDER 2: SM FRIES',
    sub: 'Walk to the FREEZER (back wall, far right). Tap or SPACE to open it.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Sm Fry'); gs.nextOrderIn = 0; },
    done: gs => gs.activeMenu?.stationId === 'freezer' },
  { title: 'GRAB RAW FRIES',
    sub: 'Press the corresponding arrow button on screen to select. Walk to FRYER.',
    done: gs => gs.stations.some(s => s.kind === 'fryer' && s.slots.some(sl => sl.food !== null)) },
  { title: 'FRIES COOK FAST',
    sub: 'Pick up when blinking. Stage on PREP TABLE and deliver!',
    done: gs => gs.completed >= 2 },
  // Inject a near-spoil fry; modal shows immediately, auto-advances when it spoils (~4s)
  { title: 'HEADS UP: FOOD SPOILS!',
    sub: 'That leftover fry is going bad — watch the timer bar on the prep table!',
    onEnter: gs => {
      gs.staged = gs.staged.filter(s => s.food !== 'fries');
      gs.staged.push({ food: 'fries', spoilTimer: STAGED_SPOIL_TIME - 4000, spoiled: false, count: 1 });
    },
    done: gs => gs.staged.some(s => s.food === 'fries' && s.spoiled) },
  // Modal auto-pops when fries spoil; player must pick them up and trash them
  { title: 'FOOD SPOILED!',
    sub: 'Empty hands → PREP TABLE to pick it up → TRASH (bottom right) to discard.',
    done: gs => !gs.staged.some(s => s.food === 'fries') && !(gs.player.held?.food === 'fries' && gs.player.held?.burned) },
  { title: 'ORDER 3: CHEESEBURGER',
    sub: 'Cook a PATTY on grill. Then get CHEESE from COOLER.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Cheeseburger'); gs.nextOrderIn = 0; },
    done: gs => gs.player.held?.food === 'cheese' },
  { title: 'MELT THE CHEESE',
    sub: 'Walk to a READY patty on grill. Tap or SPACE to melt cheese on it.',
    done: gs => gs.player.held?.food === 'cheese_patty' },
  { title: 'SERVE CHEESEBURGER',
    sub: 'Stage on PREP TABLE and deliver at COUNTER!',
    done: gs => gs.completed >= 3 },
  { title: 'ORDER 4: COMBO MEAL',
    sub: 'Cheeseburger + Sm Pups! Cook the cheese patty AND pups. Stage both.',
    onEnter: gs => { gs.tutorialOrderQueue.push('Cheeseburger+Sm Pup'); gs.nextOrderIn = 0; },
    done: gs => gs.completed >= 4 },
  { title: 'TIP: BURNED FOOD',
    sub: 'Red slot = burned! Grab it, walk to TRASH (bottom-right corner), drop it.',
    timedMs: 5000 },
  { title: 'YOUR SCORE = PROFIT',
    sub: 'Score = sales minus food costs, labor (1¢/sec ticking), and $20 end-of-shift overhead. Watch the HUD!',
    timedMs: 6000 },
  { title: 'CUSTOMER STARS',
    sub: 'Stars = satisfaction. Each failed or expired order costs 1 star. Lose all 5 = GAME OVER! Never let orders time out!',
    timedMs: 6000 },
  { title: 'CLOSING TIME!',
    sub: 'At closing time all extra food is discarded — except pork in the smoker. Clean it up!',
    onEnter: gs => { gs.levelTimer = 0; },
    done: gs => !gs.stations.some(st => st.slots.some(sl => sl.state === 'burned')) &&
                !gs.staged.some(si => si.spoiled) },
  // ── Level 2 (minLevel: 2 — blocked from running or showing during Level 1) ────
  { title: 'PORK IS READY!',
    sub: 'The pork should be finishing up soon. Walk to the SMOKER (far left) and pick it up when ready!',
    done: gs => gs.player.held?.food === 'whole_pork',
    minLevel: 2 },
  { title: 'CHOP TABLE',
    sub: 'Place on CHOP TABLE (bottom left). Tap or SPACE again to chop it up.',
    done: gs => gs.player.held?.food === 'pork',
    minLevel: 2 },
  { title: 'HOTDOG ORDER IN!',
    sub: 'An order came in! You can carry 2 of the same item — get 2 RAW HOT DOGS from COOLER and onto the GRILL!',
    onEnter: gs => { gs.tutorialOrderQueue.push('Hotdog'); gs.nextOrderIn = 0; },
    done: gs => gs.stations.some(s => s.kind === 'grill' &&
      s.slots.filter(sl => sl.food === 'raw_hotdog' || sl.food === 'hotdog').length >= 2),
    minLevel: 2 },
  { title: 'USE THE WARMER BOX',
    sub: 'Serve one hotdog for the order. Put the second in the WARMER BOX — food stored there never spoils!',
    done: gs => gs.stations.some(s => s.kind === 'warmer' && s.slots.some(sl => sl.food === 'hotdog')) &&
                gs.completed > tutorialBaseCompleted,
    minLevel: 2 },
  { title: 'BBQ ORDERS IN!',
    sub: 'BBQ Sand. and BBQ Plate just came in! Use pork from the CHOP TABLE — pick up 2 portions for the BBQ Plate.',
    onEnter: gs => { gs.tutorialOrderQueue.push('BBQ Sand.', 'BBQ Plate'); gs.nextOrderIn = 0; },
    done: gs => gs.completed > tutorialBaseCompleted + 2,
    minLevel: 2 },
  { title: 'ANOTHER HOTDOG!',
    sub: 'One more hotdog order — grab it from the WARMER BOX and deliver!',
    onEnter: gs => {
      gs.tutorialOrderQueue.push('Hotdog'); gs.nextOrderIn = 0;
      if (gs.chopOutput > 0) gs.chopOutputSpoiled = true;
    },
    done: gs => gs.completed > tutorialBaseCompleted + 3,
    minLevel: 2 },
  { title: 'PORK WENT BAD!',
    sub: 'The leftover pork on the CHOP TABLE spoiled! Pick it up and toss it in the TRASH.',
    done: gs => gs.chopOutput === 0,
    minLevel: 2 },
  { title: 'CLOSING TIME!',
    sub: 'End of shift! All extra food is discarded — except pork in the smoker. Clean it up!',
    onEnter: gs => { gs.levelTimer = 0; },
    done: gs => !gs.stations.some(st => st.slots.some(sl => sl.state === 'burned')) &&
                !gs.staged.some(si => si.spoiled) && !gs.chopOutputSpoiled,
    minLevel: 2 },
  { title: 'END OF SHIFT REPORT',
    sub: 'After every shift: a financial report shows sales, food costs, labor, overhead, waste, and net profit. After game over you\'ll see the SEASON TOTAL — that\'s your leaderboard rank!',
    timedMs: 8000,
    minLevel: 2 },
];

function tickTutorial(gs: GameState, dt: number): void {
  if (!tutorialPlayerMoved && (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD') ||
      keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight'))) {
    tutorialPlayerMoved = true;
  }
  if (tutorialModalActive) {
    if (input.interactPressed || input.p2InteractPressed) { tutorialModalActive = false; tutorialHintTimer = 0; }
    return;
  }
  if (tutorialStep >= TUTORIAL_STEPS.length) {
    // All steps done — end the level once nothing is in-flight
    if (gs.tutorialOrderQueue.length === 0 && gs.orders.length === 0 &&
        gs.plates.length === 0 && gs.staged.length === 0 && gs.phase === 'playing') {
      gs.levelTimer = 0;
    }
    return;
  }
  const step = TUTORIAL_STEPS[tutorialStep];
  // Level gate: Level 2 steps don't run or show while still in Level 1 — end Level 1 first
  if (step.minLevel && gs.level < step.minLevel) {
    if (gs.tutorialOrderQueue.length === 0 && gs.orders.length === 0 &&
        gs.plates.length === 0 && gs.staged.length === 0 && gs.phase === 'playing') {
      gs.levelTimer = 0;
    }
    return;
  }
  const advance = (): void => {
    tutorialStep++; tutorialHintTimer = 0;
    if (tutorialStep < TUTORIAL_STEPS.length) {
      const next = TUTORIAL_STEPS[tutorialStep];
      next.onEnter?.(gs);
      // Only show modal for action-required steps (not timed/informational ones)
      if (next.timedMs === undefined && (!next.minLevel || gs.level >= next.minLevel)) tutorialModalActive = true;
    }
  };
  if (step.timedMs !== undefined) {
    tutorialHintTimer += dt;
    if (tutorialHintTimer >= step.timedMs || step.done?.(gs)) advance();
  } else if (step.done?.(gs)) {
    advance();
  }
  // Suppress random order spawning — only scripted orders (via onEnter) may appear
  if (gs.tutorialOrderQueue.length === 0) gs.nextOrderIn = 9999999;
}

// ─── Main game loop ───────────────────────────────────────────────────────────

function loop(now: number): void {
  const dt = Math.min(now - lastTime, 100); lastTime = now;
  updateHUDRunStats(runSales, runCOGS, runLabor, runWaste, runOverhead, runSatisfactionSum, runSatisfactionCount);
  // In solo mode, Space bar acts as the primary interact key (clears p2 flag to avoid double-trigger)
  if (!isCoop && input.p2InteractPressed) { input.interactPressed = true; input.p2InteractPressed = false; }
  // Online co-op host: Space is P1's interact key (spacePressed is unambiguous — not shared with network P2 signal)
  if (isOnlineGame && isOnlineHost && input.spacePressed) input.interactPressed = true;
  if (screen === 'name_entry') {
    handleNameEntry(); if (gs) render(gs); drawNameEntry(nameChars, nameCursor, lastGameScore, lastGameLevel);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (screen === 'leaderboard') {
    if (input.interactPressed || input.p2InteractPressed) { dismissLeaderboard(); return; }
    if (gs) render(gs); drawLeaderboard(leaderboardEntries, lastGameScore, leaderboardMode);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (screen === 'game_report') {
    if (input.interactPressed || input.p2InteractPressed) {
      showMobileNameEntry();
      screen = 'name_entry';
      flushFrame(); requestAnimationFrame(loop); return;
    }
    if (gs) render(gs);
    drawGameReport(lastRunSales, runCOGS, runLabor, runWaste, runOverhead, runCompleted, runFailed, lastGameLevel, xpBreakdown, xpBreakdownTotal());
    flushFrame(); requestAnimationFrame(loop); return;
  }
  // Post-game overlay — arrow key navigation
  if (document.getElementById('postgameOverlay')!.style.display !== 'none') {
    const pgBtns = (['pgPlayAgain', 'pgLobby', 'pgMainMenu'] as const)
      .map(id => document.getElementById(id) as HTMLButtonElement)
      .filter(btn => btn.style.display !== 'none');
    if ((input.menuPickUp || input.p2MenuPickUp) && pgBtns.length > 0) {
      pgFocusIdx = (pgFocusIdx - 1 + pgBtns.length) % pgBtns.length;
      pgBtns[pgFocusIdx].focus();
    }
    if ((input.menuPickDown || input.p2MenuPickDown) && pgBtns.length > 0) {
      pgFocusIdx = (pgFocusIdx + 1) % pgBtns.length;
      pgBtns[pgFocusIdx].focus();
    }
    if ((input.interactPressed || input.p2InteractPressed) && pgBtns.length > 0) {
      pgBtns[pgFocusIdx].click();
    }
    flushFrame(); requestAnimationFrame(loop); return;
  }
  if (!gs) return;
  if (isPaused && gs.phase === 'playing') {
    lastTime = now;
    if (pauseSubScreen === 'controls' || pauseSubScreen === 'restaurant_menu') {
      if (input.interactPressed || input.p2InteractPressed) pauseSubScreen = null;
    } else {
      if (input.menuPickUp   || input.p2MenuPickUp)   pauseMenuIdx = (pauseMenuIdx-1+5)%5;
      if (input.menuPickDown || input.p2MenuPickDown) pauseMenuIdx = (pauseMenuIdx+1)%5;
      if (input.interactPressed || input.p2InteractPressed) {
        switch (pauseMenuIdx) {
          case 0: isPaused = false; pauseSubScreen = null; break;
          case 1: isPaused = false; flushFrame(); if (isOnlineGame) cleanupOnlineGame(); showMenu(); return;
          case 2: pauseSubScreen = 'restaurant_menu'; break;
          case 3: pauseSubScreen = 'controls'; break;
          case 4: leaderboardMode = isProMode ? (isCoop ? 'pro_coop' : 'pro_solo') : 'rookie'; leaderboardEntries = loadLeaderboard(leaderboardMode); leaderboardReturn = 'pause'; screen = 'leaderboard'; break;
        }
      }
    }
    render(gs);
    if (pauseSubScreen === 'controls') drawControlsOverlay();
    else if (pauseSubScreen === 'restaurant_menu') drawRestaurantMenu();
    else drawPauseMenu(pauseMenuIdx);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  // Inactivity: 60s of no input during active play → game over, no XP rewarded
  if (gs.phase === 'playing' && !isPaused && Date.now() - _lastInputTime > INACTIVITY_MS) {
    clearPendingXP();
    resetXPBreakdown();
    gs.phase = 'game_over';
    gs.levelEndTimer = 4000;
  }
  if (!(isTutorial && tutorialModalActive)) tickGame(gs, dt);
  if (isTutorial) tickTutorial(gs, dt);
  if (gs.phase === 'level_end' && (gs.levelEndTimer <= 0 || input.p2InteractPressed || input.interactPressed)) {
    recordLevelStats(gs);
    runSales += gs.levelSales; runCOGS += gs.levelCOGS; runLabor += gs.levelLabor;
    runWaste += gs.levelWaste; runOverhead += gs.levelOverhead;
    runCompleted += gs.completed; runFailed += gs.failed;
    runSatisfactionSum += gs.levelSatisfactionSum; runSatisfactionCount += gs.levelSatisfactionCount;
    if (isTutorial && gs.level === 2) {
      isTutorial = false; tutorialStep = 0; tutorialModalActive = false;
      goToNameEntry(gs); requestAnimationFrame(loop); return;
    }
    if (gs.level < LEVELS.length) {
      const smoker = gs.stations.find(s => s.kind === 'smoker');
      startLevel(gs.level+1, gs.score, smoker?.slots.map(sl=>({...sl})), Math.max(0,gs.failed-1), gs.thresholdsUnlocked, gs.meter);
      if (isTutorial && gs) {
        gs.tutorialOrderQueue = [];
        gs.levelTimer = 9999999;
        tutorialBaseCompleted = gs.completed;
        TUTORIAL_STEPS[tutorialStep]?.onEnter?.(gs);
        tutorialModalActive = true;
      }
      return;
    }
    goToNameEntry(gs); requestAnimationFrame(loop); return;
  }
  if (gs.phase === 'game_over') {
    if (gs.levelEndTimer <= 0) {
      runSales += gs.levelSales; runCOGS += gs.levelCOGS; runLabor += gs.levelLabor;
      runWaste += gs.levelWaste; runCompleted += gs.completed; runFailed += gs.failed;
      runSatisfactionSum += gs.levelSatisfactionSum; runSatisfactionCount += gs.levelSatisfactionCount;
      recordLevelStats(gs);
      goToGameReport(gs); requestAnimationFrame(loop); return;
    }
    render(gs);
    if (isTutorial) drawTutorialHint(tutorialStep, TUTORIAL_STEPS);
    flushFrame(); requestAnimationFrame(loop); return;
  }
  render(gs);
  if (isTutorial) {
    if (tutorialModalActive) drawTutorialModal(tutorialStep, TUTORIAL_STEPS);
    else drawTutorialHint(tutorialStep, TUTORIAL_STEPS);
  }
  flushFrame(); requestAnimationFrame(loop);
}

// ─── Lobby screen ─────────────────────────────────────────────────────────────

const lobbyScreen = document.getElementById('lobbyScreen')!;

// Mobile name entry submit
document.getElementById('neSubmit')?.addEventListener('click', () => {
  const inp = document.getElementById('neInput') as HTMLInputElement;
  const raw = inp.value.toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 3).padEnd(3, 'A');
  for (let i = 0; i < 3; i++) nameChars[i] = raw[i] ?? 'A';
  submitName();
});
document.getElementById('neInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('neSubmit')?.click();
});

// Achievements overlay
function openAchievementsOverlay(): void {
  const overlay = document.getElementById('achievementsOverlay')!;
  const list    = document.getElementById('achievementsList')!;
  const prof    = getProfile();
  const ROMAN   = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
  const isDollar = (stat: string) => stat.startsWith('total_');
  const fmt = (v: number, dollar: boolean) =>
    dollar ? `$${(v / 100).toLocaleString()}` : v.toLocaleString();

  list.innerHTML = ACHIEVEMENTS.map(ach => {
    const cur    = prof?.achievements[ach.id] ?? -1;
    const stat   = prof?.stats[ach.stat] ?? 0;
    const dollar = isDollar(ach.stat);
    const maxed  = cur >= ach.tiers.length - 1;
    const nextTier = maxed ? ach.tiers[ach.tiers.length - 1] : ach.tiers[cur + 1];
    const pct    = maxed ? 100 : Math.min(100, Math.round((stat / nextTier) * 100));

    const tiers = ach.tiers.map((t, i) => {
      const unlocked = i <= cur;
      const label = t >= 100000 ? `$${(t / 100).toLocaleString()}` : t.toLocaleString();
      return `<span class="ach-tier${unlocked ? ' unlocked' : ''}" title="Tier ${ROMAN[i]}: ${label}">${ROMAN[i] ?? i + 1}</span>`;
    }).join('');

    const progressLabel = maxed
      ? 'ALL TIERS COMPLETE'
      : `${fmt(stat, dollar)} / ${fmt(nextTier, dollar)}`;

    const nextTierIndex = cur + 1;
    const descSuffix = maxed
      ? ' (All Tiers Unlocked)'
      : ` (Tier ${ROMAN[nextTierIndex] ?? nextTierIndex + 1}: ${fmt(nextTier, dollar)})`;

    return `<div class="ach-row${cur >= 0 ? ' ach-has' : ''}">
      <div class="ach-row-top">
        <span class="ach-name">${ach.name}</span>
        <div class="ach-tiers">${tiers}</div>
      </div>
      <div class="ach-desc">${ach.desc}${descSuffix}</div>
      <div class="ach-progress">
        <div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%"></div></div>
        <span class="ach-progress-text">${progressLabel}</span>
      </div>
    </div>`;
  }).join('');
  overlay.style.display = 'flex';
}

function closeAchievementsOverlay(): void {
  document.getElementById('achievementsOverlay')!.style.display = 'none';
}

document.getElementById('achievementsClose')?.addEventListener('click', closeAchievementsOverlay);
document.getElementById('lobbyAchievements')?.addEventListener('click', openAchievementsOverlay);

// ── Gender picker ──────────────────────────────────────────────────────────────
function showGenderPicker(): void {
  const m = document.getElementById('genderModal')!;
  m.style.display = 'flex';
}
document.getElementById('genderFemale')?.addEventListener('click', () => {
  setGender('female'); saveProfilePrefs().catch(console.error);
  document.getElementById('genderModal')!.style.display = 'none';
});
document.getElementById('genderMale')?.addEventListener('click', () => {
  setGender('male'); saveProfilePrefs().catch(console.error);
  document.getElementById('genderModal')!.style.display = 'none';
});

// ── Familiar ability picker ────────────────────────────────────────────────────
function showFamiliarPicker(): void {
  if (getProfile()?.familiarAbility) return;
  document.getElementById('familiarModal')!.style.display = 'flex';
}
document.querySelectorAll('.fam-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    const ability = (e.currentTarget as HTMLElement).dataset.ability as FamiliarAbility;
    setFamiliarAbility(ability); saveProfilePrefs().catch(console.error);
    document.getElementById('familiarModal')!.style.display = 'none';
    refreshSkillTree();
    showToast('FAMILIAR ABILITY SET', ability.replace(/_/g, ' ').toUpperCase());
  });
});

// ── Skill tree ─────────────────────────────────────────────────────────────────
const UNLOCK_LEVELS: Record<string, number> = { dash: 3, familiar: 5, double_dash: 8, mount: 10, spec_meter: 13, familiar_up: 15, mount_up: 20 };

function refreshSkillTree(): void {
  const prof = getProfile();
  const lv = prof?.level ?? 0;
  const xp = prof?.xp ?? 0;
  const unlockLevels = Object.values(UNLOCK_LEVELS).sort((a,b)=>a-b);
  const nextUnlock = unlockLevels.find(n => n > lv);

  const labelEl = document.getElementById('stLevelLabel');
  if (labelEl) labelEl.textContent = lv > 0
    ? `Level ${lv}${nextUnlock ? `  —  next unlock at Level ${nextUnlock}` : '  —  all unlocked!'}`
    : 'Sign in to see your progress';

  // XP progress bar
  const barWrap = document.getElementById('stXPBarWrap');
  if (barWrap) {
    if (lv > 0) {
      barWrap.style.display = 'block';
      const prog = xpProgress(xp);
      const pct = prog.needed > 0 ? Math.min(100, Math.round(prog.current / prog.needed * 100)) : 100;
      (document.getElementById('stXPBar') as HTMLElement).style.width = pct + '%';
      (document.getElementById('stXPLabel') as HTMLElement).textContent = `${xp.toLocaleString()} XP  (${prog.current}/${prog.needed} to next)`;
      (document.getElementById('stXPNext') as HTMLElement).textContent = nextUnlock ? `Unlock at Lv ${nextUnlock}` : 'Max unlocks reached';
      // Pip markers for each unlock level
      const pipsEl = document.getElementById('stUnlockPips');
      if (pipsEl) {
        pipsEl.innerHTML = unlockLevels.map(ulv => {
          const done = lv >= ulv;
          return `<span style="color:${done?'#f84':'#443'};font-weight:bold;">${done?'✓':'○'}Lv${ulv}</span>`;
        }).join('');
      }
    } else {
      barWrap.style.display = 'none';
    }
  }

  Object.entries(UNLOCK_LEVELS).forEach(([key, req]) => {
    document.getElementById(`stNode-${key}`)?.classList.toggle('unlocked', lv >= req);
  });

  const famSection = document.getElementById('stFamSection');
  if (famSection) famSection.style.display = lv >= 5 ? 'flex' : 'none';

  const chosen = prof?.familiarAbility;
  document.querySelectorAll<HTMLElement>('.st-fam-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ability === chosen);
  });
}

function openSkillTree(): void {
  refreshSkillTree();
  document.getElementById('skillTreeModal')!.style.display = 'flex';
}

document.getElementById('skillTreeBtn')?.addEventListener('click', openSkillTree);
document.getElementById('stCloseBtn')?.addEventListener('click', () => {
  document.getElementById('skillTreeModal')!.style.display = 'none';
});

// ── Profile reset ──────────────────────────────────────────────────────────────
async function doResetProfile(): Promise<void> {
  if (!user) { showToast('SIGN IN REQUIRED', 'Sign in to reset your profile'); return; }
  document.getElementById('resetModal')!.style.display = 'flex';
}
document.getElementById('stResetBtn')?.addEventListener('click', doResetProfile);
document.getElementById('resetProfileBtn')?.addEventListener('click', doResetProfile);
document.getElementById('resetConfirm')?.addEventListener('click', async () => {
  document.getElementById('resetModal')!.style.display = 'none';
  await resetProfile();
  updateAuthUI();
  updateLobbyXPBar();
  refreshSkillTree();
  showToast('PROFILE RESET', 'Level and XP have been wiped');
});
document.getElementById('resetCancel')?.addEventListener('click', () => {
  document.getElementById('resetModal')!.style.display = 'none';
});

function openLobbyScreen(): void {
  if (gs !== null && screen === 'game') return; // never hijack an active game
  menu.style.display = 'none';
  lobbyScreen.style.display = 'flex';
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
  (window.screen.orientation as any)?.lock?.('landscape').catch(() => {});
  // 1 PLAYER is always available; co-op + social features require sign-in
  showSizePicker = false; isMatchmaking = false;
  document.getElementById('lobbyToolbar')!.style.display = 'flex';
  const coopBtn = document.getElementById('lobbyPlayCoop') as HTMLButtonElement;
  coopBtn.disabled = !user;
  coopBtn.title    = user ? '' : 'Sign in to play co-op';
  if (!user) {
    document.getElementById('lobbyAuthRequired')!.style.display = 'flex';
    document.getElementById('lobbyContent')!.style.display      = 'none';
    return;
  }
  document.getElementById('lobbyAuthRequired')!.style.display = 'none';
  document.getElementById('lobbyContent')!.style.display      = 'flex';
  renderMatchmakingUI();

  updateLobbyXPBar();
  setPresence(user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  unsubPresence   = watchPresence(users => { onlineUsers = users; renderOnlineUsers(); });
  unsubGlobalChat = watchGlobalChat(renderGlobalChat);
  unsubInvites    = watchIncomingInvites(user.uid, handleIncomingInvites);
  playPlaylist(LOBBY_TRACKS);
  // Auto-focus first button so arrow keys work immediately without clicking first
  requestAnimationFrame(() => focusFirstLobbyBtn());
}

function closeLobbyScreen(): void {
  lobbyScreen.style.display = 'none';
  cancelMatchmakingFn();
  stopMatchwatch?.(); stopMatchwatch = null;
  stopQueueWatch?.(); stopQueueWatch = null;
  if (partyLobbyId) leaveParty();
  if (user) clearPresence(user.uid);
  unsubGlobalChat?.(); unsubGlobalChat = null;
  unsubPresence?.();   unsubPresence   = null;
  unsubInvites?.();    unsubInvites    = null;
  unsubSentInvite?.(); unsubSentInvite = null;
  // Cancel any pending invite we sent
  if (pendingInviteId) {
    deleteInvite(pendingInviteId).catch(()=>{});
    pendingInviteId = null;
  }
  if (pendingInviteLobbyId) {
    deleteLobby(pendingInviteLobbyId).catch(()=>{});
    pendingInviteLobbyId = null;
  }
  pendingInviteToUid = null;
}

// Online users panel
function renderOnlineUsers(): void {
  const el = document.getElementById('onlineList')!;
  const others = onlineUsers.filter(u => u.uid !== user?.uid);
  if (others.length === 0) {
    el.innerHTML = '<div class="online-empty">no one else online</div>';
  } else {
    el.innerHTML = others.map(u => {
      const isTarget  = pendingInviteToUid === u.uid;
      const canAct    = !pendingInviteId && !isMatchmaking;
      return `<div class="online-row">
        ${u.photo ? `<img class="online-photo" src="${u.photo}" />` : '<div class="online-photo-ph"></div>'}
        <span class="online-name">${escHtml(u.name)}</span>
        ${isTarget
          ? `<button class="cancel-invite-btn">CANCEL</button>`
          : canAct
            ? `<button class="invite-btn" data-uid="${u.uid}" data-name="${escHtml(u.name)}">INVITE</button><button class="join-btn" data-uid="${u.uid}" data-name="${escHtml(u.name)}">JOIN</button>`
            : ''}
      </div>`;
    }).join('');
    el.querySelectorAll('.invite-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid  = (btn as HTMLElement).dataset.uid!;
        const name = (btn as HTMLElement).dataset.name!;
        handleSendInvite(uid, name);
      });
    });
    el.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid  = (btn as HTMLElement).dataset.uid!;
        const name = (btn as HTMLElement).dataset.name!;
        handleSendJoinRequest(uid, name);
      });
    });
    el.querySelector('.cancel-invite-btn')?.addEventListener('click', handleCancelInvite);
  }
  // Also show ourselves
  if (user) {
    const me = onlineUsers.find(u => u.uid === user!.uid);
    const selfEl    = document.getElementById('onlineSelf')!;
    const selfPhoto = document.getElementById('onlineSelfPhoto') as HTMLImageElement;
    const selfName  = document.getElementById('onlineSelfName')!;
    selfEl.style.display = 'flex';
    selfPhoto.src = user.photoURL ?? '';
    selfPhoto.style.display = user.photoURL ? '' : 'none';
    selfName.textContent = me ? me.name : (user.displayName ?? '');
  }
}

// Global chat
function renderGlobalChat(msgs: GlobalChatMsg[]): void {
  const box = document.getElementById('globalChatMessages')!;
  if (msgs.length === 0) {
    box.innerHTML = '<div class="chat-empty">say something!</div>';
    return;
  }
  box.innerHTML = msgs.map(m =>
    `<div class="chat-msg ${m.uid === user?.uid ? 'chat-mine' : ''}">
      <span class="chat-name">${escHtml(m.name)}</span>
      <span class="chat-text">${escHtml(m.text)}</span>
    </div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

async function handleGlobalSend(): Promise<void> {
  if (!user) return;
  const inp = document.getElementById('globalChatInput') as HTMLInputElement;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await sendGlobalMessage(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', text);
}

// Invites
async function handleCancelInvite(): Promise<void> {
  stopMatchwatch?.(); stopMatchwatch = null; // also cleans up join-request watchForMatch
  unsubSentInvite?.(); unsubSentInvite = null;
  if (pendingInviteId) { deleteInvite(pendingInviteId).catch(() => {}); pendingInviteId = null; }
  if (pendingInviteLobbyId) { deleteLobby(pendingInviteLobbyId).catch(() => {}); pendingInviteLobbyId = null; }
  pendingInviteToUid = null;
  renderOnlineUsers();
}

async function handleSendJoinRequest(toUid: string, toName: string): Promise<void> {
  if (!user || pendingInviteId || isMatchmaking) return;
  const u = user;
  // Watch for the host to send us a lobby after accepting
  stopMatchwatch = watchForMatch(u.uid, async (lobbyId, playerCount) => {
    stopMatchwatch = null;
    pendingInviteId = null; pendingInviteToUid = null;
    unsubSentInvite?.(); unsubSentInvite = null;
    renderOnlineUsers();
    const slot = await joinLobby(lobbyId, u.uid, u.displayName ?? 'Player', u.photoURL ?? '');
    if (slot) startOnlineGame(lobbyId, false, slot, playerCount);
    else showMenu();
  });
  // Send join request — lobbyId empty because host creates it on accept
  const inviteId = await sendInvite(u.uid, u.displayName ?? 'Player', u.photoURL ?? '', toUid, '', 'join_request');
  pendingInviteId = inviteId;
  pendingInviteToUid = toUid;
  renderOnlineUsers();
  unsubSentInvite?.();
  unsubSentInvite = watchSentInvite(inviteId, invite => {
    if (!invite || invite.status === 'declined') {
      stopMatchwatch?.(); stopMatchwatch = null;
      pendingInviteId = null; pendingInviteToUid = null;
      unsubSentInvite?.(); unsubSentInvite = null;
      renderOnlineUsers();
    }
  });
}

async function handleSendInvite(toUid: string, toName: string): Promise<void> {
  if (!user || pendingInviteId) return;
  const lobbyId  = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', 2);
  const inviteId = await sendInvite(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', toUid, lobbyId);
  pendingInviteId      = inviteId;
  pendingInviteLobbyId = lobbyId;
  pendingInviteToUid   = toUid;
  renderOnlineUsers(); // update buttons to show CANCEL

  // Watch for response
  unsubSentInvite?.();
  unsubSentInvite = watchSentInvite(inviteId, invite => {
    if (!invite || invite.status === 'declined') {
      // Declined or deleted
      pendingInviteId = null; pendingInviteToUid = null;
      if (pendingInviteLobbyId) { deleteLobby(pendingInviteLobbyId).catch(()=>{}); pendingInviteLobbyId = null; }
      unsubSentInvite?.(); unsubSentInvite = null;
      renderOnlineUsers();
      showInviteBanner(null);
    } else if (invite.status === 'accepted') {
      // Guest accepted — watch the lobby for 'starting'
      unsubSentInvite?.(); unsubSentInvite = null;
      unsubHostLobby?.();
      unsubHostLobby = watchLobby(invite.lobbyId, data => {
        if (data?.status === 'starting') {
          unsubHostLobby?.(); unsubHostLobby = null;
          pendingInviteId = null; pendingInviteLobbyId = null; pendingInviteToUid = null;
          const pCount = 1 + (data.guestUid ? 1 : 0) + (data.guest2Uid ? 1 : 0) + (data.guest3Uid ? 1 : 0);
          startOnlineGame(invite.lobbyId, true, 1, pCount);
        }
      });
    }
  });
}

// ─── Party room (2–4 players) ─────────────────────────────────────────────────

let partyLobbyId: string | null = null;
let partyIsHost = false;
let partySlot = 2;
let unsubPartyLobby: (() => void) | null = null;
let partyLatestData: LobbyData | null = null;

function renderPartyPanel(data: LobbyData | null): void {
  partyLatestData = data;
  const panel = document.getElementById('partyPanel')!;
  if (!data) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('lobbyContent')!.style.display = 'none';
  document.getElementById('lobbyActions')!.style.display  = 'none';

  document.getElementById('partyCodeBlock')!.style.display = partyIsHost ? '' : 'none';
  document.getElementById('partyCodeVal')!.textContent      = (data.id ?? partyLobbyId ?? '').slice(0, 8).toUpperCase();
  document.getElementById('partyStart')!.style.display      = partyIsHost ? '' : 'none';

  const maxP = data.maxPlayers ?? 4;
  const slots = [
    { label: data.hostName + ' (HOST)', filled: true },
    { label: data.guestUid  ? data.guestName  ?? 'Player 2' : 'Waiting...', filled: !!data.guestUid },
    ...(maxP >= 3 ? [{ label: data.guest2Uid ? data.guest2Name ?? 'Player 3' : 'Waiting...', filled: !!data.guest2Uid }] : []),
    ...(maxP >= 4 ? [{ label: data.guest3Uid ? data.guest3Name ?? 'Player 4' : 'Waiting...', filled: !!data.guest3Uid }] : []),
  ];
  document.getElementById('partySlots')!.innerHTML = slots.map((s, i) =>
    `<div style="padding:3px 6px;border-radius:3px;background:${s.filled ? '#1a0c04' : '#0a0604'};border:1px solid ${s.filled ? '#f84' : '#332'};color:${s.filled ? '#f84' : '#443'};font-size:0.82rem">
      P${i + 1} ${escHtml(s.label)}
    </div>`
  ).join('');
}

async function openPartyAsHost(): Promise<void> {
  if (!user) return;
  partyIsHost = true;
  partyLobbyId = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', 4);
  unsubPartyLobby = watchLobby(partyLobbyId, data => {
    renderPartyPanel(data ? { ...data, id: partyLobbyId! } : null);
  });
}

async function joinPartyByCode(code: string): Promise<void> {
  if (!user) return;
  const full = code.trim();
  // Find lobby by ID prefix (we show first 8 chars) — try direct match first
  const candidates = full.length >= 8 ? [full] : [];
  // Also search Firestore for matching lobby — for simplicity accept 8+ char codes as full IDs
  const lobbyId = full;
  const slot = await joinLobby(lobbyId, user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  if (!slot) { alert('Party not found or full.'); return; }
  partyIsHost = false;
  partySlot = slot;
  partyLobbyId = lobbyId;
  // Show panel immediately with placeholder; real data arrives from watchLobby callback
  document.getElementById('joinPartyRow')!.style.display = 'none';
  document.getElementById('partyPanel')!.style.display = 'block';
  document.getElementById('lobbyContent')!.style.display = 'none';

  unsubPartyLobby = watchLobby(lobbyId, data => {
    if (!data) { leaveParty(); return; }
    renderPartyPanel({ ...data, id: lobbyId } as any);
    if (data.status === 'starting') {
      const pCount = 1 + (data.guestUid ? 1 : 0) + (data.guest2Uid ? 1 : 0) + (data.guest3Uid ? 1 : 0);
      leavePartyCleanup();
      startOnlineGame(lobbyId, false, slot, pCount);
    }
  });
}

function leavePartyCleanup(): void {
  unsubPartyLobby?.(); unsubPartyLobby = null;
  partyLobbyId = null; partyIsHost = false;
  const panel = document.getElementById('partyPanel')!;
  panel.style.display = 'none';
  document.getElementById('lobbyContent')!.style.display = 'flex';
  document.getElementById('lobbyActions')!.style.display  = 'flex';
}

function leaveParty(): void {
  if (partyLobbyId && partyIsHost) deleteLobby(partyLobbyId).catch(() => {});
  partyLobbyId = null;
  leavePartyCleanup();
}

document.getElementById('partyCodeCopy')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(partyLobbyId ?? '').catch(() => {});
});

document.getElementById('partyStart')?.addEventListener('click', async () => {
  if (!partyLobbyId || !partyIsHost) return;
  const data = partyLatestData;
  const pCount = data ? 1 + (data.guestUid ? 1 : 0) + (data.guest2Uid ? 1 : 0) + (data.guest3Uid ? 1 : 0) : 1;
  const startLobbyId = partyLobbyId;
  await setLobbyStatus(startLobbyId, 'starting');
  leavePartyCleanup(); // clears partyLobbyId so closeLobbyScreen won't delete it
  startOnlineGame(startLobbyId, true, 1, pCount);
});

document.getElementById('partyLeave')?.addEventListener('click', leaveParty);

document.getElementById('lobbyCreateParty')?.addEventListener('click', async () => {
  if (!user) return;
  document.getElementById('lobbyActions')!.style.display = 'none';
  await openPartyAsHost();
});

document.getElementById('lobbyJoinParty')?.addEventListener('click', () => {
  document.getElementById('lobbyActions')!.style.display = 'none';
  document.getElementById('joinPartyRow')!.style.display = 'flex';
  document.getElementById('joinPartyCode')!.focus();
});
document.getElementById('joinPartyBtn')?.addEventListener('click', () => {
  const code = (document.getElementById('joinPartyCode') as HTMLInputElement).value.trim();
  if (code) joinPartyByCode(code);
});
document.getElementById('joinPartyCancel')?.addEventListener('click', () => {
  document.getElementById('joinPartyRow')!.style.display = 'none';
  document.getElementById('lobbyActions')!.style.display = 'flex';
});

function handleIncomingInvites(invites: InviteData[]): void {
  receivedInvites = invites;
  showInviteBanner(invites[0] ?? null);
}

function showInviteBanner(invite: InviteData | null): void {
  const banner = document.getElementById('inviteBanner')!;
  if (!invite) { banner.style.display = 'none'; return; }
  banner.style.display = 'flex';
  document.getElementById('inviteText')!.textContent =
    `🍖 ${invite.fromName} wants to cook with you!`;
  document.getElementById('inviteAcceptBtn')!.onclick  = () => handleAcceptInvite(invite);
  document.getElementById('inviteDeclineBtn')!.onclick = () => handleDeclineInvite(invite);
}

async function handleAcceptInvite(invite: InviteData): Promise<void> {
  if (!user) return;
  showInviteBanner(null);
  if (invite.type === 'join_request') {
    // They want to join us — we become the host
    const lobbyId = await createLobby(user.uid, user.displayName ?? 'Player', user.photoURL ?? '', 2);
    await respondToInvite(invite.id, 'accepted');
    await notifyMatch(invite.fromUid, lobbyId, 2);
    startOnlineGame(lobbyId, true, 1, 2);
    return;
  }
  const slot = await joinLobby(invite.lobbyId, user.uid, user.displayName ?? 'Player', user.photoURL ?? '');
  if (!slot) return;
  await respondToInvite(invite.id, 'accepted');
  await setLobbyStatus(invite.lobbyId, 'starting');
  startOnlineGame(invite.lobbyId, false, slot);
}

async function handleDeclineInvite(invite: InviteData): Promise<void> {
  showInviteBanner(null);
  await respondToInvite(invite.id, 'declined');
}

// ─── Matchmaking ─────────────────────────────────────────────────────────────

function renderMatchmakingUI(): void {
  const busy = isMatchmaking || showSizePicker;
  document.getElementById('lobbyActions')!.style.display      = busy ? 'none' : 'flex';
  document.getElementById('coopSizePicker')!.style.display    = showSizePicker ? 'flex' : 'none';
  document.getElementById('matchmakingStatus')!.style.display = isMatchmaking  ? 'flex' : 'none';
  document.getElementById('mmSize')!.textContent = String(coopQueueSize);
  requestAnimationFrame(() => focusFirstLobbyBtn());
}

async function startSizedMatchmaking(size: number): Promise<void> {
  if (!user || isMatchmaking) return;
  const u = user;
  coopQueueSize = size;
  isMatchmaking = true;
  showSizePicker = false;
  renderMatchmakingUI();
  document.getElementById('mmCount')!.textContent = `(1/${size})`;

  // Watch queue count for live "X/N" display
  stopQueueWatch = watchSizedQueue(size, count => {
    document.getElementById('mmCount')!.textContent = count > 0 ? `(${count}/${size})` : '';
  });

  try {
    const players = await joinSizedQueue(u.uid, u.displayName ?? 'Player', u.photoURL ?? '', size);
    if (!isMatchmaking) return; // cancelled

    if (players) {
      // We filled the queue — we're the host
      stopQueueWatch?.(); stopQueueWatch = null;
      const lobbyId = await createLobby(u.uid, u.displayName ?? 'Player', u.photoURL ?? '', size);
      const others = players.filter(p => p.uid !== u.uid);
      await Promise.all(others.map((p, i) => notifyMatch(p.uid, lobbyId, size)));
      isMatchmaking = false;
      startOnlineGame(lobbyId, true, 1, size);
    } else {
      // Waiting — watch for host notification
      stopMatchwatch = watchForMatch(u.uid, async (lobbyId, playerCount) => {
        stopQueueWatch?.(); stopQueueWatch = null;
        isMatchmaking = false;
        stopMatchwatch = null;
        const slot = await joinLobby(lobbyId, u.uid, u.displayName ?? 'Player', u.photoURL ?? '');
        if (slot) startOnlineGame(lobbyId, false, slot, playerCount);
        else showMenu();
      });
    }
  } catch {
    isMatchmaking = false;
    stopQueueWatch?.(); stopQueueWatch = null;
    renderMatchmakingUI();
  }
}

function cancelMatchmakingFn(): void {
  if (!isMatchmaking && !showSizePicker) return;
  isMatchmaking = false;
  showSizePicker = false;
  stopMatchwatch?.(); stopMatchwatch = null;
  stopQueueWatch?.(); stopQueueWatch = null;
  if (user) leaveSizedQueue(user.uid, coopQueueSize);
  renderMatchmakingUI();
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Wire up lobby buttons ────────────────────────────────────────────────────

document.getElementById('lobbyBack')!.addEventListener('click', () => { closeLobbyScreen(); showMenu(); });
document.getElementById('lobbySignIn')!.addEventListener('click', () =>
  signInWithGoogle().then(() => openLobbyScreen()).catch(console.error));

// Show iOS hint in the auth-required section for Safari users
if (/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)) {
  const hint = document.getElementById('iosHint');
  if (hint) hint.style.display = 'block';
}
document.getElementById('globalChatSend')!.addEventListener('click', handleGlobalSend);
document.getElementById('globalChatInput')!.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleGlobalSend();
});
document.getElementById('lobbyPlaySolo')!.addEventListener('click', () => {
  closeLobbyScreen(); isCoop = false; lobbyPlayerCount = 1; isProMode = true; startLevel(1, STARTING_MONEY);
  if (gs) render(gs); flushFrame();
});
document.getElementById('lobbyPlayCoop')!.addEventListener('click', () => {
  if (!user) return;
  showSizePicker = true;
  renderMatchmakingUI();
  document.getElementById('coopSize2')!.focus();
});
document.getElementById('coopSize2')!.addEventListener('click', () => startSizedMatchmaking(2));
document.getElementById('coopSize3')!.addEventListener('click', () => startSizedMatchmaking(3));
document.getElementById('coopSize4')!.addEventListener('click', () => startSizedMatchmaking(4));
document.getElementById('coopSizeCancel')!.addEventListener('click', cancelMatchmakingFn);
document.getElementById('cancelMatchmakingBtn')!.addEventListener('click', cancelMatchmakingFn);

// ─── Lobby keyboard navigation ────────────────────────────────────────────────

function focusFirstLobbyBtn(): void {
  const btn = Array.from(
    lobbyScreen.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  ).find(b => b.offsetParent !== null);
  btn?.focus();
}

window.addEventListener('keydown', e => {
  if (lobbyScreen.style.display === 'none') return;
  const nav = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key);
  const act = e.key === ' ' || e.key === 'Enter';
  if (!nav && !act) return;
  const active = document.activeElement;
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
  const focusable = Array.from(
    lobbyScreen.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
  ).filter(b => b.offsetParent !== null);
  if (!focusable.length) return;
  if (act) {
    // If no lobby button is focused yet, focus the first one and let the next press click it
    if (!focusable.includes(active as HTMLButtonElement)) {
      e.preventDefault();
      focusable[0].focus();
    }
    // else: browser natively clicks the focused button on Space/Enter — let it propagate
    return;
  }
  e.preventDefault();
  const idx = focusable.indexOf(active as HTMLButtonElement);
  const next = (e.key === 'ArrowRight' || e.key === 'ArrowDown')
    ? (idx < focusable.length - 1 ? idx + 1 : 0)
    : (idx > 0 ? idx - 1 : focusable.length - 1);
  focusable[next]?.focus();
});

// ─── Post-game overlay buttons ────────────────────────────────────────────────

document.getElementById('lbTapHint')!.addEventListener('click', dismissLeaderboard);
document.getElementById('pgMainMenu')!.addEventListener('click', () => {
  hidePostgameOverlay(); showMenu();
});
document.getElementById('pgLobby')!.addEventListener('click', () => {
  hidePostgameOverlay(); showMenu(); openLobbyScreen();
});
document.getElementById('pgPlayAgain')!.addEventListener('click', () => {
  hidePostgameOverlay();
  if (lastGameWasCoop && lastGameWasOnline) {
    openLobbyScreen();
  } else {
    isCoop = lastGameWasCoop;
    startLevel(1, STARTING_MONEY);
    if (gs) render(gs); flushFrame();
  }
});

// ─── Menu buttons ─────────────────────────────────────────────────────────────

document.getElementById('tutorialBtn')!.addEventListener('click', () => {
  isCoop = false; isTutorial = true; tutorialStep = 0; tutorialHintTimer = 0;
  tutorialPlayerMoved = false; tutorialBaseCompleted = 0; tutorialModalActive = false;
  playPlaylist(TUTORIAL_TRACKS);
  startLevel(1, STARTING_MONEY);
  if (gs) { gs.tutorialOrderQueue = []; gs.levelTimer = 9999999; TUTORIAL_STEPS[0]?.onEnter?.(gs); }
  // Pre-render one frame so the canvas isn't black on first-ever load when a modal appears
  if (gs) render(gs);
  // Full input flush — clear all flags including any held by the click/touch that launched this
  flushFrame();
});
document.getElementById('startBtn')!.addEventListener('click', () => {
  isCoop = false; isTutorial = false; isProMode = false; startLevel(1, STARTING_MONEY);
  if (gs) render(gs); flushFrame();
});
document.getElementById('lobbyBtn')!.addEventListener('click', openLobbyScreen);

function toggleFullscreen(): void {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(()=>{});
  else document.exitFullscreen().catch(()=>{});
}

window.addEventListener('keydown', e => {
  if (!e.repeat) _lastInputTime = Date.now();
  if (e.repeat) return;
  { const s = document.getElementById('splashScreen'); if (s && s.style.display !== 'none') { s.style.display = 'none'; showMenu(); return; } }
  if (e.code === 'KeyF') toggleFullscreen();
  if (e.code === 'KeyP' && screen === 'game' && gs?.phase === 'playing') {
    isPaused = !isPaused;
    if (isPaused) { pauseMenuIdx = 0; pauseSubScreen = null; } else pauseSubScreen = null;
  }
  if (menu.style.display === 'none' || gs !== null) return;
  if (e.code === 'ArrowLeft'  || e.code === 'ArrowUp')   { e.preventDefault(); focusMenuBtn(menuFocusIdx-1); }
  if (e.code === 'ArrowRight' || e.code === 'ArrowDown') { e.preventDefault(); focusMenuBtn(menuFocusIdx+1); }
  if (e.code === 'Space' || e.code === 'Enter')          { e.preventDefault(); menuBtns[menuFocusIdx].click(); }
});

// ── Splash screen ─────────────────────────────────────────────────────────────
const splashEl = document.getElementById('splashScreen')!;
menu.style.display = 'none';

function dismissSplash(): void {
  if (splashEl.style.display === 'none') return;
  splashEl.style.display = 'none';
  showMenu(); // showMenu() handles fullscreen + landscape
}

splashEl.addEventListener('click', dismissSplash);
// Use touchend + preventDefault to avoid tap-through onto menu buttons below
splashEl.addEventListener('touchend', (e) => { e.preventDefault(); dismissSplash(); });

playMusic('/audio/Main%20Theme.mp3');

window.addEventListener('beforeunload', () => {
  if (user) clearPresence(user.uid);
});
